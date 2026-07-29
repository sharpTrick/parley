import { asCursor, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Discord allows 1000 IDENTIFYs per 24h and penalizes an overrun by RESETTING the bot token, so
// the dial rate has to hold under EVERY initiator, not just the reconnect loop the backoff ladder
// was written for. These cases drive each entry point that can reach the gateway against each way
// a dial can fail, and assert the same quota invariant for every cell.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import {
  FakeWs,
  instances,
  openSockets,
  resetGateway,
  state,
  totalIdentifies,
} from './fake-gateway.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const QUOTA_PER_DAY = 1000;
/** Headroom over the steady-state rate the {@link RECONNECT_CAP_MS} ladder settles at. */
const MAX_SOCKETS_PER_HOUR = 42;
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

        expect(instances.length).toBeLessThanOrEqual(MAX_SOCKETS_PER_HOUR);
        expect(totalIdentifies() * (DAY_MS / HOUR_MS)).toBeLessThan(QUOTA_PER_DAY);

        await plugin.disconnect();
      });
    }
  }
});

describe('Discord session state does not leak across a connect/disconnect cycle', () => {
  const OLD_URL = 'ws://old';
  const NEW_URL = 'ws://new';

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const session = async (plugin: DiscordPlugin, url: string): Promise<FakeWs> => {
    await plugin.connect({ token: 't', gateway_url: url, handshake_timeout_ms: HANDSHAKE_MS });
    const pending = plugin.subscribe(TOPIC, () => undefined);
    const ws = instances.at(-1)!;
    ws.hello(HUGE_HB);
    await pending;
    return ws;
  };

  // Each scenario leaves the FIRST session in a different state before it is torn down; none of
  // them may reach into the second one.
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
  ];

  for (const scenario of SCENARIOS) {
    it(`a second session is unaffected when ${scenario.label}`, async () => {
      const plugin = new DiscordPlugin();
      const ws0 = await session(plugin, OLD_URL);
      await scenario.first(plugin, ws0);
      await plugin.disconnect();

      state.onIdentify = (ws: FakeWs) => ws.ready();
      const opened = instances.length;
      await session(plugin, NEW_URL);
      await vi.advanceTimersByTimeAsync(300_000);

      // Nothing from the first session may dial, IDENTIFY, or dispatch into the second one.
      expect(instances.slice(opened).map((ws) => ws.url)).toEqual([NEW_URL]);
      expect(openSockets()).toHaveLength(1);
      expect(openSockets()[0]!.url).toBe(NEW_URL);

      await plugin.disconnect();
      expect(openSockets()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0); // no interval, watchdog or reconnect outlives teardown
    });
  }

  it('a heartbeat belongs to its own socket, never to whichever socket is current', async () => {
    const HB = 10_000;
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: OLD_URL, handshake_timeout_ms: HANDSHAKE_MS });
    const pending = plugin.subscribe(TOPIC, () => undefined);
    const ws0 = instances.at(-1)!;
    ws0.hello(HB);
    await pending;

    // A socket the plugin has moved on from (here: a stale handle the test kept) must not be able
    // to touch the live socket's heartbeat by receiving a late HELLO.
    await plugin.disconnect();
    await plugin.connect({ token: 't', gateway_url: NEW_URL, handshake_timeout_ms: HANDSHAKE_MS });
    const pending2 = plugin.subscribe(TOPIC, () => undefined);
    const ws1 = instances.at(-1)!;
    ws1.hello(HB);
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
