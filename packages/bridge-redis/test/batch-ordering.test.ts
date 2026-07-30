import { asHandle, type Cursor, type Message, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  freshTopic as mintTopic,
  isRedisUp,
  REDIS_URL,
  withPlugin,
  withWriter,
} from './support.js';

// CLASS: a delivery path that can return N>1 messages is only ever graded on N==1. The seam
// guarantees ascending cursor order on BOTH of this plugin's batch-producing paths, but every case in
// the conformance suite and in failure-modes awaits each post in turn, so every XREAD batch holds
// exactly one entry and the ordering assertions are tautologies — reversing either batch mapping
// leaves the rest of the suite green. Bursts are the normal case under load.
//
// Keep the MULTI/EXEC write, so that the batch size is DETERMINISTIC: Redis serves blocked readers
// only once a whole transaction has executed, so a parked XREAD wakes with all N entries in one
// reply. Concurrent individual XADDs can wake the reader on the first one and silently degrade every
// row here back to the N==1 case the block exists to escape.

const redisUp = await isRedisUp(REDIS_URL);

const freshTopic = (): Topic => mintTopic('batch');

/** 2 is the smallest batch that can be mis-ordered; 25 exceeds every per-row limit used below. */
const BURSTS = [2, 5, 25];

const contents = (n: number): string[] => Array.from({ length: n }, (_v, i) => `m${i}`);

async function burst(key: string, want: string[]): Promise<void> {
  await withWriter(async (writer) => {
    const tx = writer.multi();
    for (const content of want) {
      tx.xAdd(key, '*', { sender: 'burst', content, ts: new Date().toISOString(), in_reply_to: '' });
    }
    await tx.exec();
  });
}

/** Order a stream id the way Redis does; a bare `<ms>` has an implicit sequence of 0. */
function idKey(id: string): [bigint, bigint] {
  const [ms = '0', seq = '0'] = id.split('-');
  return [BigInt(ms), BigInt(seq)];
}

function strictlyAscending(ids: string[]): boolean {
  for (let i = 1; i < ids.length; i++) {
    const [prevMs, prevSeq] = idKey(ids[i - 1] ?? '');
    const [ms, seq] = idKey(ids[i] ?? '');
    if (ms < prevMs || (ms === prevMs && seq <= prevSeq)) return false;
  }
  return true;
}

function expectOrderedAndUnique(messages: Message[]): void {
  const cursors = messages.map((m) => String(m.cursor));
  expect(strictlyAscending(cursors), `cursors are not ascending: ${cursors.join(', ')}`).toBe(true);
  const ids = messages.map((m) => String(m.backendMsgId));
  expect(new Set(ids).size, `a message arrived more than once: ${ids.join(', ')}`).toBe(ids.length);
}

describe.skipIf(!redisUp)('redis batch delivery — subscribe, on a burst wider than one entry', () => {
  it.each(BURSTS)('delivers a burst of %i once each, in ascending cursor order', async (n) =>
    withPlugin({ block_ms: 4000 }, async ({ plugin, prefix }) => {
      const t = freshTopic();
      const seen: Message[] = [];
      await plugin.subscribe(t, (m) => seen.push(m));
      // A delivered post proves the read loop is PARKED on a blocking XREAD, so the burst below
      // lands in one batch rather than being drained an entry at a time during startup.
      await plugin.post(t, asHandle('w'), 'armed');
      await expect.poll(() => seen.length, { timeout: 5000, interval: 25 }).toBe(1);

      const want = contents(n);
      await burst(`${prefix}${t}`, want);
      await expect.poll(() => seen.length, { timeout: 5000, interval: 25 }).toBe(n + 1);
      expect(seen.map((m) => m.content)).toEqual(['armed', ...want]);
      expectOrderedAndUnique(seen);

      // The loop must resume from the batch's HIGHEST id: resuming from its lowest re-reads the
      // whole batch on the next iteration, which is only visible after the batch itself was graded.
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.map((m) => m.content), 'the batch was re-delivered').toEqual(['armed', ...want]);
    }));
});

describe.skipIf(!redisUp)('redis batch delivery — a blocking fetchRecent woken by a burst', () => {
  it.each(BURSTS)('honours limit and order when %i+2 entries arrive at once', async (limit) =>
    withPlugin({}, async ({ plugin, prefix }) => {
      const t = freshTopic();
      await plugin.post(t, asHandle('w'), 'seed');
      const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
      const want = contents(limit + 2);

      const waiting = plugin.fetchRecent({ topic: t, since: tail, blockMs: 5000, limit });
      // The canonical XRANGE has certainly returned empty by now, so the burst is answered by the
      // blocking read rather than by the ordinary catch-up query.
      await new Promise((r) => setTimeout(r, 100));
      await burst(`${prefix}${t}`, want);
      const page = await waiting;

      expect(page.messages.map((m) => m.content)).toEqual(want.slice(0, limit));
      expectOrderedAndUnique(page.messages);
      expect(page.nextCursor).toBe(page.messages.at(-1)?.cursor);

      const rest = await plugin.fetchRecent({
        topic: t,
        since: page.nextCursor as Cursor,
        limit: 100,
      });
      expect(rest.messages.map((m) => m.content), 'the truncated remainder was skipped').toEqual(
        want.slice(limit),
      );
    }));
});
