import { buildMessage, type Handle, type Message, type Topic } from '@sharptrick/parley-core';

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const encodeRecord = (sender: Handle, content: string, inReplyTo: string): string =>
  JSON.stringify({ sender, content, ts: new Date().toISOString(), in_reply_to: inReplyTo });

/**
 * Anything with publish rights on the subject can put arbitrary bytes in the stream, and a record
 * that throws here is unreadable FOREVER — it sits in the stream and kills every catch-up page
 * that covers it. So this is total: undecodable or wrongly-typed frames degrade to empty strings
 * rather than raising (CLAUDE.md "inbound is untrusted" — the wire format, not just the content).
 */
export function rowToMessage(topic: Topic, id: string, raw: string): Message {
  const fields = decodeFields(raw);
  return buildMessage({
    topic,
    sender: asString(fields.sender),
    content: asString(fields.content),
    timestamp: asString(fields.ts),
    id,
    cursor: id,
  });
}

function decodeFields(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
