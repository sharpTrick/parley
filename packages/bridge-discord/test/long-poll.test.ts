import { asCursor, asTopic, fetchRecentBlocking } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A `block_ms` fetch may only WAIT on the gateway while the gateway can actually wake it. In every
// other transport state the plugin has to hand back its immediate page so core's poll fallback
// owns the wait — otherwise one tool call sleeps its whole budget on a socket that cannot deliver,
// on a backend whose REST half is perfectly healthy. The table below is over that transport state.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import { FakeWs, instances, resetGateway, state } from './fake-gateway.js';

const TOPIC = asTopic('770001');
const SINCE = asCursor('1');
const BLOCK_MS = 60_000;
const POLL_MS = 250;
const HANDSHAKE_MS = 500;
const ARRIVES_AT_MS = 1000;
/** The message must surface within a poll cycle or two of becoming visible — never at `blockMs`. */
const SLACK_MS = 2000;
const HUGE_HB = 1_000_000;

const MESSAGE = {
  id: '900000000000000009',
  channel_id: TOPIC as string,
  content: 'fresh',
  timestamp: '2026-01-01T00:00:00.000Z',
  author: { id: '5', username: 'human' },
};

describe('Discord long-poll while the live transport is…', () => {
  let visible = false;

  /** REST is healthy throughout: it simply starts returning the message once it has landed. */
  const stubFetch = (): void => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify(visible ? [MESSAGE] : []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  };

  const reachReady = async (plugin: DiscordPlugin): Promise<FakeWs> => {
    const pending = plugin.subscribe(TOPIC, () => undefined);
    const ws = instances.at(-1)!;
    ws.hello(HUGE_HB);
    // Keep this ahead of `await pending`, so that subscribe's channel check can read its stubbed
    // REST body: under fake timers a faked immediate drives the body stream.
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    return ws;
  };

  const TRANSPORTS: Array<{
    label: string;
    setup: (plugin: DiscordPlugin) => Promise<void>;
    /** Applied to every socket opened AFTER setup — a gateway that is not coming back stays mute. */
    driveNew: (ws: FakeWs) => void;
  }> = [
    {
      label: 'healthy',
      setup: async (plugin) => {
        await reachReady(plugin);
      },
      driveNew: (ws) => ws.hello(HUGE_HB),
    },
    {
      label: 'closed and reconnecting',
      setup: async (plugin) => {
        const ws = await reachReady(plugin);
        state.onIdentify = () => undefined;
        ws.serverClose(1006);
      },
      driveNew: () => undefined,
    },
    {
      label: 'handshake stalled',
      setup: async () => {
        state.onIdentify = () => undefined;
      },
      driveNew: (ws) => ws.hello(HUGE_HB),
    },
    {
      label: 'terminally closed',
      setup: async (plugin) => {
        const ws = await reachReady(plugin);
        ws.serverClose(4014);
      },
      driveNew: () => undefined,
    },
    {
      label: 'never opened',
      setup: async () => {
        state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
      },
      driveNew: (ws) => ws.hello(HUGE_HB),
    },
  ];

  beforeEach(() => {
    resetGateway();
    visible = false;
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const transport of TRANSPORTS) {
    it(`${transport.label}: a message visible at ${ARRIVES_AT_MS}ms is returned promptly`, async () => {
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: HANDSHAKE_MS,
      });
      await transport.setup(plugin);

      const driven = new Set(instances);
      const started = Date.now();
      let settledAt: number | undefined;
      const pending = fetchRecentBlocking(
        plugin,
        { topic: TOPIC, since: SINCE },
        { blockMs: BLOCK_MS, pollIntervalMs: POLL_MS },
      ).then((r) => {
        settledAt = Date.now();
        return r;
      });

      for (let t = 0; t < BLOCK_MS && settledAt === undefined; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
        if (!visible && Date.now() - started >= ARRIVES_AT_MS) {
          visible = true;
          // A real arrival is BOTH: durable over REST and, when a socket is live, a dispatch.
          const live = instances.find((ws) => ws.readyState === FakeWs.OPEN && ws.identified());
          live?.serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: MESSAGE });
        }
        for (const ws of [...instances]) {
          if (driven.has(ws)) continue;
          driven.add(ws);
          transport.driveNew(ws);
        }
      }

      const result = await pending;
      expect(result.messages.map((m) => m.content)).toEqual(['fresh']);
      expect(settledAt! - started).toBeLessThanOrEqual(ARRIVES_AT_MS + SLACK_MS);

      await plugin.disconnect();
    });
  }
});

