import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake } from './fake-jetstream.js';

// Class: a long-poll honours its budget from BOTH sides. The lower bound (it really waited) is
// what the shared conformance suite pins; nothing pinned the upper bound, so the deadline timer
// could be deleted outright and every suite stayed green while a caller's `block_ms: 300` was
// served by the driver's own 1000ms pull floor — a 3.3x overshoot, invisible in the result. The
// discriminating rows are the budgets BELOW that floor: any backend with a native long-poll
// (Redis XREAD BLOCK, Zulip /events, Telegram getUpdates) can silently round a short budget up.
const TOPIC = asTopic('budget');

// Far longer than any budget below, so the pull's own expiry can never be what ends the wait.
const PULL_EXPIRY_MS = 10_000;
const SLACK_MS = 500;

const budgets = [150, 300, 1000, 2000];

describe('nats long-poll honours its budget from both sides', () => {
  for (const budget of budgets) {
    it(`an empty ${budget}ms long-poll waits, and returns within its budget`, async () => {
      const fake = fakeJetStream({ records: [], expiryMs: PULL_EXPIRY_MS });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, TOPIC);

      const started = Date.now();
      const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: budget });
      const elapsed = Date.now() - started;

      expect(page.messages).toEqual([]);
      expect(page.nextCursor).toBe('0');
      expect(elapsed).toBeGreaterThanOrEqual(budget * 0.5);
      expect(elapsed).toBeLessThan(budget + SLACK_MS);
    }, 20_000);
  }
});

// Class: ONE budget spent across BOTH stages of a read. `fetchRecent` waits for an absent stream and
// then waits in the pull, and a deadline minted inside either stage hands the other a fresh one —
// which serves a caller's `block_ms` once per stage, invisibly, in the result. The rows above cannot
// see it: they spend the whole budget in the pull, with the stream present from the first call.
describe('nats long-poll spends ONE budget across the absent-stream wait and the pull', () => {
  const budgets = [500, 1000, 2000];
  const appearances = [0.5, 0.9];

  for (const budget of budgets) {
    for (const fraction of appearances) {
      it(`a stream created ${fraction * 100}% into a ${budget}ms budget still returns within it`, async () => {
        const fake = fakeJetStream({ records: [], expiryMs: PULL_EXPIRY_MS, streamAbsent: true });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);
        const appears = setTimeout(() => {
          fake.state.streamAbsent = false;
        }, Math.round(budget * fraction));

        try {
          const started = Date.now();
          const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: budget });
          const elapsed = Date.now() - started;

          expect(page.messages).toEqual([]);
          expect(fake.state.streamAbsent).toBe(false);
          expect(elapsed).toBeGreaterThanOrEqual(budget * 0.5);
          expect(elapsed).toBeLessThan(budget * 1.2);
        } finally {
          clearTimeout(appears);
          await plugin.disconnect();
        }
      }, 20_000);
    }
  }
});

// Class: a stream removed out-of-band DURING a long-poll is the absent topic again, and answering it
// must neither re-provision the stream nor spend a second budget doing so. The lower bound here comes
// from the injected removal time, not from the plugin's patience — the budget's floor is graded by
// the rows above.
describe('nats long-poll answers a stream that vanishes mid-poll without overrunning its budget', () => {
  const vanishPoints = ['consumers.add', 'consumers.get', 'fetch'] as const;
  const budgets = [500, 1000, 2000];

  for (const point of vanishPoints) {
    for (const budget of budgets) {
      it(`a stream removed at ${point}, ${budget}ms budget: returns the absent-topic page in budget`, async () => {
        const fake = fakeJetStream({
          records: [],
          expiryMs: PULL_EXPIRY_MS,
          streamMissingOn: point,
          streamMissingAfterMs: Math.round(budget * 0.9),
        });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);

        const started = Date.now();
        const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: budget });
        const elapsed = Date.now() - started;

        expect(page.messages).toEqual([]);
        expect(page.nextCursor).toBe('0');
        expect(fake.state.streamMissingOn).toBeUndefined();
        expect(elapsed).toBeGreaterThanOrEqual(budget * 0.5);
        expect(elapsed).toBeLessThan(budget * 1.4);
      }, 20_000);
    }
  }
});
