import type { Topic } from '@sharptrick/parley-core';
import type { RedisClient } from './client.js';

/** A Redis Stream entry id — `<ms>` or `<ms>-<seq>`. Cursors and backendMsgIds are exactly this. */
const CURSOR_PATTERN = /^\d+(-\d+)?$/;
/** Both components of a stream entry id are unsigned 64-bit; a larger one is not an id at all. */
const MAX_ID_COMPONENT = 2n ** 64n - 1n;
/** The largest entry id a stream can ever hold — and the one cursor `(<id>` cannot start after. */
export const MAX_ENTRY_ID = `${MAX_ID_COMPONENT}-${MAX_ID_COMPONENT}`;

/**
 * Validate the opaque cursor at the seam. Anything that is not an id this backend mints — another
 * backend's cursor, `''`/`'$'`, a truncated id via mis-namespaced read-state, an all-digit string
 * too large for the uint64 each component is — would otherwise reach XRANGE as a raw `ERR Invalid
 * stream ID` naming neither backend nor topic.
 */
export function assertMintedCursor(topic: Topic, since: string): void {
  const wellFormed =
    CURSOR_PATTERN.test(since) && since.split('-').every((part) => BigInt(part) <= MAX_ID_COMPONENT);
  if (!wellFormed) {
    throw new Error(
      `parley-redis: malformed cursor '${since}' for topic ${topic} — ` +
        `expected a Redis Stream entry id ('<ms>' or '<ms>-<seq>') minted by this backend`,
    );
  }
}

/** Order two stream ids; a bare `<ms>` cursor has an implicit sequence of 0, as Redis reads it. */
export function compareIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  if (BigInt(aMs) !== BigInt(bMs)) return BigInt(aMs) < BigInt(bMs) ? -1 : 1;
  if (BigInt(aSeq) === BigInt(bSeq)) return 0;
  return BigInt(aSeq) < BigInt(bSeq) ? -1 : 1;
}

/**
 * The last id a stream generated, or `'0'` when the stream does not exist.
 *
 * Keep the `EXISTS` probes, so that "no history yet" is decided by server STATE and never by
 * matching `XINFO STREAM`'s `ERR no such key` wording: a proxy or release that words it differently
 * turns an empty stream into a hard failure, and any unrelated error carrying that phrase turns a
 * real fault into a from-the-beginning replay of the whole retained history as live push.
 */
export async function streamTail(client: RedisClient, key: string): Promise<string> {
  if ((await client.exists(key)) === 0) return '0';
  try {
    return (await client.xInfoStream(key)).lastGeneratedId;
  } catch (err) {
    if ((await client.exists(key)) === 0) return '0'; // deleted in the EXISTS → XINFO gap
    throw err;
  }
}
