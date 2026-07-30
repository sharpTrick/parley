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
 *
 * (4) DEGRADED SOURCE. The plugin declares `supportsBlockingFetch`, so core's generic 250 ms
 *     re-drive can never compensate for a budget the plugin consumed inside ONE call. Every way the
 *     live stream can fail to serve must therefore keep re-reading history on a bounded ladder,
 *     because the message is ALREADY durable there — and "the handshake failed" is only half of
 *     those ways. A stream that ESTABLISHES and then delivers nothing (no `message.channels`
 *     subscription; an `app_token` whose payloads Slack routed to another process's socket; a socket
 *     lost mid-park) withholds exactly the same durable history, so the table crosses both halves
 *     against the same ladder. A request ceiling alone cannot state that: parking until the deadline
 *     and doing no work satisfies every ceiling perfectly, which is why the table grades DELIVERY
 *     LATENCY against the ladder's own rungs and pins a work FLOOR next to each ceiling.
 */
import { asCursor, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { DIAL_BACKOFF_MS, MAX_DIAL_BACKOFF_MS, type SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';
import {
  deliver,
  parkedWaiters,
  rungStarts,
  startSlack,
  withSlack,
  type SlackHarnessOptions,
} from './harness.js';

/**
 * REGISTRY HYGIENE, asserted after every blocking row in this file rather than as a point test: once
 * a `fetchRecent({blockMs})` has settled — woken, timed out, aborted by `disconnect()`, or released
 * by a socket loss — the plugin must hold no parked waiter, and therefore no live waiter timer. The
 * tables below already drive all four exits, and none of them could see the registry at all: both of
 * its lifecycle guards (the `wake()` on a satisfied re-query, the drain on a lost socket) were
 * deletable with 504 tests green.
 */
async function withBlocking<T>(
  opts: SlackHarnessOptions,
  fn: (fake: FakeSlack, plugin: SlackPlugin) => Promise<T>,
): Promise<T> {
  return withSlack(opts, async (fake, plugin) => {
    const result = await fn(fake, plugin);
    expect(parkedWaiters(plugin), 'waiters still parked after the call settled').toBe(0);
    return result;
  });
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
        const topic = asTopic('C0WAKE');
        await withBlocking({ channels: [topic] }, async (fake, plugin) => {
          stage.arm(fake, topic);

          const t0 = Date.now();
          const result = await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs });
          const elapsed = Date.now() - t0;

          expect(result.messages.map((m) => m.content)).toEqual(['live']);
          // A waiter armed after the re-query misses the mid-query push and burns the full budget.
          expect(elapsed).toBeLessThan(blockMs / 2);
        });
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
      const topic = asTopic('C0FLOOR');
      await withBlocking({ channels: [topic, 'C0OTHER'] }, async (fake, plugin) => {
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
      });
    });
  }

  it('two waiters at different floors on one channel: only the eligible one wakes', async () => {
    const topic = asTopic('C0TWOFLOORS');
    await withBlocking({ channels: [topic] }, async (fake, plugin) => {
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
    });
  });
});

/** Every Slack method a blocked `fetchRecent` may touch; each is separately rate-limited. */
const BOUNDED_METHODS = ['apps.connections.open', 'conversations.history'] as const;

/**
 * When a message durable in history at `landedAt` must have been DELIVERED by: the first ladder rung
 * at or after it, and never later than the deadline (the final re-query). This is the assertion that
 * "park until the deadline and do nothing" cannot satisfy.
 */
const dueBy = (landedAt: number, blockMs: number): number =>
  Math.min(rungStarts(blockMs).find((s) => s >= landedAt) ?? blockMs, blockMs);

/** Request/scheduling jitter allowed on top of a ladder rung. */
const SLACK_MS = 400;

