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

export interface MessageRow {
  id: number;
  topic: string;
  sender: string;
  content: string;
  ts: string;
}

/**
 * The read paths' select list. Keep it to columns a `Message` carries, so that no page and no poll
 * tick pays to fetch a value `rowToMessage` cannot pass on — `in_reply_to` is written but has no
 * seam field, so it is deliberately absent.
 */
export const MESSAGE_COLUMNS = ['id', 'topic', 'sender', 'content', 'ts'] as const satisfies
  readonly (keyof MessageRow)[];

/**
 * Every long-lived statement `connect()` prepares. Keep the plugin preparing from THIS map, so
 * that a query-plan or select-list assertion grades the SQL that actually runs rather than a copy
 * of it restated in a test.
 */
export const SQL = {
  insert: 'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?, ?, ?, ?, ?)',
  selectAfter: `SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE topic = ? AND id > ? ORDER BY id ASC LIMIT ?`,
  selectRecent: `SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE topic = ? ORDER BY id DESC LIMIT ?`,
  maxId: 'SELECT COALESCE(MAX(id), 0) AS maxId FROM messages WHERE topic = ?',
  prune: 'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE ts < ? LIMIT ?)',
  seq: "SELECT seq FROM sqlite_sequence WHERE name = 'messages'",
} as const;
