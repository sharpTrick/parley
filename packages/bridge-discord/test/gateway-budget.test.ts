import { asCursor, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Discord allows 1000 IDENTIFYs per 24h and penalizes an overrun by RESETTING the bot token, so
// the dial rate has to hold under EVERY initiator, not just the reconnect loop the backoff ladder
// was written for. These cases drive each entry point that can reach the gateway against each way
// a dial can fail, and assert the same quota invariant for every cell.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { BACKOFF_BASE_MS, DiscordPlugin, RECONNECT_CAP_MS } from '../src/index.js';
import {
  FakeWs,
  instances,
  openSockets,
  resetGateway,
  state,
  totalIdentifies,
} from './fake-gateway.js';
import {
  dialedBase,
  HUGE_HB,
  NO_HANDSHAKE_TIMEOUT,
  probe,
  reachReady,
  stubFetch,
  type FetchStub,
} from './harness.js';
import { dialCeiling, ladderDelays } from './ladder.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const QUOTA_PER_DAY = 1000;
const HANDSHAKE_MS = 10_000;
const TOPIC = asTopic('880001');

const connectPlugin = async (): Promise<DiscordPlugin> => {
  const plugin = new DiscordPlugin();
  await plugin.connect({
    token: 't',
    gateway_url: 'ws://fake',
    handshake_timeout_ms: HANDSHAKE_MS,
  });
  return plugin;
};

/** Ladder charges so far: {@link chargeDialAttempt} bumps this on every dial it paces. */
const chargesOf = (plugin: DiscordPlugin): number => probe(plugin, 'reconnectAttempts');

/**
 * Advance `totalMs` of simulated time, applying `drive` once to every socket the plugin opens.
 * Fine-grained while core's 250 ms long-poll fallback is at its busiest, coarser afterwards.
 */
async function pump(totalMs: number, drive: (ws: FakeWs) => void): Promise<void> {
  const driven = new Set<FakeWs>();
  for (let elapsed = 0; elapsed < totalMs; ) {
    const step = elapsed < 60_000 ? 250 : 5000;
    await vi.advanceTimersByTimeAsync(step);
    elapsed += step;
    for (const ws of [...instances]) {
      if (driven.has(ws)) continue;
      driven.add(ws);
      drive(ws);
    }
  }
}

// CLASS: a socket opened outside the ONE budget, because the caller read the budget's clock rather
// than its ownership. `chargeDialAttempt` sets `nextDialAt = now + wait` and the ladder's own
// `setTimeout(…, wait)` is armed a moment later and may fire later still, so between `nextDialAt`
// passing and that timer running the ladder holds a dial it has already paid for while `ensureUp`
// reads "the backoff is over". Every table above drives time with `advanceTimersByTimeAsync`, which
// fires the reconnect timer at exactly `nextDialAt` and therefore cannot open that window at all —
// so the clock has to move INDEPENDENTLY of the timer queue (`vi.setSystemTime`).
//
// The assertion is a BALANCE, not a bound: sockets opened must equal the rungs the ladder charged
// for, plus the one dial that started the ladder. A cell that merely stayed under a ceiling is
// satisfied by a cell that never dialed.
describe('one rung of the ladder buys exactly one dial', () => {
  /** Where the re-entrant call lands relative to `nextDialAt`; only `-1` is still backing off. */
  const OFFSETS_MS = [-1, 0, 1, 50];

  const INITIATORS: Array<{ label: string; start: (p: DiscordPlugin, t: Topic) => void }> = [
    {
      label: 'subscribe',
      start: (p, t) => {
        void p.subscribe(t, () => undefined).catch(() => undefined);
      },
    },
    {
      label: 'a native blocking fetchRecent',
      start: (p, t) => {
        void p
          .fetchRecent({ topic: t, since: asCursor('1'), blockMs: HOUR_MS })
          .catch(() => undefined);
      },
    },
    {
      label: "core's 250ms long-poll fallback",
      start: (p, t) => {
        void fetchRecentBlocking(
          p,
          { topic: t, since: asCursor('1') },
          { blockMs: HOUR_MS, pollIntervalMs: 250 },
        ).catch(() => undefined);
      },
    },
  ];

  /**
   * How the ladder came to own a dial. Both arms leave a reconnect armed; they differ in whether
   * the readiness memo is still holding a RESOLVED promise from the socket that dropped, which is
   * what decides whether `ensureUp` even reaches the budget.
   */
  const PRIORS: Array<{ label: string; arrange: (p: DiscordPlugin) => Promise<void> }> = [
    {
      label: 'a dial that never reached READY',
      arrange: async (plugin) => {
        state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
        void plugin.subscribe(TOPIC, () => undefined).catch(() => undefined);
        instances[0]!.hello(HUGE_HB);
        await vi.advanceTimersByTimeAsync(0);
        state.onIdentify = () => undefined;
      },
    },
    {
      label: 'a socket that reached READY and dropped',
      arrange: async (plugin) => {
        const ws = await reachReady(plugin, TOPIC);
        state.onIdentify = () => undefined;
        ws.serverClose(1006);
        await vi.advanceTimersByTimeAsync(0);
      },
    },
  ];

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter: nextDialAt is exactly one base rung
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const prior of PRIORS) {
    for (const offset of OFFSETS_MS) {
      for (const initiator of INITIATORS) {
        const when = offset < 0 ? `${-offset}ms before` : `${offset}ms after`;
        it(`${initiator.label} ${when} nextDialAt, after ${prior.label}`, async () => {
          const plugin = await connectPlugin();
          await prior.arrange(plugin);

          const charged = chargesOf(plugin);
          expect(charged, 'no rung was charged, so this cell has no budget to overspend').toBe(1);
          const dialsBefore = instances.length;

          // The clock alone — the ladder's timer keeps its full remaining delay, which is the
          // lateness a real event loop hands it for free.
          vi.setSystemTime(Date.now() + BACKOFF_BASE_MS + offset);
          initiator.start(plugin, TOPIC);
          await vi.advanceTimersByTimeAsync(0);

          expect(
            instances.length,
            'a caller dialed while the ladder still owned the rung it had already charged for',
          ).toBe(dialsBefore);

          await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
          expect(instances.length, 'the ladder never spent the rung it charged for').toBe(
            dialsBefore + 1,
          );
          expect(instances.length, 'sockets opened outran the rungs the ladder paid for').toBe(
            chargesOf(plugin) + 1,
          );

          await plugin.disconnect();
        });
      }
    }
  }
});