/**
 * A way for the live event source not to serve, with history still perfectly readable. `appToken` is
 * stated per row because "no app token at all" is a legal reactive-only config, not a fault; `dials`
 * states who is allowed to redial, because a socket that was ESTABLISHED and then lost hands the
 * redial to the reconnect owner, on its own backoff rather than on the caller's ladder.
 *
 * The last four rows are the axis a handshake-centric table cannot see: the handshake SUCCEEDS and
 * the stream still does not deliver. That is not an exotic edge — an app whose Event Subscriptions
 * lack `message.channels`, or whose `app_token` is shared with a second process (Socket Mode routes
 * each payload to exactly ONE of an app's connections), greets and then pushes nothing at all.
 */
const DEGRADATIONS: Array<{
  name: string;
  appToken?: string;
  dials: 'none' | 'ladder' | 'reconnect';
  arm: (fake: FakeSlack) => void;
}> = [
  { name: 'no app_token at all', dials: 'none', arm: () => undefined },
  {
    name: 'apps.connections.open answering ok:false',
    appToken: 'xapp-test',
    dials: 'ladder',
    arm: (fake) => fake.failMethod('apps.connections.open', 'internal_error'),
  },
  {
    name: 'a socket that closes before hello',
    appToken: 'xapp-test',
    dials: 'ladder',
    arm: (fake) => fake.setGreet('pre-hello-close'),
  },
  {
    name: 'a socket that accepts and stays silent',
    appToken: 'xapp-test',
    dials: 'ladder',
    arm: (fake) => fake.setGreet('silent'),
  },
  {
    name: 'a handed-out ws URL that refuses the connection',
    appToken: 'xapp-test',
    dials: 'ladder',
    arm: (fake) => fake.setWsUrl('ws://127.0.0.1:1/socket'),
  },
  {
    name: 'a socket that greets and then pushes no event at all',
    appToken: 'xapp-test',
    dials: 'ladder',
    arm: () => undefined,
  },
  {
    name: 'an established socket dropped mid-park, redials failing',
    appToken: 'xapp-test',
    dials: 'reconnect',
    arm: (fake) => {
      setTimeout(() => {
        fake.failMethod('apps.connections.open', 'internal_error');
        fake.dropSockets();
      }, 300);
    },
  },
  {
    name: 'an established socket dropped mid-park that reconnects',
    appToken: 'xapp-test',
    dials: 'reconnect',
    arm: (fake) => {
      setTimeout(() => fake.dropSockets(), 300);
    },
  },
];

const DEGRADED_BLOCK_MS = 4000;
/** Where in the budget the message becomes durable in history. */
const LANDING_FRACTIONS = [0.1, 0.5, 0.9];

