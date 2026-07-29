/**
 * The message store (DESIGN §6). `id INTEGER PRIMARY KEY AUTOINCREMENT` is the free,
 * monotonic sequence that serves as BOTH the dedup key (`backendMsgId`) and the per-topic
 * order key (`cursor`, prefixed with `parley_meta.store_id`) — a subsequence of a globally
 * increasing id is itself increasing, so one rowid satisfies both roles. Ordering and dedup
 * NEVER use the timestamp (§5/§6); `idx_messages_ts` exists only so retention can prune by
 * window without scanning the whole table.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,           -- ISO 8601, informational only
  in_reply_to TEXT                     -- backendMsgId this threads under, or NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_topic_id ON messages(topic, id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE TABLE IF NOT EXISTS parley_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** `parley_meta` key holding this store's identity — the prefix every cursor carries. */
export const STORE_ID_KEY = 'store_id';

/** A row as stored. */
export interface MessageRow {
  id: number;
  topic: string;
  sender: string;
  content: string;
  ts: string;
  in_reply_to: string | null;
}
