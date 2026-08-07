import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, expectNoLeaks, FakeXmpp, seedJoined } from './fake-xmpp.js';

// Class: a lost wakeup caused by arming the wake source AFTER the state snapshot it races.
// `fetchRecent({blockMs})` is MAM-query + live-wait; if the waiter is armed only once a query has
// come back empty, a message that lands during that query's round trip fires into the void and the
// caller waits out the whole budget (up to catchup.block_max_ms) for a message that already exists.
// The table injects a realistic remote round trip and drops a message into EVERY stage of the
// blocking path — before the query is snapshotted, inside the in-flight window, and after the
// waiter is armed — asserting an upper bound on latency in each, not just "it eventually returned".

const TOPIC = asTopic('t-longpoll');
const LATENCY_MS = 200;
const BLOCK_MS = 4_000;
/** Generous over one round trip, far under the budget: only a lost wake reaches the deadline. */
const PROMPT_MS = 1_500;

type Stage =
  | 'before-query-snapshot'
  | 'in-flight-after-snapshot'
  | 'in-flight-of-the-recheck'
  | 'after-waiter-armed';

const stages: Array<{ stage: Stage; note: string }> = [
  { stage: 'before-query-snapshot', note: 'the query itself must return it' },
  { stage: 'in-flight-after-snapshot', note: 'invisible to the in-flight query; only a wake finds it' },
  { stage: 'in-flight-of-the-recheck', note: 'lands during the blocking path own re-query' },
  { stage: 'after-waiter-armed', note: 'delivered between arming and parking' },
];

describe('XMPP long-poll wakeup (no lost wakes across the blocking path)', () => {
  it.each(stages)(
    'returns promptly when a message lands $stage ($note)',
    async ({ stage }) => {
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      const p = attach(plugin, fake);
      const room = p.roomJid(TOPIC);
      seedJoined(p, fake, room);
      const seed = fake.archiveOnly(room, 'old');

      let delivered = false;
      const deliverOnce = (): void => {
        if (delivered) return;
        delivered = true;
        fake.deliver(room, 'fresh');
      };
      fake.mamLatencyMs = LATENCY_MS;
      if (stage === 'before-query-snapshot') fake.onMamRequest = deliverOnce;
      if (stage === 'in-flight-after-snapshot') fake.onMamInFlight = deliverOnce;
      if (stage === 'in-flight-of-the-recheck') {
        let queries = 0;
        fake.onMamInFlight = () => {
          if (++queries > 1) deliverOnce();
        };
      }
      if (stage === 'after-waiter-armed') {
        const armWaiter = p.armWaiter.bind(plugin);
        p.armWaiter = (r: string) => {
          const waiter = armWaiter(r);
          deliverOnce();
          return waiter;
        };
      }

      const started = Date.now();
      const res = await plugin.fetchRecent({
        topic: TOPIC,
        since: asCursor(seed.archId),
        blockMs: BLOCK_MS,
      });
      const elapsed = Date.now() - started;

      expect(res.messages.map((m) => m.content)).toEqual(['fresh']);
      expect(elapsed).toBeLessThan(PROMPT_MS);
      expectNoLeaks(plugin);
      await plugin.disconnect();
    },
  );

  it('holds the full budget (and leaks nothing) when nothing is posted', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    seedJoined(p, fake, room);
    const seed = fake.archiveOnly(room, 'old');

    const started = Date.now();
    const res = await plugin.fetchRecent({
      topic: TOPIC,
      since: asCursor(seed.archId),
      blockMs: 300,
    });
    const elapsed = Date.now() - started;

    expect(res.messages).toEqual([]);
    expect(String(res.nextCursor)).toBe(seed.archId);
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expectNoLeaks(plugin);
    await plugin.disconnect();
  });

  it('a spurious wake (live stanza the archive does not hold) re-arms instead of returning early', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    seedJoined(p, fake, room);
    const seed = fake.archiveOnly(room, 'old');

    const started = Date.now();
    const pending = plugin.fetchRecent({
      topic: TOPIC,
      since: asCursor(seed.archId),
      blockMs: 400,
    });
    setTimeout(() => fake.reflectOnly(room, 'not-archived'), 50);
    const res = await pending;

    expect(res.messages).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380); // kept waiting; did not bail at 50 ms
    expectNoLeaks(plugin);
    await plugin.disconnect();
  });

});

// Class: a teardown that must settle the operations still in flight, with no test that HAS one in
// flight at teardown. Every case above either lets the budget expire or is woken by a message, so
// disconnect()'s cancellation of parked long-polls — the loop the source says exists to prevent
// leaked listeners and timers — could be deleted with the suite fully green. Left un-cancelled, a
// fetch parked on a 60 s block_ms holds its timer to expiry after the bridge has stopped, so cli.ts's
// shutdown waits on a plugin that is already dead. The table parks a fetch and tears the plugin down
// at each stage of the blocking path.