describe('slack blocking fetch: a degraded event source must not withhold durable history', () => {
  for (const degradation of DEGRADATIONS) {
    for (const fraction of LANDING_FRACTIONS) {
      const landing = Math.round(DEGRADED_BLOCK_MS * fraction);
      it(`${degradation.name}: a message durable at ${fraction * 100}% of the budget is delivered on the next ladder rung`, async () => {
        const topic = asTopic('C0DEGRADED');
        const { fake, plugin, cleanup } = await startSlack({
          appToken: degradation.appToken ?? null,
          handshakeTimeoutMs: 30_000,
          channels: [topic],
        });
        try {
          degradation.arm(fake);
          // History ONLY — no socket push, because the whole point is that no live stream is serving.
          setTimeout(() => fake.seed(topic, [{ text: 'durable' }]), landing);

          const t0 = Date.now();
          const result = await fetchRecentBlocking(
            plugin,
            { topic, since: asCursor('0') },
            { blockMs: DEGRADED_BLOCK_MS, pollIntervalMs: 250 },
          );
          const elapsed = Date.now() - t0;

          expect(result.messages.map((m) => m.content)).toEqual(['durable']);
          // The class: withholding it until the deadline is the defect, so the ceiling is the LADDER,
          // not the budget. Only the last row may legitimately land at the deadline.
          expect(elapsed, `elapsed vs ladder`).toBeLessThanOrEqual(
            dueBy(landing, DEGRADED_BLOCK_MS) + SLACK_MS,
          );
          expect(elapsed, 'cannot return before the message exists').toBeGreaterThanOrEqual(
            landing - SLACK_MS,
          );
          // And it stays cheap: the ladder caps history re-reads by wall clock, not by iterations.
          const ladderCeiling = rungStarts(DEGRADED_BLOCK_MS).length + 2;
          expect(fake.hits('conversations.history'), 'history reads').toBeLessThanOrEqual(
            ladderCeiling,
          );
          // Dials are bounded by whoever owns them: nobody without an app_token, the caller's ladder
          // while nothing was ever established, the reconnect owner's own backoff after a loss.
          const dialCeiling = {
            none: 0,
            ladder: ladderCeiling,
            reconnect: Math.ceil(elapsed / DIAL_BACKOFF_MS) + 1,
          }[degradation.dials];
          expect(fake.hits('apps.connections.open'), 'dials').toBeLessThanOrEqual(dialCeiling);
          expect(fake.unauthedHits('conversations.history'), 'unauthenticated reads').toBe(0);
          expect(parkedWaiters(plugin), 'waiters still parked after the call settled').toBe(0);
        } finally {
          await cleanup();
        }
      });
    }
  }

  /**
   * The one degradation whose HANDLING is a latency guarantee rather than a bound: losing an
   * established socket releases the parked caller AT THE LOSS, instead of leaving it to discover the
   * dead stream when its rung expires. Every row above is bounded by a rung narrower than the drain
   * saves, so none of them can see the difference — this one drops the socket just after a rung
   * whose width is already {@link MAX_DIAL_BACKOFF_MS}, where the whole remaining budget is a single
   * park.
   */
  it('a socket lost mid-park releases the caller on the loss, not on its rung', async () => {
    const topic = asTopic('C0LOSTPARK');
    const blockMs = 6000;
    const lossAt = rungStarts(blockMs).find((s) => s >= MAX_DIAL_BACKOFF_MS / 2)! + 100;
    await withBlocking({ channels: [topic] }, async (fake, plugin) => {
      setTimeout(() => {
        // History has it, the stream never will: the redial is refused so the ladder, not a
        // recovered socket, is what has to deliver it.
        fake.seed(topic, [{ text: 'durable' }]);
        fake.failMethod('apps.connections.open', 'internal_error');
        fake.dropSockets();
      }, lossAt);

      const t0 = Date.now();
      const result = await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs });
      const elapsed = Date.now() - t0;

      expect(result.messages.map((m) => m.content)).toEqual(['durable']);
      // Held to the rung (or to the deadline) instead of released on the loss, this is `blockMs`.
      expect(elapsed, 'released on the socket loss').toBeLessThan(lossAt + SLACK_MS * 2);
    });
  });
});

/**
 * The axis the ceiling above holds fixed at zero: how much traffic sits ABOVE the caller's cursor
 * that this backend does not surface. `conversations.history` returns system and mutation records
 * (`channel_join`, `message_changed`, …) that the plugin filters out, so a resume-after-`since` walk
 * pages through all of them and returns nothing — perfectly ordinary channel traffic. If every rung
 * of the ladder re-walks from the caller's original cursor, the per-call request count is
 * `rungs × pages`, not `rungs + pages`: the wall-clock bound the poll-storm table states is then
 * true only for the single-message fixture it runs on.
 *
 * The low rows are controls — with one page above the floor a re-walk costs the same as a re-read,
 * so they cannot discriminate and exist to pin that the bound is ADDITIVE in the backlog rather than
 * generous. Latency is graded alongside cost, because a walk that stopped re-reading entirely would
 * satisfy every request ceiling here.
 */
const BACKLOG_SIZES = [0, 50, 300, 1000];

