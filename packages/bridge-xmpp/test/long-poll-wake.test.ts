import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, expectNoLeaks, FakeXmpp, seedJoined } from './fake-xmpp.js';

// Class: a lost wakeup caused by arming the wake source AFTER a window a live message can land in.
// `fetchRecent({blockMs})` is MAM-query + live-wait, and the wake is one-shot: a reflection that
// fires when no waiter is registered is GONE. If the archive row then commits after the next read's
// snapshot there is nothing left to wake the loop and the caller parks out the whole budget (core's
// catchup.block_max_ms, 60 s by default) on a message the archive already holds.
//
// The property is therefore an INVARIANT, not a step: from the moment a blocking fetch starts until
// it returns, the room's waiter set is never empty. Every cell below records `waiters.size` at the
// instant the live copy is reflected and asserts it is non-zero, so the defect is graded where it
// happens rather than only through its latency.
//
// The arrival axis names WINDOWS OF THE PATH, never query ordinals: an ordinal moves the moment the
// fix changes how many reads happen, which is how the row this replaces came to deliver its message
// nowhere at all. Each window is triggered off state the fixture or the plugin can actually observe
// — the server holding this connection's occupancy, a query being in flight, the plugin having
// re-armed. Crossed with the archival lag between the live copy and its archive row, and with the
// MAM round-trip latency, and bounded by the LAG rather than by the budget.

const TOPIC = asTopic('t-longpoll');
const BLOCK_MS = 8_000;

type Arrival =
  | 'inside the join'
  | 'inside the first archive read'
  | 'while parked after the first read'
  | 'inside a later archive read';

const arrivals: Array<{ arrival: Arrival; note: string }> = [
  { arrival: 'inside the join', note: 'admitted to the room, before any read was issued' },
  { arrival: 'inside the first archive read', note: "after that read's snapshot, in its round trip" },
  { arrival: 'while parked after the first read', note: 'the park itself, with no query in flight' },
  { arrival: 'inside a later archive read', note: "a re-poll's round trip, after an earlier wake" },
];

/** Fixed cost the plugin pays whatever the lag: probe, join, MAM check, and the reads either side
 * of the doubling re-poll's overshoot. Independent of `blockMs` — only a LOST wake reaches that. */
const promptBound = (lagMs: number, mamLatencyMs: number): number => 2 * lagMs + 700 + 5 * mamLatencyMs;

const wakeCells = arrivals.flatMap(({ arrival, note }) =>
  [0, 50, 400, 1_000].flatMap((lagMs) =>
    [0, 200].map((mamLatencyMs) => ({ arrival, note, lagMs, mamLatencyMs })),
  ),
);

describe('XMPP long-poll wakeup (no lost wakes across the blocking path)', () => {
  it.each(wakeCells)(
    'a live copy arriving $arrival ($note), $lagMs ms archival lag, $mamLatencyMs ms round trip',
    async ({ arrival, lagMs, mamLatencyMs }) => {
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      const p = attach(plugin, fake);
      const room = p.roomJid(TOPIC);
      // NOT pre-joined: the probe and the join are windows of this call too, and a cell that seeds
      // occupancy cannot see a wake lost in either of them.
      fake.rooms.add(room);
      const seed = fake.archiveOnly(room, 'old');
      fake.mamLatencyMs = mamLatencyMs;

      const archiveTimers: Array<ReturnType<typeof setTimeout>> = [];
      let waitersAtDelivery: number | undefined;
      const deliverLive = (): void => {
        if (waitersAtDelivery !== undefined) return;
        waitersAtDelivery = p.waiters.get(room)?.size ?? 0;
        fake.reflectOnly(room, 'fresh');
        archiveTimers.push(setTimeout(() => fake.archiveOnly(room, 'fresh'), lagMs));
      };

      let arms = 0;
      const armWaiter = p.armWaiter.bind(plugin);
      p.armWaiter = (r: string) => {
        arms++;
        return armWaiter(r);
      };

      if (arrival === 'inside the join') {
        // The MAM-availability disco runs once the server holds this connection's occupancy and
        // before ensureJoinedRoom resolves, so the room is live to us and no read exists yet.
        fake.onDiscoRequest = () => {
          if (fake.occupied.has(room)) deliverLive();
        };
      }
      if (arrival === 'inside the first archive read') fake.onMamInFlight = () => deliverLive();
      if (arrival === 'while parked after the first read') {
        // The park has no observable handle from the fixture, so land in it by the clock: the read
        // is back one round trip after the query arrives, and the park then runs for seconds.
        fake.onMamRequest = () => {
          if (arms > 0 && waitersAtDelivery === undefined) {
            archiveTimers.push(setTimeout(deliverLive, mamLatencyMs + 60));
          }
        };
      }
      if (arrival === 'inside a later archive read') {
        // Wake the loop with a live stanza the archive never holds, then deliver the real copy in a
        // round trip the plugin only reaches by having re-armed — never by a query count.
        let spurious = false;
        fake.onMamInFlight = () => {
          if (!spurious) {
            spurious = true;
            fake.reflectOnly(room, 'not-archived');
            return;
          }
          if (arms > 1) deliverLive();
        };
      }

      const started = Date.now();
      const res = await plugin.fetchRecent({
        topic: TOPIC,
        since: asCursor(seed.archId),
        blockMs: BLOCK_MS,
      });
      const elapsed = Date.now() - started;
      for (const t of archiveTimers) clearTimeout(t);

      expect(waitersAtDelivery).toBeGreaterThan(0);
      expect(res.messages.map((m) => m.content)).toEqual(['fresh']);
      expect(elapsed).toBeLessThanOrEqual(promptBound(lagMs, mamLatencyMs));
      expectNoLeaks(plugin);
      await plugin.disconnect();
    },
    30_000,
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
