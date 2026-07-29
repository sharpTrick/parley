/**
 * Two CLASSES that live on the native long-poll path and that the shared conformance blockMs case
 * cannot reach:
 *
 * (1) LOST WAKEUP. `fetchRecent({blockMs})` closes the gap between its first (empty) query and the
 *     live socket by re-querying — and arms its waiter BEFORE that re-query, so a push landing
 *     while the re-query is in flight is caught rather than dropped on the floor. That ordering is
 *     invisible to any test that posts before the call or after it is already parked, so the table
 *     below injects the message at EVERY stage of the pipeline, including strictly inside the
 *     re-query's in-flight window, and requires each row to wake in far less than `blockMs`. An
 *     assertion on the message alone is not enough: waking at the timeout also returns it, so the
 *     elapsed bound is what separates a native wake from a budget burn.
 *
 * (2) HANDSHAKE STORM. Core re-drives `fetchRecent` every `block_poll_interval_ms` for the whole
 *     `block_max_ms` budget. Per-iteration network work must therefore be bounded by WALL CLOCK,
 *     not by iteration count — otherwise one unavailable Socket Mode turns a single `fetch_recent`
 *     into hundreds of `apps.connections.open` calls against Slack's tightest rate limit.
 */
import { asCursor, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

/** Land a message in history AND on the live socket, exactly as a real workspace write would. */
function deliver(fake: FakeSlack, topic: Topic, text: string): void {
  const [created] = fake.seed(topic, [{ text }]);
  fake.pushEvent(topic, { ts: created!.ts, text, user: 'U0PARLEY' });
}

/** Where in the blocking pipeline the message lands. `arm` schedules the injection. */
const STAGES: Array<{ name: string; arm: (fake: FakeSlack, topic: Topic) => void }> = [
  {
    name: 'before the first query',
    arm: (fake, topic) => deliver(fake, topic, 'live'),
  },
  {
    name: 'between the first query and the socket handshake',
    arm: (fake, topic) =>
      fake.onHit('conversations.history', (hit) => {
        if (hit === 1) deliver(fake, topic, 'live');
      }),
  },
  {
    name: 'during the apps.connections.open handshake',
    arm: (fake, topic) =>
      fake.onHit('apps.connections.open', (hit) => {
        if (hit === 1) deliver(fake, topic, 'live');
      }),
  },
  {
    name: 'during the gap-closing re-query',
    arm: (fake, topic) =>
      fake.onHit('conversations.history', (hit) => {
        if (hit === 2) deliver(fake, topic, 'live');
      }),
  },
  {
    name: 'after the waiter is parked',
    arm: (fake, topic) => {
      setTimeout(() => deliver(fake, topic, 'live'), 150);
    },
  },
];

describe('slack blocking fetch: the lost-wakeup window', () => {
  for (const stage of STAGES) {
    for (const blockMs of [800, 3000]) {
      it(`wakes natively when the message lands ${stage.name} (blockMs=${blockMs})`, async () => {
        const fake = await FakeSlack.start();
        const plugin = new SlackPlugin();
        await plugin.connect({
          api_url: fake.apiUrl,
          bot_token: 'xoxb-test',
          app_token: 'xapp-test',
        });
        try {
          const topic = asTopic('C0WAKE');
          fake.createChannel(topic);
          stage.arm(fake, topic);

          const t0 = Date.now();
          const result = await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs });
          const elapsed = Date.now() - t0;

          expect(result.messages.map((m) => m.content)).toEqual(['live']);
          // A waiter armed after the re-query misses the mid-query push and burns the full budget.
          expect(elapsed).toBeLessThan(blockMs / 2);
        } finally {
          await plugin.disconnect();
          await fake.close();
        }
      });
    }
  }
});

describe('slack blocking fetch: handshake storm bound', () => {
  for (const [blockMs, pollIntervalMs] of [
    [3000, 250],
    [3000, 50],
  ] as const) {
    it(`an unavailable Socket Mode costs O(wall clock) dials, not O(iterations) (blockMs=${blockMs}, poll=${pollIntervalMs})`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      await plugin.connect({
        api_url: fake.apiUrl,
        bot_token: 'xoxb-test',
        app_token: 'xapp-test',
      });
      try {
        const topic = asTopic('C0STORM');
        fake.createChannel(topic);
        fake.failMethod('apps.connections.open', 'internal_error');

        await fetchRecentBlocking(
          plugin,
          { topic, since: asCursor('0') },
          { blockMs, pollIntervalMs },
        );

        // Unbounded re-dialing is blockMs/pollIntervalMs attempts (12 and 60 here).
        expect(fake.hits('apps.connections.open')).toBeLessThanOrEqual(
          Math.ceil(blockMs / 1000) + 1,
        );
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }

  it('a handshake that recovers mid-budget still wakes natively', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const topic = asTopic('C0RECOVER');
      fake.createChannel(topic);
      fake.failMethod('apps.connections.open', 'internal_error', 1);
      setTimeout(() => deliver(fake, topic, 'live'), 900);

      const t0 = Date.now();
      const result = await fetchRecentBlocking(
        plugin,
        { topic, since: asCursor('0') },
        { blockMs: 5000, pollIntervalMs: 250 },
      );

      expect(result.messages.map((m) => m.content)).toEqual(['live']);
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});