// The table above can only ever describe the transport at CALL START. A socket that dies while a
// waiter is already armed is the same defect one tick later, and nothing else can wake that waiter:
// the message is durable over a healthy REST API while the call sleeps its whole budget.

describe('Discord long-poll when the live transport dies mid-wait', () => {
  let visible = false;

  const stubFetch = (): void => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify(visible ? [MESSAGE] : []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  };

  const LOSSES: Array<{ label: string; kill: (ws: FakeWs) => void; driveNew: (ws: FakeWs) => void }> =
    [
      {
        label: 'a transient close whose reconnect stalls',
        kill: (ws) => {
          state.onIdentify = () => undefined;
          ws.serverClose(1006);
        },
        driveNew: () => undefined,
      },
      {
        label: 'a transient close that reconnects cleanly',
        kill: (ws) => ws.serverClose(1006),
        driveNew: (ws) => ws.hello(HUGE_HB),
      },
      {
        label: 'a terminal close (4014)',
        kill: (ws) => ws.serverClose(4014),
        driveNew: () => undefined,
      },
    ];

  /** When the socket dies, relative to the start of the blocking call. */
  const LOST_AT_MS = [10, 600];

  beforeEach(() => {
    resetGateway();
    visible = false;
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const loss of LOSSES) {
    for (const lostAt of LOST_AT_MS) {
      it(`${loss.label} at ${lostAt}ms still returns a ${ARRIVES_AT_MS}ms message promptly`, async () => {
        const plugin = new DiscordPlugin();
        await plugin.connect({
          token: 't',
          gateway_url: 'ws://fake',
          handshake_timeout_ms: HANDSHAKE_MS,
        });
        const pendingSub = plugin.subscribe(TOPIC, () => undefined);
        const first = instances.at(-1)!;
        first.hello(HUGE_HB);
        await vi.advanceTimersByTimeAsync(0);
        await pendingSub;

        const driven = new Set(instances);
        const started = Date.now();
        let settledAt: number | undefined;
        let killed = false;
        const pending = fetchRecentBlocking(
          plugin,
          { topic: TOPIC, since: SINCE },
          { blockMs: BLOCK_MS, pollIntervalMs: POLL_MS },
        ).then((r) => {
          settledAt = Date.now();
          return r;
        });

        for (let t = 0; t < BLOCK_MS && settledAt === undefined; t += 10) {
          await vi.advanceTimersByTimeAsync(10);
          const elapsed = Date.now() - started;
          if (!killed && elapsed >= lostAt) {
            killed = true;
            loss.kill(first);
          }
          if (!visible && elapsed >= ARRIVES_AT_MS) {
            visible = true;
            const live = instances.find((ws) => ws.readyState === FakeWs.OPEN && ws.identified());
            live?.serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: MESSAGE });
          }
          for (const ws of [...instances]) {
            if (driven.has(ws)) continue;
            driven.add(ws);
            loss.driveNew(ws);
          }
        }

        const result = await pending;
        expect(result.messages.map((m) => m.content)).toEqual(['fresh']);
        expect(settledAt! - started).toBeLessThanOrEqual(ARRIVES_AT_MS + SLACK_MS);

        await plugin.disconnect();
      });
    }
  }
});

// The waiter exists to be armed BEFORE the first REST query and released on disconnect. Both are
// invisible to a table over transport state: every row there is satisfied by core's 250 ms poll
// fallback. These drive the plugin's own blocking call, where nothing else can re-query, and pin
// the phase at which the wakeup lands.

