import { createHash } from 'node:crypto';

/**
 * The message store (DESIGN §6). `seq BIGSERIAL PRIMARY KEY` is the free, monotonic sequence
 * that serves as BOTH the dedup key (`backendMsgId`) and the per-topic order key (`cursor`) —
 * a subsequence of a globally increasing sequence is itself increasing, so one column satisfies
 * both roles. Ordering and dedup NEVER use the timestamp (§5/§6).
 *
 * One caveat SQLite's rowid doesn't have: BIGSERIAL values are assigned at INSERT time, not
 * COMMIT time, so under concurrent writers rows can become VISIBLE out of seq order — a reader
 * could observe seq 42, advance its cursor past the still-uncommitted 41, and skip 41 forever.
 * `post()` closes that hole by serializing same-topic writes with a transaction-scoped advisory
 * lock (see index.ts) so commit order == seq order per topic.
 *
 * The AFTER INSERT trigger turns every write into a `pg_notify` on channel
 * `'parley_' || md5(convert_to(topic, 'UTF8'))` — fixed-length, so it dodges both PostgreSQL's
 * 63-byte identifier truncation and channel-name injection from arbitrary topic strings. The
 * payload (the new seq) is a HINT only: NOTIFY payloads are size-limited and delivery is
 * best-effort across reconnects, so subscribers always re-query from their last-seen cursor
 * instead of trusting the payload (DESIGN §6).
 */

/** PostgreSQL truncates identifiers past this many BYTES, silently merging two derived names. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Every suffix the schema appends to `table_name`. The accepted-name budget is derived from the
 * longest entry, so adding a suffix here narrows the budget instead of silently truncating.
 */
const DERIVED_SUFFIXES = [
  '',
  '_topic_seq',
  '_ts',
  '_senders',
  '_notify',
  '_notify_trg',
] as const;

const LONGEST_SUFFIX_BYTES = Math.max(
  ...DERIVED_SUFFIXES.map((s) => Buffer.byteLength(s, 'utf8')),
);

/** The longest `table_name` whose every derived relation still fits in 63 bytes. */
export const MAX_TABLE_NAME_BYTES = MAX_IDENTIFIER_BYTES - LONGEST_SUFFIX_BYTES;

export function badConfig(key: string, reason: string): Error {
  return new Error(`parley-postgres: invalid backend_config.${key} — ${reason}`);
}

export function unknownConfigKey(key: string, allowed: readonly string[]): Error {
  return new Error(
    `parley-postgres: unknown backend_config key '${key}' — expected one of ${allowed.join(', ')}`,
  );
}

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
  tsIndex: string;
  senders: string;
  notifyFn: string;
  notifyTrigger: string;
}

export function schemaNames(table: string): SchemaNames {
  const t = assertTableName(table);
  return {
    messages: t,
    topicSeqIndex: `${t}_topic_seq`,
    tsIndex: `${t}_ts`,
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
 * The indexes and the trigger are created only when missing, so that an ordinary process start on an
 * already-bootstrapped table takes no table-level lock and cannot stall every other bridge process's
 * `post()`: `CREATE INDEX` holds SHARE and `CREATE TRIGGER` SHARE ROW EXCLUSIVE, and both conflict
 * with the ROW EXCLUSIVE an INSERT holds — the `IF NOT EXISTS` spelling still takes the lock. Keep
 * every behavioural change to the doorbell in the trigger FUNCTION (replaced unconditionally), so
 * that skipping the re-create cannot ship a stale one.
 */
export function buildSchema(table: string): string {
  const n = quotedNames(table);
  const raw = schemaNames(table);
  return `
CREATE TABLE IF NOT EXISTS ${n.messages} (
  seq         BIGSERIAL PRIMARY KEY,
  topic       TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,           -- ISO 8601, informational only
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
  IF to_regclass('${n.topicSeqIndex}') IS NULL THEN
    CREATE INDEX ${n.topicSeqIndex} ON ${n.messages} (topic, seq);
  END IF;
  IF to_regclass('${n.tsIndex}') IS NULL THEN
    CREATE INDEX ${n.tsIndex} ON ${n.messages} (ts);
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
