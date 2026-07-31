import {
  type BackendPlugin,
  type Message,
  parseMentions,
  type Topic,
} from '@sharptrick/parley-core';
import { expect } from 'vitest';

export const DRAIN_PAGE = 500;

/**
 * Read every message in `topic` by PAGING to exhaustion. It must not read one oversized page: a
 * backend with a server-side page cap below the request would silently return a prefix, and the
 * assertions built on it would grade a partial view.
 *
 * The FIRST page has no `since`, which the suite itself pins as the NEWEST `limit` messages — so a
 * full first page means the oldest messages are outside the window and paging forward can never
 * reach them. Keep the guard, so that a caller raising a volume past {@link DRAIN_PAGE} gets an
 * error naming the helper instead of a passing assertion over a silently truncated suffix.
 */
export async function drainAll(plugin: BackendPlugin, topic: Topic): Promise<Message[]> {
  const out: Message[] = [];
  let since: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await plugin.fetchRecent({ topic, since: since as never, limit: DRAIN_PAGE });
    if (since === undefined && res.messages.length >= DRAIN_PAGE) {
      throw new Error(
        `drainAll(${topic}): the since-less first page returned ${res.messages.length} messages, ` +
          `filling the ${DRAIN_PAGE} limit — anything older is unreachable from here. Raise ` +
          `DRAIN_PAGE or lower the volume; do not grade a partial view.`,
      );
    }
    out.push(...res.messages);
    if (res.messages.length === 0 || res.nextCursor === since) return out;
    since = res.nextCursor;
  }
  throw new Error(`drainAll did not terminate for ${topic}`);
}

/**
 * Every field of the normalized Message (DESIGN §5) a plugin is responsible for populating.
 * Asserting only `content` lets a plugin return a constant `topic` — which collapses core's dedup
 * namespace across topics — or a constant `senderHandle`, and still pass in full.
 */
export function expectWellFormedMessage(
  m: Message,
  expected: { topic: Topic; content: string; sender?: string },
): void {
  expect(m.topic).toBe(expected.topic);
  expect(m.content).toBe(expected.content);
  expect(typeof m.backendMsgId).toBe('string');
  expect(m.backendMsgId.length).toBeGreaterThan(0);
  expect(typeof m.cursor).toBe('string');
  expect(m.cursor.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
  // `senderHandle` is asserted on every backend, not only the ones that round-trip `identity`:
  // whoever the sender turns out to be, core routes and displays it.
  expect(typeof m.senderHandle).toBe('string');
  expect(m.senderHandle.length).toBeGreaterThan(0);
  // `mentions` is what core's push loop filters on (transport/push-loop.ts) — a backend that
  // drops it delivers NOTHING once mention filtering is on. Compared against the content the
  // BACKEND returned, so a transport that rewrites mention syntax is still graded honestly.
  expect(m.mentions).toEqual(parseMentions(m.content));
  if (expected.sender !== undefined) expect(m.senderHandle).toBe(expected.sender);
}