describe('Discord long-poll: a wakeup arriving', () => {
  /** A prompt wakeup settles in a handful of ticks; sleeping the budget settles at BLOCK_MS. */
  const WAKE_SLACK_MS = 500;

  let visible = false;
  let held: Array<() => void> = [];
  let holdNextGet = false;

  const stubFetch = (): void => {
    vi.stubGlobal('fetch', () => {
      // Snapshot at REQUEST time: a held query answers the page it read, not one taken later.
      const body = JSON.stringify(visible ? [MESSAGE] : []);
      const reply = (): Response =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      if (holdNextGet) {
        holdNextGet = false;
        return new Promise<Response>((resolve) => held.push(() => resolve(reply())));
      }
      return Promise.resolve(reply());
    });
  };

  const reachReady = async (plugin: DiscordPlugin): Promise<FakeWs> => {
    const pending = plugin.subscribe(TOPIC, () => undefined);
    const ws = instances.at(-1)!;
    ws.hello(HUGE_HB);
    // Keep this ahead of `await pending`, so that subscribe's channel check can read its stubbed
    // REST body: under fake timers a faked immediate drives the body stream.
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    return ws;
  };

  const arrive = (ws?: FakeWs): void => {
    visible = true;
    if (ws !== undefined && ws.readyState === FakeWs.OPEN && ws.identified()) {
      ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: MESSAGE });
    }
  };

  const PHASES: Array<{ label: string; drive: (p: DiscordPlugin, call: () => void) => Promise<void> }> =
    [
      {
        label: 'before the call',
        drive: async (p, call) => {
          const ws = await reachReady(p);
          arrive(ws);
          call();
          await vi.advanceTimersByTimeAsync(50);
        },
      },
      {
        label: 'while the gateway handshake is still completing',
        drive: async (p, call) => {
          state.onIdentify = () => undefined;
          call();
          await vi.advanceTimersByTimeAsync(10);
          const ws = instances.at(-1)!;
          ws.hello(HUGE_HB);
          await vi.advanceTimersByTimeAsync(10);
          arrive(undefined);
          state.onIdentify = (s: FakeWs) => s.ready();
          ws.hello(HUGE_HB);
          await vi.advanceTimersByTimeAsync(50);
        },
      },
      {
        label: 'during the first REST query',
        drive: async (p, call) => {
          const ws = await reachReady(p);
          holdNextGet = true;
          call();
          await vi.advanceTimersByTimeAsync(10);
          expect(held).toHaveLength(1);
          arrive(ws);
          held.shift()!();
          await vi.advanceTimersByTimeAsync(50);
        },
      },
      {
        label: 'after the first REST query',
        drive: async (p, call) => {
          const ws = await reachReady(p);
          call();
          await vi.advanceTimersByTimeAsync(10);
          arrive(ws);
          await vi.advanceTimersByTimeAsync(50);
        },
      },
    ];

  beforeEach(() => {
    resetGateway();
    visible = false;
    held = [];
    holdNextGet = false;
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const phase of PHASES) {
    it(`${phase.label} is not lost`, async () => {
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: HANDSHAKE_MS,
      });

      const started = Date.now();
      let settledAt: number | undefined;
      let pending: Promise<{ messages: Array<{ content: string }> }> | undefined;
      const call = (): void => {
        pending = plugin
          .fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS })
          .then((r) => {
            settledAt = Date.now();
            return r;
          });
      };

      await phase.drive(plugin, call);

      expect(settledAt, 'the call is still blocked, so the wakeup was lost').toBeDefined();
      expect((await pending!).messages.map((m) => m.content)).toEqual(['fresh']);
      expect(settledAt! - started).toBeLessThan(WAKE_SLACK_MS);

      await plugin.disconnect();
    });
  }

  it('nothing arriving settles at blockMs with a replayable cursor', async () => {
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: HANDSHAKE_MS,
    });
    await reachReady(plugin);

    const started = Date.now();
    let settledAt: number | undefined;
    const pending = plugin
      .fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS })
      .then((r) => {
        settledAt = Date.now();
        return r;
      });

    await vi.advanceTimersByTimeAsync(BLOCK_MS - 1);
    expect(settledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);

    const result = await pending;
    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBe(SINCE);
    expect(settledAt! - started).toBeLessThanOrEqual(BLOCK_MS + 1);

    await plugin.disconnect();
  });

  // Real `ws` delivers `close` a tick after the call that caused it, so `disconnect()` returns with
  // the socket's own teardown still pending. Both deliveries have to release the same waiter.
  for (const asyncClose of [false, true]) {
   it(`disconnect() releases an in-flight long-poll (close delivered ${asyncClose ? 'async' : 'inline'})`, async () => {
    state.asyncClose = asyncClose;
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: HANDSHAKE_MS,
    });
    await reachReady(plugin);

    const started = Date.now();
    let settledAt: number | undefined;
    const pending = plugin
      .fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS })
      .then((r) => {
        settledAt = Date.now();
        return r;
      });
    await vi.advanceTimersByTimeAsync(10);
    const waiters = (plugin as unknown as { waiters: Map<string, Set<() => void>> }).waiters;
    expect(waiters.size, 'nothing was armed, so the teardown below proves nothing').toBe(1);

    await plugin.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(settledAt, 'the blocked call outlived disconnect()').toBeDefined();
    expect(settledAt! - started).toBeLessThan(WAKE_SLACK_MS);
    expect(vi.getTimerCount(), 'a waiter timer outlived teardown').toBe(0);
    expect((await pending).messages).toEqual([]);
   });
  }
});
