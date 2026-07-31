import { createHash } from 'node:crypto';
import { badConfig } from './errors.js';

/** PostgreSQL truncates identifiers past this many BYTES, silently merging two derived names. */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * Every suffix the schema appends to `table_name`. The accepted-name budget is derived from the
 * longest entry, so adding a suffix here narrows the budget instead of silently truncating.
 */
const DERIVED_SUFFIXES = [
  '',
  '_topic_seq',
  '_created_at',
  '_senders',
  '_notify',
  '_notify_trg',
] as const;

const LONGEST_SUFFIX_BYTES = Math.max(
  ...DERIVED_SUFFIXES.map((s) => Buffer.byteLength(s, 'utf8')),
);

/** The longest `table_name` whose every derived relation still fits in 63 bytes. */
export const MAX_TABLE_NAME_BYTES = MAX_IDENTIFIER_BYTES - LONGEST_SUFFIX_BYTES;

/**
 * Validate and canonicalise `table_name`. Table names are interpolated into DDL/SQL text (they
 * can't be bind parameters), so refuse anything outside plain identifier characters and anything
 * long enough that a derived name would truncate into another one. The result is lower-cased and
 * every interpolation quotes it ({@link quotedNames}), which is what lets an accepted name that
 * happens to be a reserved word (`user`, `order`, …) work instead of failing as a raw parse error;
 * lower-casing first keeps the quoted relation byte-identical to the one an unquoted spelling of
 * the same name would have created.
 */
export function assertTableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw badConfig(
      'table_name',
      `invalid table_name ${JSON.stringify(name)} — use only [A-Za-z0-9_], not starting with a digit`,
    );
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_TABLE_NAME_BYTES) {
    throw badConfig(
      'table_name',
      `invalid table_name ${JSON.stringify(name)} — at most ${MAX_TABLE_NAME_BYTES} bytes, so the ` +
        `derived relations (${DERIVED_SUFFIXES.filter((s) => s !== '')
          .map((s) => `<table_name>${s}`)
          .join(', ')}) stay under PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit`,
    );
  }
  return name.toLowerCase();
}

/** Every relation name the schema derives from one validated `table_name`. */
export interface SchemaNames {
  messages: string;
  topicSeqIndex: string;
  createdAtIndex: string;
  senders: string;
  notifyFn: string;
  notifyTrigger: string;
}

export function schemaNames(table: string): SchemaNames {
  const t = assertTableName(table);
  return {
    messages: t,
    topicSeqIndex: `${t}_topic_seq`,
    createdAtIndex: `${t}_created_at`,
    senders: `${t}_senders`,
    notifyFn: `${t}_notify`,
    notifyTrigger: `${t}_notify_trg`,
  };
}

/**
 * The same relation names, double-quoted for interpolation into SQL. Everything this package
 * interpolates goes through here — a bare `${table}` would reintroduce the reserved-word parse
 * error quoting exists to remove.
 */
export function quotedNames(table: string): SchemaNames {
  const n = schemaNames(table);
  return Object.fromEntries(
    Object.entries(n).map(([k, v]) => [k, `"${v}"`]),
  ) as unknown as SchemaNames;
}

/**
 * NOTIFY channel for a topic. Must byte-match the trigger's server-side digest below; keep both
 * sides hashing explicit UTF-8 bytes, or a non-UTF8 `server_encoding` makes the trigger ring a
 * channel no subscriber ever LISTENs and the whole live path dies without an error.
 */
export function channelFor(topic: string): string {
  return `parley_${createHash('md5').update(topic, 'utf8').digest('hex')}`;
}

/**
 * Idempotent DDL: the message table, the sender registry, and the NOTIFY trigger. Run inside a
 * transaction under an advisory lock (index.ts `connect`) so concurrent bridge processes
 * bootstrapping the same table don't race the CREATEs.
 *
 * `seq BIGSERIAL PRIMARY KEY` is both the dedup key (`backendMsgId`) and the per-topic order key
 * (`cursor`) — a subsequence of a globally increasing sequence is itself increasing, so one column
 * satisfies both roles and neither ever uses the timestamp (DESIGN §5/§6).
 *
 * The indexes, the trigger and the `created_at` column are touched only when they are missing — or,
 * for the superseded `_ts` index, present — so that an ordinary process start on an
 * already-bootstrapped table takes no table-level lock and cannot stall every other bridge
 * process's `post()`: `CREATE INDEX` holds SHARE, `CREATE TRIGGER` SHARE ROW EXCLUSIVE, and
 * `ALTER TABLE`/`DROP INDEX` ACCESS EXCLUSIVE — all conflicting
 * with the ROW EXCLUSIVE an INSERT holds — and the `IF NOT EXISTS` spelling still takes the lock. Keep
 * every behavioural change to the doorbell in the trigger FUNCTION (replaced unconditionally), so
 * that skipping the re-create cannot ship a stale one.
 */
export function buildSchema(table: string): string {
  const n = quotedNames(table);
  const raw = schemaNames(table);
  const legacyTsIndex = `"${raw.messages}_ts"`;
  return `
CREATE TABLE IF NOT EXISTS ${n.messages} (
  seq         BIGSERIAL PRIMARY KEY,
  topic       TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,           -- ISO 8601 from the poster's clock, informational only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server-stamped; retention decides on this
  in_reply_to TEXT                     -- backendMsgId this threads under, or NULL
);
CREATE TABLE IF NOT EXISTS ${n.senders} (
  handle      TEXT PRIMARY KEY,
  backend_ref TEXT NOT NULL
);
CREATE OR REPLACE FUNCTION ${n.notifyFn}() RETURNS trigger AS $PARLEY$
BEGIN
  PERFORM pg_notify('parley_' || md5(convert_to(NEW.topic, 'UTF8')), NEW.seq::text);
  RETURN NULL;
END;
$PARLEY$ LANGUAGE plpgsql;
DO $PARLEY_BOOTSTRAP$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '${n.messages}'::regclass AND attname = 'created_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE ${n.messages} ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
  IF to_regclass('${n.topicSeqIndex}') IS NULL THEN
    CREATE INDEX ${n.topicSeqIndex} ON ${n.messages} (topic, seq);
  END IF;
  IF to_regclass('${n.createdAtIndex}') IS NULL THEN
    CREATE INDEX ${n.createdAtIndex} ON ${n.messages} (created_at);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE oid = to_regclass('${legacyTsIndex}') AND relkind = 'i'
  ) THEN
    DROP INDEX ${legacyTsIndex};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = '${n.messages}'::regclass AND tgname = '${raw.notifyTrigger}' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ${n.notifyTrigger} AFTER INSERT ON ${n.messages}
    FOR EACH ROW EXECUTE FUNCTION ${n.notifyFn}();
  END IF;
END
$PARLEY_BOOTSTRAP$;
`;
}

/** A row as fetched. node-postgres returns BIGINT as a string; we also cast `seq::text`. */
export interface MessageRow {
  seq: string;
  topic: string;
  sender: string;
  content: string;
  ts: string;
  in_reply_to: string | null;
}