describe('Discord IDENTIFY budget, whoever dials', () => {
  const FAILURES: Array<{ label: string; onIdentify: (ws: FakeWs) => void; drive: (ws: FakeWs) => void }> = [
    {
      label: 'close before HELLO',
      onIdentify: (ws) => ws.ready(),
      drive: (ws) => ws.serverClose(1006),
    },
    {
      label: 'close after IDENTIFY (4008)',
      onIdentify: (ws) => ws.serverClose(4008),
      drive: (ws) => ws.hello(HUGE_HB),
    },
    {
      label: 'handshake stalls',
      onIdentify: () => undefined,
      drive: (ws) => ws.hello(HUGE_HB),
    },
  ];

  // Each entry point that can open the shared socket. The long-poll ones matter most: core calls
  // the plugin again every `block_poll_interval_ms` for the WHOLE budget of one tool call.
  const INITIATORS: Array<{ label: string; start: (p: DiscordPlugin, t: Topic) => void }> = [
    {
      label: 'subscribe',
      start: (p, t) => {
        void p.subscribe(t, () => undefined).catch(() => undefined);
      },
    },
    {
      label: 'fetchRecent(blockMs) via core fetchRecentBlocking',
      start: (p, t) => {
        void fetchRecentBlocking(
          p,
          { topic: t, since: asCursor('1') },
          { blockMs: HOUR_MS, pollIntervalMs: 250 },
        ).catch(() => undefined);
      },
    },
    {
      label: 'subscribe + fetchRecent(blockMs) together',
      start: (p, t) => {
        void p.subscribe(t, () => undefined).catch(() => undefined);
        void fetchRecentBlocking(
          p,
          { topic: t, since: asCursor('1') },
          { blockMs: HOUR_MS, pollIntervalMs: 250 },
        ).catch(() => undefined);
      },
    },
  ];

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter: measure the raw floor of the ladder
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const failure of FAILURES) {
    for (const initiator of INITIATORS) {
      it(`${initiator.label} stays under quota when the gateway ${failure.label}`, async () => {
        state.onIdentify = failure.onIdentify;
        const plugin = await connectPlugin();

        initiator.start(plugin, TOPIC);
        await pump(HOUR_MS, failure.drive);

        // A BAND, not a ceiling: a cell that never re-dials satisfies any upper bound, so every
        // transient-failure cell has to prove the ladder ran as well as that it stayed under quota.
        expect(instances.length, 'the ladder never re-dialed, so the ceiling proves nothing')
          .toBeGreaterThan(1);
        expect(instances.length).toBeLessThanOrEqual(dialCeiling(HOUR_MS, RECONNECT_CAP_MS));
        expect(totalIdentifies() * (DAY_MS / HOUR_MS)).toBeLessThan(QUOTA_PER_DAY);

        await plugin.disconnect();
      });
    }
  }

  // The FAILURES axis above is parameterized over how a DIAL fails, so every IDENTIFY it counts is
  // one the ladder charged for. This axis is the other half: what a peer can make an ALREADY-OPEN
  // socket do. The frames cost the peer one send each, so anything the plugin answers with is
  // amplification it pays for out of a 1000-per-24h quota whose overrun RESETS the bot token —
  // and `gateway_url` reaching a peer that is not discord.com is a configuration the plugin only
  // warns about. Keep the axis a table of OPCODES rather than the HELLO that prompted it: the same
  // "peer frame drives an uncharged expensive action" arrives next wearing op 7 or a resume frame.
  describe('a frame on an ESTABLISHED socket buys no IDENTIFY', () => {
    const FLOOD = 500;

    const PEER_FRAMES: Array<{
      label: string;
      frame: (n: number) => Record<string, unknown>;
      /** Whether the socket is expected to outlive the flood — a row that ends it says so. */
      survives: boolean;
    }> = [
      {
        label: 'op 10 HELLO',
        frame: () => ({ op: 10, d: { heartbeat_interval: HUGE_HB } }),
        survives: false,
      },
      { label: 'op 1 HEARTBEAT', frame: () => ({ op: 1, d: null }), survives: true },
      { label: 'op 7 RECONNECT', frame: () => ({ op: 7, d: null }), survives: false },
      { label: 'op 9 INVALID_SESSION', frame: () => ({ op: 9, d: false }), survives: false },
      {
        label: 'op 0 with an unknown t',
        frame: (n) => ({ op: 0, t: 'GUILD_MEMBER_UPDATE', s: n, d: {} }),
        survives: true,
      },
      { label: 'an unknown op', frame: (n) => ({ op: 42, s: n, d: {} }), survives: true },
    ];

    const framesSent = (): number => instances.reduce((n, ws) => n + ws.sent.length, 0);

    // Crossed with WHEN the close lands, because a socket the plugin has closed keeps receiving:
    // real `ws` finishes the close handshake a tick later and delivers whatever is already queued,
    // so under async delivery the peer keeps reaching a listener that has nothing left to do.
    for (const peer of PEER_FRAMES) {
      for (const asyncClose of [false, true]) {
        const delivery = asyncClose ? 'async' : 'inline';
        it(`${FLOOD}x ${peer.label} costs no unbudgeted IDENTIFY (close delivered ${delivery})`, async () => {
          state.asyncClose = asyncClose;
          const diag = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
          const plugin = await connectPlugin();
          const ws = await reachReady(plugin, TOPIC);
          expect(totalIdentifies()).toBe(1); // the handshake's own, and the only one so far
          diag.mockClear();

          for (let n = 0; n < FLOOD; n++) ws.serverSend(peer.frame(n));

          // (a) Every IDENTIFY on the wire is either the first dial or a step the ladder charged
          // for, so the sustained rate is the ladder's whatever the peer sends and however fast.
          expect(
            totalIdentifies(),
            'a peer frame bought an IDENTIFY the ladder never charged for',
          ).toBeLessThanOrEqual(1 + chargesOf(plugin));
          for (const socket of instances) {
            expect(
              socket.sent.filter((f) => f.op === 2).length,
              'one socket IDENTIFYed twice',
            ).toBeLessThanOrEqual(1);
          }
          // (b) …and the answer to N frames is bounded by N, with no IDENTIFY term in the bound.
          expect(framesSent(), 'the peer got back more frames than it sent').toBeLessThanOrEqual(
            FLOOD + instances.length,
          );
          // Each row states what the flood did to the socket, so a row cannot pass by being
          // dropped on the floor: an ignored frame and an ended socket are different answers.
          expect(
            openSockets(),
            `the socket ${peer.survives ? 'died' : 'survived'} the flood`,
          ).toHaveLength(peer.survives ? 1 : 0);
          // stderr answers too: a diagnostic per frame is the same amplification wearing a
          // different sink, and it is the operator's log that gets buried.
          expect(diag.mock.calls.length, 'the flood drove a diagnostic per frame')
            .toBeLessThanOrEqual(instances.length);

          await plugin.disconnect();
        });
      }
    }
  });
});

