import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a parked long-poll must be woken by whatever actually observes ITS message, or drive its
 * own observer. Nothing may let a `fetchRecent({ blockMs })` delegate its wake to a live loop that
 * will never deliver the topic it is waiting on — in production `catchup.block_max_ms` defaults to
 * 60s, so a mis-scoped wake source turns a landed message into a minute of silence.
 *
 * The fake collapses every topic onto one room, so each cell here is also the shared-room case:
 * the blocked topic and the subscribed topic sit in the SAME room whenever they differ.
 */

const BLOCK_MS = 3000;
/** A wake that arrives on the real wake source lands in tens of ms; the bug spends the whole budget. */
const PROMPT_MS = 1500;
const WRITER = asHandle('writer');

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SUBSCRIBE_KINDS = ['no subscribe', 'subscribed to the blocked topic', 'subscribed to another topic'] as const;
const TIMINGS = [
  'before the blocking fetch',
  'concurrently with the blocking fetch',
  'concurrently, while its own positioning sync is still in flight',
] as const;

describe('blocking fetchRecent wakes promptly whatever else is subscribed', () => {
  for (const shared of [true, false]) {
    for (const kind of SUBSCRIBE_KINDS) {
      for (const timing of TIMINGS) {
        if (kind === 'no subscribe' && timing !== TIMINGS[0]) continue;

        it(`${shared ? 'shared_room' : 'per-topic'} / ${kind} / ${timing}`, async () => {
          const p = await connectFake({ shared });
          const blocked = asTopic('blocked-topic');
          const other = asTopic('other-topic');
          await p.post(blocked, WRITER, 'old');
          const tail = (await p.fetchRecent({ topic: blocked, limit: 10 })).nextCursor;

          const subTopic = kind === 'subscribed to another topic' ? other : blocked;
          let subscribing: Promise<void> | undefined;
          if (kind !== 'no subscribe') {
            if (timing === TIMINGS[2]) {
              // Stall ONLY the subscribe loop's positioning sync (it is the first one issued), so
              // the blocking fetch has to decide on a wake source while that loop is still blind.
              fake.positioningDelays = 1;
              fake.positioningDelayMs = 600;
            }
            subscribing = p.subscribe(subTopic, () => undefined);
            if (timing === TIMINGS[0]) await subscribing;
          }

          const started = Date.now();
          const pending = p.fetchRecent({ topic: blocked, since: tail, blockMs: BLOCK_MS });
          setTimeout(() => void p.post(blocked, WRITER, 'fresh'), 150);

          const woke = await pending;
          const elapsed = Date.now() - started;
          await subscribing;

          expect(woke.messages.map((m) => m.content)).toContain('fresh');
          expect(elapsed).toBeLessThan(PROMPT_MS);
          await p.disconnect();
        });
      }
    }
  }
});
