import {
  asCursor,
  asTopic,
  buildMessage,
  type Cursor,
  type FetchRecentResult,
  type Message,
  type Topic,
} from '@sharptrick/parley-core';
import type { Pool } from 'pg';
import type { MessageRow, SchemaNames } from './schema.js';

const COLUMNS = 'seq::text AS seq, topic, sender, content, ts, in_reply_to';

// Keep every ORDER BY here table-qualified, so that it binds to the bigint column: a bare
// `ORDER BY seq` binds to the `seq::text AS seq` OUTPUT alias and sorts lexicographically
// ('9' > '10'), which is message loss and not a reordering.

/** The most recent `limit` messages for a topic, returned ascending by cursor. */
export async function newestMessages(
  pool: Pool,
  names: SchemaNames,
  topic: Topic,
  limit: number,
): Promise<MessageRow[]> {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM ${names.messages}
     WHERE topic = $1 ORDER BY ${names.messages}.seq DESC LIMIT $2`,
    [topic, limit],
  );
  return (res.rows as MessageRow[]).reverse();
}

/** The canonical exclusive `since` read: strictly after `since`, ascending by cursor. */
export async function messagesSince(
  pool: Pool,
  names: SchemaNames,
  topic: Topic,
  since: string,
  limit: number,
): Promise<MessageRow[]> {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM ${names.messages}
     WHERE topic = $1 AND seq > $2::bigint ORDER BY ${names.messages}.seq ASC LIMIT $3`,
    [topic, since, limit],
  );
  return res.rows as MessageRow[];
}

export function rowToMessage(row: MessageRow): Message {
  return buildMessage({
    topic: asTopic(row.topic),
    sender: row.sender,
    content: row.content,
    timestamp: row.ts,
    id: String(row.seq),
  });
}

/** Shape rows into a page; an empty page holds `nextCursor` at `since` (stable at timeout). */
export function pageResult(rows: MessageRow[], since?: Cursor): FetchRecentResult {
  const messages = rows.map(rowToMessage);
  const last = messages.at(-1);
  return { messages, nextCursor: last !== undefined ? last.cursor : (since ?? asCursor('0')) };
}
