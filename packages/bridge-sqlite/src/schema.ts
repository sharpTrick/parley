/**
 * The message store (DESIGN §6). `id INTEGER PRIMARY KEY AUTOINCREMENT` is the free,
 * monotonic sequence that serves as BOTH the dedup key (`backendMsgId`) and the per-topic
 * order key (`cursor`) — a subsequence of a globally increasing id is itself increasing, so
 * one rowid satisfies both roles. Ordering and dedup NEVER use the timestamp (§5/§6).
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
`;

/** A row as stored. */
export interface MessageRow {
  id: number;
  topic: string;
  sender: string;
  content: string;
  ts: string;
  in_reply_to: string | null;
}