// The quota Discord enforces is keyed by BOT TOKEN, not by process, and the README tells operators
// to share one token across every bridge instance — so the invariant has to be summed over the
// FLEET. Extrapolating a one-hour COUNT would charge the ladder's one-off ramp 24 times, so each
// cell measures the spacing the ladder settles at and scales THAT to a day.
describe('Discord IDENTIFY budget is per BOT TOKEN, not per process', () => {
  const FLEET_SIZES = [1, 2, 4];

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const dialers of FLEET_SIZES) {
    it(`${dialers} instance(s) on one token stay under ${QUOTA_PER_DAY} IDENTIFYs/day`, async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      state.onIdentify = (ws: FakeWs) => ws.serverClose(1006); // every dial spends an IDENTIFY
      const expectedCap = RECONNECT_CAP_MS * dialers;

      const urls = Array.from({ length: dialers }, (_, i) => `ws://fleet-${i}`);
      const fleet = await Promise.all(
        urls.map(async (url) => {
          const plugin = new DiscordPlugin();
          await plugin.connect({
            token: 't',
            gateway_url: url,
            gateway_dialers: dialers,
            handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
          });
          return plugin;
        }),
      );
      for (const [i, plugin] of fleet.entries()) {
        void plugin.subscribe(asTopic(`88100${i}`), () => undefined).catch(() => undefined);
      }

      const driven = new Set<FakeWs>();
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(expectedCap / 2);
        for (const ws of [...instances]) {
          if (driven.has(ws)) continue;
          driven.add(ws);
          ws.hello(HUGE_HB);
        }
      }

      const steadyState = Math.max(...ladderDelays(setTimeoutSpy.mock.calls, NO_HANDSHAKE_TIMEOUT));
      // The knob is applied by VALUE: ignore `gateway_dialers` and this is RECONNECT_CAP_MS.
      expect(steadyState).toBe(expectedCap);
      // …and the fleet's summed sustained rate is what the token is charged for.
      expect(dialers * (DAY_MS / steadyState)).toBeLessThan(QUOTA_PER_DAY);
      // Every instance actually climbed, so the number above measures a ladder that ran.
      for (const url of urls) {
        expect(instances.filter((ws) => dialedBase(ws.url) === url).length).toBeGreaterThan(1);
      }

      await Promise.all(fleet.map((p) => p.disconnect()));
    });
  }

  const BAD_DIALERS = [0, -1, 1.5];
  for (const value of BAD_DIALERS) {
    it(`gateway_dialers ${value} is refused at connect`, async () => {
      const plugin = new DiscordPlugin();
      await expect(
        plugin.connect({ token: 't', gateway_url: 'ws://fake', gateway_dialers: value }),
      ).rejects.toThrow(/gateway_dialers/);
    });
  }
});