/** Records `conversations.history` returns and the plugin does not surface. */
const UNSURFACED_SUBTYPES = ['channel_join', 'message_changed'];

const BACKLOG_BLOCK_MS = 3000;
const BACKLOG_LANDING_MS = 1000;

describe('slack blocking fetch: an unsurfaced backlog costs one walk, not one per ladder rung', () => {
  for (const unsurfaced of BACKLOG_SIZES) {
    it(`${unsurfaced} unsurfaced records above the cursor: one walk plus a single-page read per rung`, async () => {
      const topic = asTopic('C0BACKLOG');
      const pageSize = 50;
      await withBlocking({ appToken: null, channels: [topic], pageSize }, async (fake, plugin) => {
        const anchor = fake.seed(topic, [{ text: 'anchor' }])[0]!;
        fake.seed(
          topic,
          Array.from({ length: unsurfaced }, (_, i) => ({
            text: `sys ${i}`,
            subtype: UNSURFACED_SUBTYPES[i % UNSURFACED_SUBTYPES.length]!,
          })),
        );
        setTimeout(() => fake.seed(topic, [{ text: 'durable' }]), BACKLOG_LANDING_MS);

        const before = fake.hits('conversations.history');
        const t0 = Date.now();
        const result = await plugin.fetchRecent({
          topic,
          since: asCursor(anchor.ts),
          blockMs: BACKLOG_BLOCK_MS,
        });
        const elapsed = Date.now() - t0;
        const reads = fake.hits('conversations.history') - before;

        expect(result.messages.map((m) => m.content)).toEqual(['durable']);
        expect(elapsed, 'elapsed vs ladder').toBeLessThanOrEqual(
          dueBy(BACKLOG_LANDING_MS, BACKLOG_BLOCK_MS) + SLACK_MS,
        );
        // One walk over the backlog, then one page per rung: additive, never multiplicative.
        const walkPages = Math.max(1, Math.ceil(unsurfaced / pageSize));
        const rungs = rungStarts(BACKLOG_BLOCK_MS).length;
        expect(reads, `${unsurfaced} unsurfaced records`).toBeLessThanOrEqual(walkPages + rungs + 2);
        expect(reads, 'history re-read floor').toBeGreaterThanOrEqual(walkPages);
      });
    });
  }
});

describe('slack blocking fetch: poll storm bound', () => {
  for (const [blockMs, pollIntervalMs] of [
    [3000, 250],
    [3000, 50],
  ] as const) {
    it(`an unavailable Socket Mode costs O(wall clock) requests on every method, not O(iterations) (blockMs=${blockMs}, poll=${pollIntervalMs})`, async () => {
      const topic = asTopic('C0STORM');
      await withBlocking({ channels: [topic] }, async (fake, plugin) => {
        fake.failMethod('apps.connections.open', 'internal_error');

        await fetchRecentBlocking(
          plugin,
          { topic, since: asCursor('0') },
          { blockMs, pollIntervalMs },
        );

        // Re-driving per iteration is blockMs/pollIntervalMs requests (12 and 60 here). One bound
        // over the method name, so a path that trades one method's storm for another cannot pass.
        const rungs = rungStarts(blockMs).length;
        for (const method of BOUNDED_METHODS) {
          expect(fake.hits(method), `${method} ceiling`).toBeLessThanOrEqual(rungs + 2);
        }
        // …paired with a FLOOR, so that holding the budget and re-reading NOTHING — which passes
        // every ceiling above with room to spare — fails here instead.
        expect(fake.hits('conversations.history'), 'history re-read floor').toBeGreaterThanOrEqual(
          rungs,
        );
        expect(fake.hits('apps.connections.open'), 'dial floor').toBeGreaterThanOrEqual(2);
      });
    });
  }

  it('a handshake that recovers mid-budget still wakes natively', async () => {
    const topic = asTopic('C0RECOVER');
    await withBlocking({ channels: [topic] }, async (fake, plugin) => {
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
    });
  });
});
