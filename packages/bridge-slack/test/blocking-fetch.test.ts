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
 *     channel legitimately sit at different floors. What the floor buys is REQUEST COST, not the
 *     page and not the budget: a waiter woken below its floor re-queries, surfaces nothing, carries
 *     the same floor forward and re-arms — so it still holds its whole budget and still returns an
 *     empty page, and every below-floor event on the channel has cost one tiered
 *     `conversations.history` read. Grading elapsed time therefore grades nothing here, which is why
 *     each ineligible row lands its event REPEATEDLY and bounds the reads the call spent.
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
 * How many times an INELIGIBLE event is landed, and how far apart. One landing costs one spurious
 * re-query, which the ladder's own re-reads hide; repeating it across the park is what lifts the
 * cost of an ignored floor clear of {@link readCeiling}, whatever the ladder happened to do.
 */
const SPURIOUS_LANDINGS = 8;
const FIRST_LANDING_MS = 150;
const LANDING_SPACING_MS = 100;

/** The two reads no ladder rung can be blamed for: the entry query and the post-deadline one. */
const MIN_BLOCKED_READS = 2;

/**
 * Where a live event sits relative to the parked waiter's exclusive floor, expressed as the `ts` it
 * lands at. `floor`, `tickBelow` and `tickAbove` are minted consecutively, so the two tick rows are
 * the SMALLEST steps the backend's own cursor can express either side of the floor — `tickAbove`
 * fails a comparison that needs a coarser gap, and `atFloor` is the row that separates `>` from `>=`.
 */
interface Floors {
  tickBelow: string;
  floor: string;
  tickAbove: string;
}

const OFFSETS: Array<{ name: string; wakes: boolean; ts: (f: Floors) => string }> = [
  { name: '60s below the floor', wakes: false, ts: (f) => `${seconds(f.floor) - 60}.000001` },
  { name: 'one suffix tick below the floor', wakes: false, ts: (f) => f.tickBelow },
  { name: 'exactly at the floor', wakes: false, ts: (f) => f.floor },
  { name: 'one suffix tick above the floor', wakes: true, ts: (f) => f.tickAbove },
  { name: '60s above the floor', wakes: true, ts: (f) => `${seconds(f.floor) + 60}.000001` },
];

const seconds = (ts: string): number => Number(ts.split('.')[0]);

describe('slack blocking fetch: only an above-floor event on its own channel wakes a waiter', () => {
  for (const offset of OFFSETS) {
    for (const channel of ['its own channel', 'a different channel'] as const) {
      const own = channel === 'its own channel';
      const wakes = offset.wakes && own;
      it(`${wakes ? 'wakes on' : 'stays parked through'} an event ${offset.name} on ${channel}`, async () => {
        const parked = asTopic('C0FLOOR');
        const other = asTopic('C0OTHER');
        await withBlocking({ channels: [parked, other] }, async (fake, plugin) => {
          // Three consecutive `ts` above everything in history: the first query is empty, so the
          // call parks, and nothing below the floor is fetchable — every ineligible row's page is
          // empty whether or not its floor was honoured.
          const floors: Floors = {
            tickBelow: fake.mintTs(),
            floor: fake.mintTs(),
            tickAbove: fake.mintTs(),
          };
          const at = offset.ts(floors);
          const landOn = own ? parked : other;
          const event = { ts: at, text: 'landed', user: 'U0X' };
          // A waking row must be READABLE too — a push the re-query cannot confirm returns an empty
          // page and the row would grade the floor against nothing.
          if (wakes) fake.seedRaw(landOn, [{ type: 'message', ...event }]);
          for (let i = 0; i < (wakes ? 1 : SPURIOUS_LANDINGS); i++) {
            setTimeout(() => fake.pushEvent(landOn, event), FIRST_LANDING_MS + i * LANDING_SPACING_MS);
          }

          const before = fake.hits('conversations.history');
          const t0 = Date.now();
          const result = await plugin.fetchRecent({
            topic: parked,
            since: asCursor(floors.floor),
            blockMs: BLOCK_MS,
          });
          const elapsed = Date.now() - t0;
          const reads = fake.hits('conversations.history') - before;

          if (wakes) {
            expect(result.messages.map((m) => m.content)).toEqual(['landed']);
            expect(elapsed, 'woken natively').toBeLessThan(BLOCK_MS / 2);
            return;
          }
          expect(result.messages).toEqual([]);
          expect(String(result.nextCursor)).toBe(floors.floor);
          expect(elapsed, 'held its budget').toBeGreaterThanOrEqual(BLOCK_MS * 0.8);
          // The class: an ignored floor is invisible in the page and in the clock, and shows up
          // ONLY as one tiered read per ineligible event.
          expect(reads, `${SPURIOUS_LANDINGS} ineligible events cost reads`).toBeLessThanOrEqual(
            readCeiling(fake, BLOCK_MS),
          );
          // …paired with a floor, so that a park which stopped re-reading history — which satisfies
          // the ceiling perfectly — fails here instead.
          expect(reads, 'history re-read floor').toBeGreaterThanOrEqual(MIN_BLOCKED_READS);
        });
      });
    }
  }

  it('two waiters at different floors on one channel: only the eligible one wakes', async () => {
    const topic = asTopic('C0TWOFLOORS');
    await withBlocking({ channels: [topic] }, async (fake, plugin) => {
      const lowFloor = fake.mintTs();
      const between = fake.mintTs();
      const highFloor = fake.mintTs();
      const event = { ts: between, text: 'mid', user: 'U0X' };

      fake.seedRaw(topic, [{ type: 'message', ...event }]);
      // Above the low floor and below the high one, landed repeatedly: eligible for one waiter and
      // ineligible for the other, so the high waiter's cost is what the per-waiter floor buys.
      for (let i = 0; i < SPURIOUS_LANDINGS; i++) {
        setTimeout(() => fake.pushEvent(topic, event), FIRST_LANDING_MS + i * LANDING_SPACING_MS);
      }

      const before = fake.hits('conversations.history');
      const t0 = Date.now();
      const [low, high] = await Promise.all([
        plugin.fetchRecent({ topic, since: asCursor(lowFloor), blockMs: BLOCK_MS }),
        plugin.fetchRecent({ topic, since: asCursor(highFloor), blockMs: BLOCK_MS }),
      ]);
      const elapsed = Date.now() - t0;
      const reads = fake.hits('conversations.history') - before;

      expect(low.messages.map((m) => m.content)).toEqual(['mid']);
      expect(high.messages).toEqual([]);
      expect(String(high.nextCursor)).toBe(highFloor);
      expect(elapsed).toBeGreaterThanOrEqual(BLOCK_MS * 0.8);
      // The high waiter shares the channel's waiter set: a wake that consults the set but not the
      // waiter's own floor re-queries it once per landing, for a page it can never carry.
      expect(reads, 'two calls, one of them ineligible for every landing').toBeLessThanOrEqual(
        2 * readCeiling(fake, BLOCK_MS),
      );
      expect(reads, 'history re-read floor').toBeGreaterThanOrEqual(2 * MIN_BLOCKED_READS);
    });
  });
});

