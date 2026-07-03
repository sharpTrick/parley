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
 * `'parley_' || md5(topic)` — fixed-length, so it dodges both PostgreSQL's 63-byte identifier
 * truncation and channel-name injection from arbitrary topic strings. The payload (the new seq)
 * is a HINT only: NOTIFY payloads are size-limited and delivery is best-effort across
 * reconnects, so subscribers always re-query from their last-seen cursor instead of trusting
 * the payload (DESIGN §6).
 */

/**
 * Table names are interpolated into DDL/SQL text (they can't be bind parameters), so refuse
 * anything outside plain identifier characters — no quoting games, no injection surface.
 */
export function assertTableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `invalid table_name ${JSON.stringify(name)} — use only [A-Za-z0-9_], not starting with a digit`,
    );
  }
  return name;
}

/**
 * Idempotent DDL: the message table, the sender registry, and the NOTIFY trigger. Run inside a
 * transaction under an advisory lock (index.ts `connect`) so concurrent bridge processes
 * bootstrapping the same table don't race the CREATEs.
 */
export function buildSchema(table: string): string {
  const t = assertTableName(table);
  return `
CREATE TABLE IF NOT EXISTS ${t} (
  seq         BIGSERIAL PRIMARY KEY,
  topic       TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,           -- ISO 8601, informational only
  in_reply_to TEXT                     -- backendMsgId this threads under, or NULL
);
CREATE INDEX IF NOT EXISTS ${t}_topic_seq ON ${t} (topic, seq);
CREATE TABLE IF NOT EXISTS ${t}_senders (
  handle      TEXT PRIMARY KEY,
  backend_ref TEXT NOT NULL
);
CREATE OR REPLACE FUNCTION ${t}_notify() RETURNS trigger AS $PARLEY$
BEGIN
  PERFORM pg_notify('parley_' || md5(NEW.topic), NEW.seq::text);
  RETURN NULL;
END;
$PARLEY$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ${t}_notify_trg ON ${t};
CREATE TRIGGER ${t}_notify_trg AFTER INSERT ON ${t}
FOR EACH ROW EXECUTE FUNCTION ${t}_notify();
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
