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
 * (2) WAKE ELIGIBILITY. A parked long-poll must wake only on an event STRICTLY above its own floor,
 *     on its OWN channel. `since` is a caller argument, so two concurrent blocked fetches on one
 *     channel legitimately sit at different floors; a waiter woken below its floor re-queries, finds
 *     nothing, and returns an empty page at once — turning `block_ms` back into the busy-return loop
 *     it exists to remove. Timing is the only observable: every row here returns an empty page either
 *     way, so what separates them is whether the call held its budget.
 *
 * (3) POLL STORM. Core re-drives `fetchRecent` every `block_poll_interval_ms` for the whole
 *     `block_max_ms` budget. Per-iteration network work must therefore be bounded by WALL CLOCK, not
 *     by iteration count — for EVERY method the path touches, not just the one a past fix looked at:
 *     an unavailable Socket Mode must not turn a single `fetch_recent` into hundreds of
 *     `apps.connections.open` handshakes, nor into hundreds of `conversations.history` reads.
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

const BLOCK_MS = 1200;

/**
 * Where a live event sits relative to the parked waiter. `deliver` returns the text the fetch must
 * come back with, or `undefined` when the row must hold its whole budget and return nothing.
 */
const ELIGIBILITY: Array<{
  name: string;
  wakes: boolean;
  /** Land the event, given the channel the fetch is parked on and its exclusive floor. */
  land: (fake: FakeSlack, parked: Topic, floor: string) => void;
}> = [
  {
    name: 'an event strictly above the floor',
    wakes: true,
    land: (fake, parked) => deliver(fake, parked, 'live'),
  },
  {
    name: 'an event exactly at the floor',
    wakes: false,
    land: (fake, parked, floor) => fake.pushEvent(parked, { ts: floor, text: 'at', user: 'U0X' }),
  },
  {
    name: 'an event below the floor',
    wakes: false,
    land: (fake, parked, floor) =>
      fake.pushEvent(parked, {
        ts: `${Number(floor.split('.')[0]) - 60}.000001`,
        text: 'below',
        user: 'U0X',
      }),
  },
  {
    name: 'an above-floor event on a different channel',
    wakes: false,
    land: (fake) => deliver(fake, asTopic('C0OTHER'), 'elsewhere'),
  },
];

describe('slack blocking fetch: only an above-floor event on its own channel wakes a waiter', () => {
  for (const row of ELIGIBILITY) {
    it(`${row.wakes ? 'wakes on' : 'stays parked through'} ${row.name}`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
      try {
        const topic = asTopic('C0FLOOR');
        fake.createChannel(topic);
        fake.createChannel('C0OTHER');
        // The floor is a real `ts` above everything in history, so the first query is empty and the
        // call parks; nothing the rows land is fetchable below it either, so EVERY row's page is
        // empty and elapsed time is the only thing that separates a wake from a budget burn.
        const floor = fake.mintTs();
        setTimeout(() => row.land(fake, topic, floor), 150);

        const t0 = Date.now();
        const result = await plugin.fetchRecent({
          topic,
          since: asCursor(floor),
          blockMs: BLOCK_MS,
        });
        const elapsed = Date.now() - t0;

        if (row.wakes) {
          expect(result.messages.map((m) => m.content)).toEqual(['live']);
          expect(elapsed).toBeLessThan(BLOCK_MS / 2);
        } else {
          expect(result.messages).toEqual([]);
          expect(String(result.nextCursor)).toBe(floor);
          expect(elapsed).toBeGreaterThanOrEqual(BLOCK_MS * 0.8);
        }
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }

  it('two waiters at different floors on one channel: only the eligible one wakes', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const topic = asTopic('C0TWOFLOORS');
      fake.createChannel(topic);
      const lowFloor = fake.mintTs();
      const between = fake.mintTs();
      const highFloor = fake.mintTs();

      setTimeout(() => {
        fake.seedRaw(topic, [{ type: 'message', ts: between, text: 'mid', user: 'U0X' }]);
        fake.pushEvent(topic, { ts: between, text: 'mid', user: 'U0X' });
      }, 150);

      const t0 = Date.now();
      const [low, high] = await Promise.all([
        plugin.fetchRecent({ topic, since: asCursor(lowFloor), blockMs: BLOCK_MS }),
        plugin.fetchRecent({ topic, since: asCursor(highFloor), blockMs: BLOCK_MS }),
      ]);
      const elapsed = Date.now() - t0;

      expect(low.messages.map((m) => m.content)).toEqual(['mid']);
      // The high waiter shares the channel's waiter set, so a wake that ignores the per-waiter floor
      // returns it an empty page immediately instead of holding its budget.
      expect(high.messages).toEqual([]);
      expect(String(high.nextCursor)).toBe(highFloor);
      expect(elapsed).toBeGreaterThanOrEqual(BLOCK_MS * 0.8);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

/** Every Slack method a blocked `fetchRecent` may touch; each is separately rate-limited. */
const BOUNDED_METHODS = ['apps.connections.open', 'conversations.history'] as const;

describe('slack blocking fetch: poll storm bound', () => {
  for (const [blockMs, pollIntervalMs] of [
    [3000, 250],
    [3000, 50],
  ] as const) {
    it(`an unavailable Socket Mode costs O(wall clock) requests on every method, not O(iterations) (blockMs=${blockMs}, poll=${pollIntervalMs})`, async () => {
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

        // Re-driving per iteration is blockMs/pollIntervalMs requests (12 and 60 here). One bound
        // over the method name, so a path that trades one method's storm for another cannot pass.
        for (const method of BOUNDED_METHODS) {
          expect(fake.hits(method), method).toBeLessThanOrEqual(Math.ceil(blockMs / 1000) + 1);
        }
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