let dispatchSeq = 0;
const messageCreate = (topic: Topic, content: string): Record<string, unknown> => ({
  op: 0,
  t: 'MESSAGE_CREATE',
  s: ++dispatchSeq,
  d: {
    id: String(900_000 + dispatchSeq),
    channel_id: topic as string,
    content,
    timestamp: '',
    author: { id: '1', username: 'u' },
  },
});

describe('Discord session state does not leak across a connect/disconnect cycle', () => {
  const OLD_URL = 'ws://old';
  const NEW_URL = 'ws://new';
  const LATE_TOPIC = asTopic('880002');
  /** Comfortably past the ladder's first rung (1s) plus its full jitter spread (1s). */
  const LADDER_STEP_MS = 2100;

  let rest: FetchStub;

  beforeEach(() => {
    resetGateway();
    rest = stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const openTo = async (plugin: DiscordPlugin, url: string): Promise<void> => {
    await plugin.connect({ token: 't', gateway_url: url, handshake_timeout_ms: HANDSHAKE_MS });
  };

  const subscribed = (plugin: DiscordPlugin, topic: Topic, sink: string[]): Promise<FakeWs> =>
    reachReady(plugin, topic, { handler: (m) => sink.push(m.content) });

  const waitersOf = (plugin: DiscordPlugin): Map<string, Set<() => void>> =>
    probe(plugin, 'waiters');

  // WHICH call retires the first session. `connect()` is documented as starting the NEXT session, so
  // it owes the same teardown `disconnect()` does — a socket left dispatching while `live` reads
  // false degrades every later native long-poll to an immediate return, silently and for good.
  const TRANSITIONS: Array<{ label: string; retire: (p: DiscordPlugin) => Promise<void> }> = [
    { label: 'disconnect() then connect()', retire: (p) => p.disconnect() },
    { label: 'connect() alone', retire: async () => undefined },
  ];

  // Each scenario leaves the FIRST session in a different state before it is torn down; none of
  // them may reach into the second one. Crossed with WHEN that state's socket event is delivered:
  // real `ws` emits `close` a tick after the call that caused it, so an event from the old session
  // can land after connect() has already opened the new one.
  const SCENARIOS: Array<{ label: string; first: (p: DiscordPlugin, ws: FakeWs) => Promise<void> }> = [
    {
      label: 'a reconnect was pending',
      first: async (_p, ws) => {
        ws.serverClose(1006);
      },
    },
    {
      label: 'the socket was healthy',
      first: async () => undefined,
    },
    {
      label: 'a long-poll was in flight',
      first: async (p) => {
        void p
          .fetchRecent({ topic: TOPIC, since: asCursor('1'), blockMs: 30_000 })
          .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(10);
      },
    },
    {
      label: 'the backoff ladder had climbed',
      first: async (_p, ws) => {
        state.onIdentify = () => undefined;
        ws.serverClose(1006);
        await vi.advanceTimersByTimeAsync(120_000);
      },
    },
    {
      label: 'a terminal close was in flight',
      first: async (_p, ws) => {
        ws.serverClose(4004);
      },
    },
    {
      label: 'a late HELLO was in flight',
      first: async (_p, ws) => {
        ws.hello(1000);
      },
    },
    {
      label: 'a late MESSAGE_CREATE was in flight',
      first: async (_p, ws) => {
        ws.serverSend(messageCreate(TOPIC, 'stale'));
      },
    },
  ];

  for (const scenario of SCENARIOS) {
    for (const asyncClose of [false, true]) {
      for (const transition of TRANSITIONS) {
        it(`a second session is unaffected when ${scenario.label}, via ${transition.label} (close delivered ${
          asyncClose ? 'async' : 'inline'
        })`, async () => {
          state.asyncClose = asyncClose;
          const plugin = new DiscordPlugin();
          const firstSink: string[] = [];
          await openTo(plugin, OLD_URL);
          const ws0 = await subscribed(plugin, TOPIC, firstSink);
          await scenario.first(plugin, ws0);

          await transition.retire(plugin);
          state.onIdentify = (ws: FakeWs) => ws.ready();
          const opened = instances.length;
          await openTo(plugin, NEW_URL);
          // Under async delivery the ONE pending timer is the fake's own deferred close event, so
          // only the inline mode can read the count as "what the plugin left behind".
          if (!asyncClose) {
            expect(vi.getTimerCount(), 'a timer outlived the first session').toBe(0);
          }

          const secondSink: string[] = [];
          // A DIFFERENT topic, so that the second subscription cannot mask a surviving first-session
          // entry by overwriting it — same-topic re-subscription hides the whole class.
          const ws1 = await subscribed(plugin, LATE_TOPIC, secondSink);
          const deliveredToFirst = firstSink.length;
          await vi.advanceTimersByTimeAsync(300_000);

          // Nothing from the first session may dial, IDENTIFY, or dispatch into the second one.
          expect(instances.slice(opened).map((ws) => dialedBase(ws.url))).toEqual([NEW_URL]);
          expect(openSockets()).toHaveLength(1);
          expect(dialedBase(openSockets()[0]!.url)).toBe(NEW_URL);

          // Usable, not merely un-dialed: the second session's own subscription must carry push,
          // while the torn-down session's handler must be unreachable — a registry that survived
          // the transition pushes live traffic into a consumer that is gone.
          ws1.serverSend(messageCreate(TOPIC, 'to-the-dead-session'));
          ws1.serverSend(messageCreate(LATE_TOPIC, 'to-the-live-session'));
          expect(firstSink).toHaveLength(deliveredToFirst);
          expect(secondSink).toEqual(['to-the-live-session']);

          // The new session's socket has to be LIVE, not merely open: a blocking fetch that arms no
          // waiter returns instantly for the rest of the process, which every assertion above misses.
          const blocked = plugin
            .fetchRecent({ topic: LATE_TOPIC, since: asCursor('1'), blockMs: 30_000 })
            .catch(() => undefined);
          await vi.advanceTimersByTimeAsync(10);
          expect(waitersOf(plugin).size, 'the long-poll armed no waiter, so it never waits').toBe(1);

          await plugin.disconnect();
          await blocked;
          await vi.advanceTimersByTimeAsync(1); // deliver the fake's own deferred close event
          expect(openSockets()).toHaveLength(0);
          expect(vi.getTimerCount()).toBe(0); // no interval, watchdog or reconnect outlives teardown
        });
      }
    }
  }

  // Every cell ABOVE pins `gateway_url`, which skips `GET /gateway/bot` — and with it the await the
  // PRODUCTION dial runs between "this session is alive" and "a socket exists". Nothing in this
  // package reached that window, so a dial released after its session was torn down could open a
  // real gateway session, spend an IDENTIFY against the 1000/24h per-token quota, install itself as
  // the plugin's socket and register a heartbeat interval no teardown would ever clear — with the
  // suite fully green. This table is that window.
  //
  // Crossed with WHICH CALL SITE started the dial, because the first dial and the reconnect ladder
  // reach it independently, and with WHAT ENDED the session, because `disconnect()` leaves the epoch
  // alone while `connect()` leaves `stopped` false — a guard that reads only one of the two passes
  // exactly half of this table. The url source cannot vary here: a configured `gateway_url` has no
  // lookup to park, which is precisely the blind spot.
  const PARKED_DIALS: Array<{ label: string; park: (plugin: DiscordPlugin) => Promise<void> }> = [
    {
      label: 'the first dial',
      park: async (plugin) => {
        rest.holdNextGatewayUrl();
        void plugin.subscribe(TOPIC, () => undefined).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(5);
      },
    },
    {
      label: 'a reconnect-ladder dial',
      park: async (plugin) => {
        const ws0 = await reachReady(plugin, TOPIC);
        rest.holdNextGatewayUrl();
        ws0.serverClose(1006);
        await vi.advanceTimersByTimeAsync(LADDER_STEP_MS);
      },
    },
  ];

  const RETIREMENTS: Array<{
    label: string;
    retire: (p: DiscordPlugin) => Promise<void>;
    reopened: boolean;
  }> = [
    { label: 'disconnect()', retire: (p) => p.disconnect(), reopened: false },
    {
      label: 'disconnect() then connect()',
      retire: async (p) => {
        await p.disconnect();
        await openTo(p, NEW_URL);
      },
      reopened: true,
    },
    { label: 'connect() alone', retire: (p) => openTo(p, NEW_URL), reopened: true },
  ];

  for (const dial of PARKED_DIALS) {
    for (const retirement of RETIREMENTS) {
      it(`${dial.label}, parked in GET /gateway/bot, cannot outlive ${retirement.label}`, async () => {
        rest.gatewayUrl = OLD_URL;
        const plugin = new DiscordPlugin();
        await plugin.connect({ token: 't', handshake_timeout_ms: HANDSHAKE_MS });
        await dial.park(plugin);
        expect(rest.parked(), 'no dial is parked, so this cell measures nothing').toBe(1);

        const socketsAtRetire = instances.length;
        const identifiesAtRetire = totalIdentifies();
        const lookupsAtRetire = rest.count('/gateway/bot');
        await retirement.retire(plugin);

        rest.release();
        await vi.advanceTimersByTimeAsync(300_000);

        expect(
          instances.length,
          'the retired session opened a gateway socket after its teardown',
        ).toBe(socketsAtRetire);
        expect(
          rest.count('/gateway/bot') - lookupsAtRetire,
          'the retired session kept resolving gateway urls after its teardown',
        ).toBe(0);
        expect(
          totalIdentifies(),
          'the retired session spent an IDENTIFY after its teardown',
        ).toBe(identifiesAtRetire);
        expect(
          openSockets().filter((ws) => dialedBase(ws.url) === OLD_URL),
          'a socket from the retired session is still open',
        ).toHaveLength(0);

        // Usable, not merely un-dialed: a guard that refused every later dial would satisfy the
        // counts above and leave the NEXT session with no live push at all.
        if (retirement.reopened) {
          const sink: string[] = [];
          const ws1 = await subscribed(plugin, LATE_TOPIC, sink);
          expect(dialedBase(ws1.url)).toBe(NEW_URL);
          ws1.serverSend(messageCreate(LATE_TOPIC, 'to-the-live-session'));
          expect(sink).toEqual(['to-the-live-session']);
        }

        await plugin.disconnect();
        await vi.advanceTimersByTimeAsync(1);
        expect(openSockets()).toHaveLength(0);
        expect(vi.getTimerCount(), 'a timer outlived teardown').toBe(0);
      });
    }
  }

  it('a heartbeat belongs to its own socket, never to whichever socket is current', async () => {
    const HB = 10_000;
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: OLD_URL, handshake_timeout_ms: HANDSHAKE_MS });
    const pending = plugin.subscribe(TOPIC, () => undefined);
    const ws0 = instances.at(-1)!;
    ws0.hello(HB);
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    // A socket the plugin has moved on from (here: a stale handle the test kept) must not be able
    // to touch the live socket's heartbeat by receiving a late HELLO.
    await plugin.disconnect();
    await plugin.connect({ token: 't', gateway_url: NEW_URL, handshake_timeout_ms: HANDSHAKE_MS });
    const pending2 = plugin.subscribe(TOPIC, () => undefined);
    const ws1 = instances.at(-1)!;
    ws1.hello(HB);
    await vi.advanceTimersByTimeAsync(0);
    await pending2;

    ws0.readyState = FakeWs.OPEN; // resurrect the orphan exactly as a late close-race would
    ws0.hello(HB);
    await vi.advanceTimersByTimeAsync(HB * 3);

    expect(ws1.heartbeatsSent()).toBeGreaterThanOrEqual(2); // the live socket kept beating
    expect(ws1.terminated).toBe(false);
    expect(ws0.identified()).toBe(true); // it identified in ITS session…
    expect(ws0.sent.filter((f) => f.op === 2)).toHaveLength(1); // …and never again

    await plugin.disconnect();
  });
});
