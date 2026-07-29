import { asCursor, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Discord allows 1000 IDENTIFYs per 24h and penalizes an overrun by RESETTING the bot token, so
// the dial rate has to hold under EVERY initiator, not just the reconnect loop the backoff ladder
// was written for. These cases drive each entry point that can reach the gateway against each way
// a dial can fail, and assert the same quota invariant for every cell.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin, RECONNECT_CAP_MS } from '../src/index.js';
import {
  FakeWs,
  instances,
  openSockets,
  resetGateway,
  state,
  totalIdentifies,
} from './fake-gateway.js';
import { dialCeiling, ladderDelays } from './ladder.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const QUOTA_PER_DAY = 1000;
const HUGE_HB = 1_000_000;
const HANDSHAKE_MS = 10_000;
const TOPIC = asTopic('880001');

/** Every REST call answers an empty page: these cases are about dials, not messages. */
const stubFetch = (): void => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
};

const connectPlugin = async (): Promise<DiscordPlugin> => {
  const plugin = new DiscordPlugin();
  await plugin.connect({
    token: 't',
    gateway_url: 'ws://fake',
    handshake_timeout_ms: HANDSHAKE_MS,
  });
  return plugin;
};

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
});

// The quota Discord enforces is keyed by BOT TOKEN, not by process, and the README tells operators
// to share one token across every bridge instance — so the invariant has to be summed over the
// FLEET. Extrapolating a one-hour COUNT would charge the ladder's one-off ramp 24 times, so each
// cell measures the spacing the ladder settles at and scales THAT to a day.
describe('Discord IDENTIFY budget is per BOT TOKEN, not per process', () => {
  const FLEET_SIZES = [1, 2, 4];
  /** Far enough out that it is never a reconnect delay, so {@link ladderDelays} can drop it. */
  const NO_HANDSHAKE_TIMEOUT = 10_000_000;

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
        expect(instances.filter((ws) => ws.url === url).length).toBeGreaterThan(1);
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

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const session = async (
    plugin: DiscordPlugin,
    url: string,
    topic: Topic,
    sink: string[],
  ): Promise<FakeWs> => {
    await plugin.connect({ token: 't', gateway_url: url, handshake_timeout_ms: HANDSHAKE_MS });
    const pending = plugin.subscribe(topic, (m) => sink.push(m.content));
    const ws = instances.at(-1)!;
    ws.hello(HUGE_HB);
    // Keep this ahead of `await pending`, so that subscribe's channel check can read its stubbed
    // REST body: under fake timers a faked immediate drives the body stream.
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    return ws;
  };

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
      it(`a second session is unaffected when ${scenario.label} (close delivered ${
        asyncClose ? 'async' : 'inline'
      })`, async () => {
        state.asyncClose = asyncClose;
        const plugin = new DiscordPlugin();
        const firstSink: string[] = [];
        const ws0 = await session(plugin, OLD_URL, TOPIC, firstSink);
        await scenario.first(plugin, ws0);
        await plugin.disconnect();
        // Under async delivery the ONE pending timer is the fake's own deferred close event, so
        // only the inline mode can read the count as "what the plugin left behind".
        if (!asyncClose) {
          expect(vi.getTimerCount(), 'a timer outlived the first teardown').toBe(0);
        }

        state.onIdentify = (ws: FakeWs) => ws.ready();
        const opened = instances.length;
        const secondSink: string[] = [];
        // A DIFFERENT topic, so that the second subscription cannot mask a surviving first-session
        // entry by overwriting it — same-topic re-subscription hides the whole class.
        const ws1 = await session(plugin, NEW_URL, LATE_TOPIC, secondSink);
        const deliveredToFirst = firstSink.length;
        await vi.advanceTimersByTimeAsync(300_000);

        // Nothing from the first session may dial, IDENTIFY, or dispatch into the second one.
        expect(instances.slice(opened).map((ws) => ws.url)).toEqual([NEW_URL]);
        expect(openSockets()).toHaveLength(1);
        expect(openSockets()[0]!.url).toBe(NEW_URL);

        // Usable, not merely un-dialed: the second session's own subscription must carry push,
        // while the torn-down session's handler must be unreachable — a registry that survived
        // disconnect() pushes live traffic into a consumer that is gone.
        ws1.serverSend(messageCreate(TOPIC, 'to-the-dead-session'));
        ws1.serverSend(messageCreate(LATE_TOPIC, 'to-the-live-session'));
        expect(firstSink).toHaveLength(deliveredToFirst);
        expect(secondSink).toEqual(['to-the-live-session']);

        await plugin.disconnect();
        await vi.advanceTimersByTimeAsync(1); // deliver the fake's own deferred close event
        expect(openSockets()).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0); // no interval, watchdog or reconnect outlives teardown
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