/** Every Slack method a blocked `fetchRecent` may touch; each is separately rate-limited. */
const BOUNDED_METHODS = ['apps.connections.open', 'conversations.history'] as const;

/**
 * The two reads a blocked call spends outside the ladder: the entry query `fetchRecent` makes before
 * it decides to block at all, and the final one once the budget has run out.
 */
const ENTRY_AND_FINAL_READS = 2;

/**
 * The `conversations.history` reads one blocked call may spend: one per ladder rung, its own two,
 * and one for each ESTABLISHED socket the edge took away — a lost socket releases the parked caller
 * onto the history ladder at once ('a socket lost mid-park releases the caller on the loss', below),
 * which is a read the rung timer had not yet permitted.
 *
 * That last term is read off the FIXTURE rather than folded into a hand-tuned slack, so that this
 * stays a measurement: with a literal, a regression of one extra read per call is indistinguishable
 * from an edge that happened to flap once more, and the bound fails on green source under load
 * instead of on the defect it names. It is only a BOUND because every row that can lose a socket
 * also bounds `apps.connections.open` by wall clock, and a socket cannot be lost twice without being
 * dialled again — so pair the two, never assert this one alone.
 */
const readCeiling = (fake: FakeSlack, blockMs: number): number =>
  rungStarts(blockMs).length + ENTRY_AND_FINAL_READS + fake.establishedClosed;

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
 * The rows from 'greets and then pushes no event' on are the axis a handshake-centric table cannot
 * see: the handshake SUCCEEDS and the stream still does not deliver. That is not an exotic edge — an
 * app whose Event Subscriptions lack `message.channels`, or whose `app_token` is shared with a
 * second process (Socket Mode routes each payload to exactly ONE of an app's connections), greets
 * and then pushes nothing at all; and an edge that greets and then DROPS does it once per round
 * trip, which is the shape that makes every ceiling below a statement about wall clock rather than
 * about how often the vendor happened to fail.
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
  // The two rows above lose ONE socket, so neither can see a per-loss cost repeating: an edge that
  // accepts, greets and drops answers every `apps.connections.open` with `ok:true`, so nothing on
  // the failure ladder paces it and each loss both redials and releases the parked caller. The
  // intervals straddle the ladder's first rung, so one row flaps far faster than the ladder and one
  // at about its pace.
  {
    name: 'an edge that greets and drops every 50ms for the whole budget',
    appToken: 'xapp-test',
    dials: 'reconnect',
    arm: (fake) => fake.flap(50),
  },
  {
    name: 'an edge that greets and drops every 400ms for the whole budget',
    appToken: 'xapp-test',
    dials: 'reconnect',
    arm: (fake) => fake.flap(400),
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
          expect(fake.hits('conversations.history'), 'history reads').toBeLessThanOrEqual(
            readCeiling(fake, DEGRADED_BLOCK_MS),
          );
          // Dials are bounded by whoever owns them: nobody without an app_token, the caller's ladder
          // while nothing was ever established, the reconnect owner's own backoff after a loss —
          // which is wall clock either way, including when every dial SUCCEEDS and the connection it
          // opens is taken away immediately.
          const dialCeiling = {
            none: 0,
            ladder: rungStarts(DEGRADED_BLOCK_MS).length + ENTRY_AND_FINAL_READS,
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
        expect(reads, `${unsurfaced} unsurfaced records`).toBeLessThanOrEqual(
          walkPages + readCeiling(fake, BACKLOG_BLOCK_MS),
        );
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
          expect(fake.hits(method), `${method} ceiling`).toBeLessThanOrEqual(
            readCeiling(fake, blockMs),
          );
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