const DISCONNECT_BUDGET_MS = 5_000;
/** A cancelled park returns in a round trip; only an un-cancelled one reaches the budget. */
const CANCEL_MS = 500;

type Teardown = 'before the first query' | 'while a query is in flight' | 'while parked';

const teardowns: Teardown[] = [
  'before the first query',
  'while a query is in flight',
  'while parked',
];

describe('XMPP disconnect settles a long-poll that is still parked', () => {
  it.each(teardowns)('disconnecting %s returns the caller at once', async (when) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    seedJoined(p, fake, room);
    const seed = fake.archiveOnly(room, 'old');
    fake.mamLatencyMs = 50;

    let stopped: Promise<void> | undefined;
    let stoppedAt = 0;
    const stop = (): void => {
      if (stopped !== undefined) return;
      stoppedAt = Date.now();
      stopped = plugin.disconnect();
    };
    if (when === 'while a query is in flight') fake.onMamInFlight = stop;

    const pending = plugin.fetchRecent({
      topic: TOPIC,
      since: asCursor(seed.archId),
      blockMs: DISCONNECT_BUDGET_MS,
    });
    if (when === 'before the first query') stop();
    // Two 50 ms round trips precede the park, so 400 ms lands inside it and not inside a query.
    const parked = when === 'while parked' ? setTimeout(stop, 400) : undefined;

    const outcome = await pending.then(
      (res) => res,
      (err: Error) => err,
    );
    clearTimeout(parked);
    expect(Date.now() - stoppedAt).toBeLessThan(CANCEL_MS);
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/not connected/);
    } else {
      // An empty page carrying the caller's own cursor: nothing lost, the next call resumes here.
      expect(outcome.messages).toEqual([]);
      expect(String(outcome.nextCursor)).toBe(seed.archId);
    }
    expectNoLeaks(plugin);
    await stopped;
  });
});

// Class: a reconciliation window that LATCHES OFF, so a message the archive already holds is
// withheld until the caller's whole budget expires. The blocking path wakes on the live copy and
// then re-polls MAM for the archive to catch up; any re-poll allowance that is a fixed count times
// a fixed interval is a cliff — an archive lag one millisecond past it drops the fetch back to a
// single park over the entire remaining budget with nothing left to wake it, turning a 200 ms lag
// into a 60 s empty return. The property is that the wait tracks the LAG, never the budget, so the
// table crosses the lag axis with two budgets and bounds every row's latency by the lag rather
// than by blockMs. The single 120 ms case this replaces sat just inside the old window and could
// not fail.

const REFLECT_AT_MS = 30;
/** Round-trip + timer granularity on top of the doubling re-poll's at-most-2x overshoot. */
const LAG_OVERHEAD_MS = 300;

const lagRows = [400, 3_000].flatMap((blockMs) =>
  [0, 50, 120, 200, 400, 1_000]
    .filter((lagMs) => lagMs + LAG_OVERHEAD_MS < blockMs)
    .map((lagMs) => ({ blockMs, lagMs })),
);

describe('XMPP long-poll returns on archival lag, bounded by the lag and never by the budget', () => {
  it.each(lagRows)(
    'a $lagMs ms archive lag over a $blockMs ms budget',
    async ({ blockMs, lagMs }) => {
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      const p = attach(plugin, fake);
      const room = p.roomJid(TOPIC);
      seedJoined(p, fake, room);
      const seed = fake.archiveOnly(room, 'old');

      const started = Date.now();
      const pending = plugin.fetchRecent({
        topic: TOPIC,
        since: asCursor(seed.archId),
        blockMs,
      });
      // The live copy lands first; the archive commits `lagMs` later, so only a re-poll finds it.
      const timers = [
        setTimeout(() => fake.reflectOnly(room, 'lagging'), REFLECT_AT_MS),
        setTimeout(() => fake.archiveOnly(room, 'lagging'), REFLECT_AT_MS + lagMs),
      ];
      const res = await pending;
      const elapsed = Date.now() - started;
      for (const t of timers) clearTimeout(t);

      expect(res.messages.map((m) => m.content)).toEqual(['lagging']);
      expect(elapsed).toBeLessThanOrEqual(2 * lagMs + LAG_OVERHEAD_MS);
      expect(elapsed).toBeLessThan(blockMs * 0.9);
      expectNoLeaks(plugin);
      await plugin.disconnect();
    },
  );
});

