import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a parked long-poll must be woken by whatever actually observes ITS message, and its
 * reconciling re-query must be ordered strictly AFTER that wake source is positioned. Nothing may
 * let a `fetchRecent({ blockMs })` delegate its wake to a loop that will never deliver the topic it
 * waits on, nor race its own positioning sync — in production `catchup.block_max_ms` defaults to
 * 60s, so either mistake turns a landed message into a minute of silence.
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

const SUBSCRIBE_KINDS = [
  'no subscribe',
  'subscribed to the blocked topic',
  'subscribed to another topic',
] as const;

/** WHICH participant's `timeout=0` positioning sync is stalled while the message lands. */
const STALLS = ['nobody', 'the subscribe loop', 'the blocking fetch', 'both'] as const;

describe('blocking fetchRecent wakes promptly whatever else is subscribed', () => {
  for (const shared of [true, false]) {
    for (const kind of SUBSCRIBE_KINDS) {
      for (const stall of STALLS) {
        const subscribed = kind !== 'no subscribe';
        const stallsSubscribe = stall === 'the subscribe loop' || stall === 'both';
        const stallsBlocking = stall === 'the blocking fetch' || stall === 'both';
        if (!subscribed && stallsSubscribe) continue;

        it(`${shared ? 'shared_room' : 'per-topic'} / ${kind} / positioning stalled: ${stall}`, async () => {
          const p = await connectFake({ shared });
          const blocked = asTopic('blocked-topic');
          const other = asTopic('other-topic');
          await p.post(blocked, WRITER, 'old');
          const tail = (await p.fetchRecent({ topic: blocked, limit: 10 })).nextCursor;

          // The subscribe loop positions first (it is started first), so the blocking fetch's own
          // dedicated positioning sync — when it opens one — is the ordinal right after it.
          const subOrdinal = 1;
          const blockOrdinal = subscribed ? 2 : 1;
          const targets = [
            ...(stallsSubscribe ? [subOrdinal] : []),
            ...(stallsBlocking ? [blockOrdinal] : []),
          ];
          fake.stallPositioning = (n) => targets.includes(n);
          fake.stallPositioningMs = 600;

          // A blocking fetch opens its OWN sync unless a subscribe loop on its exact (room, topic)
          // has already positioned — a stalled subscribe loop has not.
          const hooksLiveLoop = kind === 'subscribed to the blocked topic' && !stallsSubscribe;
          const expectStalled = targets.filter((n) => n !== blockOrdinal || !hooksLiveLoop);

          const subTopic = kind === 'subscribed to another topic' ? other : blocked;
          let subscribing: Promise<void> | undefined;
          if (subscribed) {
            subscribing = p.subscribe(subTopic, () => undefined);
            if (!stallsSubscribe) await subscribing;
          }

          const started = Date.now();
          const pending = p.fetchRecent({ topic: blocked, since: tail, blockMs: BLOCK_MS });
          setTimeout(() => void p.post(blocked, WRITER, 'fresh'), 150);

          const woke = await pending;
          const elapsed = Date.now() - started;
          await subscribing;

          expect(woke.messages.map((m) => m.content)).toContain('fresh');
          expect(elapsed).toBeLessThan(PROMPT_MS);
          // A row that stalled nobody fails here instead of quietly grading a different participant.
          expect(fake.stalledPositioning).toEqual(expectStalled);
          await p.disconnect();
        });
      }
    }
  }
});

/**
 * CLASS: every path that hands a message to the subscribe handler must also wake the waiters parked
 * on that room. A delivery path that forgets leaves a parked `fetchRecent` asleep for its whole
 * budget even though the live loop already saw the message.
 */
const DELIVERY_PATHS = {
  'a normal incremental sync': { syncCap: 100, foreignAfter: 0 },
  'a `limited` burst recovered via prev_batch': { syncCap: 2, foreignAfter: 0 },
  'a `limited` burst whose belonging event is in the truncated tail': { syncCap: 2, foreignAfter: 2 },
} as const;

describe('a live subscribe delivery wakes the waiter parked on its room', () => {
  for (const [name, shape] of Object.entries(DELIVERY_PATHS)) {
    it(`${name}: the parked fetchRecent returns as promptly as the handler saw it`, async () => {
      const p = await connectFake({ shared: true });
      const blocked = asTopic('topic-A');
      await p.post(blocked, WRITER, 'old');
      const tail = (await p.fetchRecent({ topic: blocked, limit: 10 })).nextCursor;

      const delivered: number[] = [];
      await p.subscribe(blocked, () => delivered.push(Date.now()));
      fake.syncCap = shape.syncCap;

      const started = Date.now();
      const pending = p.fetchRecent({ topic: blocked, since: tail, blockMs: BLOCK_MS });
      setTimeout(() => {
        fake.addMessage(String(blocked), 'fresh');
        for (let i = 0; i < shape.foreignAfter; i++) fake.addMessage('other-topic', `f${i}`);
      }, 150);

      const woke = await pending;
      const elapsed = Date.now() - started;

      expect(woke.messages.map((m) => m.content)).toContain('fresh');
      expect(delivered).toHaveLength(1);
      expect(elapsed).toBeLessThan(PROMPT_MS);
      await p.disconnect();
    });
  }
});
