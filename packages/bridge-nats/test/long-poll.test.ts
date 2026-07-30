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

// Class: a caller-supplied deadline computed INSIDE a closure a retry re-runs is minted afresh by
// that retry, so the caller is served the budget once per attempt. The read path re-enters itself
// wherever `withStream` can see a stream that vanished out-of-band, and every such point is late
// enough in a long-poll to double it — the budget above is only a bound while nothing retries.
describe('nats long-poll keeps its budget across a stream that vanishes mid-poll', () => {
  const vanishPoints = ['consumers.add', 'consumers.get', 'fetch'] as const;
  const budgets = [500, 1000, 2000];

  for (const point of vanishPoints) {
    for (const budget of budgets) {
      it(`a stream removed at ${point}, ${budget}ms budget: the retry inherits the caller's deadline`, async () => {
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