// Class: an argument honoured on only ONE arm of the call it belongs to, and — the same defect one
// turn further in — an argument that changes WHICH WINDOW a read returns rather than only when it
// returns. `blockMs` first sat inside the `since !== undefined` branch, so a since-less
// `fetchRecent` returned in milliseconds while the plugin declares `supportsBlockingFetch` and
// core's tool documents long-polling "whether or not you passed since". Making it block was not
// enough: the since-less arm parked on the ZERO cursor, so a since-less fetch that HAD to wait came
// back with the OLDEST `limit` of the burst it woke on while the same call over an already-populated
// archive returns the NEWEST — the conformance clause "a since-less fetch returns the NEWEST
// messages" silently inverted by a latency hint, on exactly the call core's fetchRecentBlocking
// makes for an agent that holds no cursor. The table crosses the since axis with the archive's
// state, with whether one message or a burst larger than `limit` arrives, and grades every arrival
// cell against what the SAME call answers with `blockMs: 0` once the messages are already there.

const BLOCK_ARM_MS = 600;
/** A return this quick cannot have waited out any budget. */
const AT_ONCE_MS = 250;
/** Small enough that a burst can exceed it without the fixture archiving hundreds of stanzas. */
const ARM_LIMIT = 3;

interface Arm {
  name: string;
  /** `null` = omit the argument entirely; `'tail'` = the archive's own last cursor. */
  since: null | '' | 'tail';
}
const arms: Arm[] = [
  { name: 'since omitted', since: null },
  { name: "since '' (the zero cursor)", since: '' },
  { name: 'since the tail', since: 'tail' },
];
const histories = [
  { name: 'an empty archive', seeded: false },
  { name: 'an archive with history', seeded: true },
];
interface Mode {
  name: string;
  blocks: boolean;
  /** Messages delivered 50 ms into the block; 0 = nothing arrives. */
  burst: number;
}
const modes: Mode[] = [
  { name: 'blockMs 0', blocks: false, burst: 0 },
  { name: 'blockMs > 0, nothing arrives', blocks: true, burst: 0 },
  { name: 'blockMs > 0, one message arrives', blocks: true, burst: 1 },
  { name: 'blockMs > 0, a burst longer than limit arrives', blocks: true, burst: ARM_LIMIT + 3 },
];

const armCells = arms.flatMap((arm) =>
  histories.flatMap((history) => modes.map((mode) => ({ arm, history, mode }))),
);

describe('XMPP honours blockMs on every arm of fetchRecent', () => {
  it.each(armCells)('$arm.name over $history.name, $mode.name', async ({ arm, history, mode }) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake, undefined);
    const room = p.roomJid(TOPIC);
    seedJoined(p, fake, room);
    if (history.seeded) fake.archiveOnly(room, 'old');

    // The window is empty unless the archive holds something the cursor does not already cover.
    const windowEmpty = arm.since === 'tail' || !history.seeded;
    const since =
      arm.since === null
        ? undefined
        : arm.since === 'tail'
          ? ((await plugin.fetchRecent({ topic: TOPIC })).nextCursor as unknown as string)
          : arm.since;
    const args = {
      topic: TOPIC,
      limit: ARM_LIMIT,
      ...(since === undefined ? {} : { since: asCursor(since) }),
    };

    const started = Date.now();
    const pending = plugin.fetchRecent({ ...args, blockMs: mode.blocks ? BLOCK_ARM_MS : 0 });
    const arriving =
      mode.burst > 0
        ? setTimeout(() => {
            for (let i = 0; i < mode.burst; i++) fake.deliver(room, `fresh-${i}`);
          }, 50)
        : undefined;
    const res = await pending;
    const elapsed = Date.now() - started;
    clearTimeout(arriving);

    if (!windowEmpty) {
      expect(res.messages.map((m) => m.content)).toEqual(['old']);
      expect(elapsed).toBeLessThan(AT_ONCE_MS);
    } else if (!mode.blocks || mode.burst === 0) {
      expect(res.messages).toEqual([]);
      if (mode.blocks) {
        expect(elapsed).toBeGreaterThanOrEqual(BLOCK_ARM_MS * 0.9); // it actually blocked
        expect(String(res.nextCursor)).toBe(since ?? '');
      } else {
        expect(elapsed).toBeLessThan(AT_ONCE_MS);
      }
    } else {
      expect(elapsed).toBeLessThan(BLOCK_ARM_MS * 0.8); // woken by the message, not by the budget
      // blockMs may change WHEN this call returns and nothing else: the same arm, asked once the
      // burst is already archived, must answer the same window and the same cursor.
      const control = await plugin.fetchRecent({ ...args, blockMs: 0 });
      expect(res.messages.map((m) => m.content)).toEqual(
        control.messages.map((m) => m.content),
      );
      expect(String(res.nextCursor)).toBe(String(control.nextCursor));
      expect(res.messages.length).toBe(Math.min(mode.burst, ARM_LIMIT));
    }
    expectNoLeaks(plugin);
    await plugin.disconnect();
  }, 15_000);
});
