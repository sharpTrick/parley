import { asCursor, asTopic, fetchRecentBlocking } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CLASS: a plugin-level table whose assertions are satisfied by a core-level fallback. Every cell
// here that is about the PLUGIN's waiter drives `plugin.fetchRecent` DIRECTLY, because core's
// `fetchRecentBlocking` re-queries every 250 ms and therefore returns the message whether or not
// the plugin ever armed a waiter — a table routed through it stays green with the whole native
// long-poll deleted. One wrapper cell is kept at the bottom, and it says which layer it can see.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import { FakeWs, instances, resetGateway, state } from './fake-gateway.js';
import { HUGE_HB, reachReady, stubFetch, type FetchStub } from './harness.js';

const TOPIC = asTopic('770001');
const SINCE = asCursor('1');
const BLOCK_MS = 60_000;
const POLL_MS = 250;
const HANDSHAKE_MS = 500;
const ARRIVES_AT_MS = 1000;
/** A prompt settle is a handful of ticks; sleeping the budget settles at BLOCK_MS. */
const WAKE_SLACK_MS = 500;
/** The longest a call may take to notice the gateway cannot wake it — the handshake watchdog. */
const DEAD_SETTLE_MS = HANDSHAKE_MS + WAKE_SLACK_MS;
/** The message must surface within a poll cycle or two of becoming visible — never at `blockMs`. */
const SLACK_MS = 2000;

const MESSAGE = {
  id: '900000000000000009',
  channel_id: TOPIC as string,
  content: 'fresh',
  timestamp: '2026-01-01T00:00:00.000Z',
  author: { id: '5', username: 'human' },
};

const connect = async (): Promise<DiscordPlugin> => {
  const plugin = new DiscordPlugin();
  await plugin.connect({ token: 't', gateway_url: 'ws://fake', handshake_timeout_ms: HANDSHAKE_MS });
  return plugin;
};

/** The waiters the plugin has armed — a cell that armed none proves nothing about releasing one. */
const armedWaiters = (plugin: DiscordPlugin): number =>
  (plugin as unknown as { waiters: Map<string, unknown> }).waiters.size;

describe('a native blocking fetchRecent on a gateway that cannot wake it', () => {
  // A `block_ms` fetch may only WAIT while a LIVE socket can deliver MESSAGE_CREATE. In every other
  // transport state the plugin owes its immediate page so core's poll fallback owns the wait —
  // otherwise one tool call sleeps its whole budget on a socket that cannot deliver, on a backend
  // whose REST half is perfectly healthy.
  let rest: FetchStub;

  const DEAD: Array<{
    label: string;
    setup: (plugin: DiscordPlugin) => Promise<void>;
    /** Applied to every socket opened AFTER setup — a gateway that is not coming back stays mute. */
    driveNew: (ws: FakeWs) => void;
  }> = [
    {
      label: 'closed and reconnecting',
      setup: async (plugin) => {
        const ws = await reachReady(plugin, TOPIC);
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
        const ws = await reachReady(plugin, TOPIC);
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
    rest = stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const transport of DEAD) {
    it(`${transport.label}: the call hands its empty page back instead of sleeping`, async () => {
      const plugin = await connect();
      await transport.setup(plugin);

      const driven = new Set(instances);
      const started = Date.now();
      let settledAt: number | undefined;
      const pending = plugin
        .fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS })
        .then((r) => {
          settledAt = Date.now();
          return r;
        });

      for (let t = 0; t < BLOCK_MS && settledAt === undefined; t += 10) {
        await vi.advanceTimersByTimeAsync(10);
        for (const ws of [...instances]) {
          if (driven.has(ws)) continue;
          driven.add(ws);
          transport.driveNew(ws);
        }
      }

      const result = await pending;
      expect(result.messages).toEqual([]);
      expect(result.nextCursor, 'the cursor must stay replayable').toBe(SINCE);
      expect(armedWaiters(plugin), 'a waiter was armed on a socket that cannot fire it').toBe(0);
      expect(
        settledAt! - started,
        'the call slept its budget on a gateway that could never wake it',
      ).toBeLessThanOrEqual(DEAD_SETTLE_MS);
      expect(rest.count('/messages'), 'the immediate REST page was never fetched').toBeGreaterThan(0);

      await plugin.disconnect();
    });
  }
});

describe('a native blocking fetchRecent whose socket dies mid-wait', () => {
  // The table above can only ever describe the transport at CALL START. A socket that dies while a
  // waiter is already armed is the same defect one tick later, and only the plugin can notice: the
  // socket that would have woken the waiter is the one that went away.
  let rest: FetchStub;

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

  /** When the socket dies, relative to the start of the blocking call: inside the first REST
   *  query's turn, and long after the waiter is armed. */
  const LOST_AT_MS = [10, 600];

  beforeEach(() => {
    resetGateway();
    rest = stubFetch();
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
      it(`${loss.label} at ${lostAt}ms releases the wait`, async () => {
        const plugin = await connect();
        const first = await reachReady(plugin, TOPIC);

        const driven = new Set(instances);
        const started = Date.now();
        let settledAt: number | undefined;
        const pending = plugin
          .fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS })
          .then((r) => {
            settledAt = Date.now();
            return r;
          });

        // Kill the socket unconditionally rather than from inside the settle loop: a call that
        // returned before `lostAt` would otherwise skip both the kill and the check below, and
        // every later row would pass without a waiter ever existing.
        await vi.advanceTimersByTimeAsync(lostAt);
        expect(settledAt, 'the call settled before the socket it waits on was lost').toBeUndefined();
        expect(armedWaiters(plugin), 'nothing was armed, so the loss below releases nothing').toBe(1);
        loss.kill(first);

        for (let t = 0; t < BLOCK_MS && settledAt === undefined; t += 10) {
          await vi.advanceTimersByTimeAsync(10);
          for (const ws of [...instances]) {
            if (driven.has(ws)) continue;
            driven.add(ws);
            loss.driveNew(ws);
          }
        }

        const result = await pending;
        expect(result.messages).toEqual([]);
        expect(result.nextCursor, 'the cursor must stay replayable').toBe(SINCE);
        expect(armedWaiters(plugin), 'a waiter outlived the socket that could fire it').toBe(0);
        expect(
          settledAt! - started,
          'the call kept sleeping on a socket that had already gone away',
        ).toBeLessThanOrEqual(lostAt + WAKE_SLACK_MS);
        expect(rest.count('/messages')).toBeGreaterThan(0);

        await plugin.disconnect();
      });
    }
  }
});

describe('Discord long-poll: a wakeup arriving', () => {
  let rest: FetchStub;

  const arrive = (ws?: FakeWs): void => {
    rest.page = [MESSAGE];
    if (ws !== undefined && ws.readyState === FakeWs.OPEN && ws.identified()) {
      ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: MESSAGE });
    }
  };

  const PHASES: Array<{ label: string; drive: (p: DiscordPlugin, call: () => void) => Promise<void> }> =
    [
      {
        label: 'before the call',
        drive: async (p, call) => {
          const ws = await reachReady(p, TOPIC);
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
          const ws = await reachReady(p, TOPIC);
          rest.holdNextPage();
          call();
          await vi.advanceTimersByTimeAsync(10);
          expect(rest.parked()).toBe(1);
          arrive(ws);
          rest.release();
          await vi.advanceTimersByTimeAsync(50);
        },
      },
      {
        label: 'after the first REST query',
        drive: async (p, call) => {
          const ws = await reachReady(p, TOPIC);
          call();
          await vi.advanceTimersByTimeAsync(10);
          arrive(ws);
          await vi.advanceTimersByTimeAsync(50);
        },
      },
    ];

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

  for (const phase of PHASES) {
    it(`${phase.label} is not lost`, async () => {
      const plugin = await connect();

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
    const plugin = await connect();
    await reachReady(plugin, TOPIC);

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
    const plugin = await connect();
    await reachReady(plugin, TOPIC);

    const started = Date.now();
    let settledAt: number | undefined;
    const pending = plugin
      .fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS })
      .then((r) => {
        settledAt = Date.now();
        return r;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(armedWaiters(plugin), 'nothing was armed, so the teardown below proves nothing').toBe(1);

    await plugin.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(settledAt, 'the blocked call outlived disconnect()').toBeDefined();
    expect(settledAt! - started).toBeLessThan(WAKE_SLACK_MS);
    expect(vi.getTimerCount(), 'a waiter timer outlived teardown').toBe(0);
    expect((await pending).messages).toEqual([]);
   });
  }
});

describe('the plugin composes with core’s poll fallback', () => {
  // The ONE cell that is deliberately about the WRAPPER: with the gateway terminally closed the
  // plugin can never wake anything, so only core's 250 ms poll can return the message. It says
  // nothing about the native waiter — that is what every table above is for.
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

  it('a terminally closed gateway still returns a message that lands mid-wait', async () => {
    const plugin = await connect();
    const ws = await reachReady(plugin, TOPIC);
    ws.serverClose(4014);

    const started = Date.now();
    let settledAt: number | undefined;
    let arrived = false;
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
      if (!arrived && Date.now() - started >= ARRIVES_AT_MS) {
        arrived = true;
        rest.page = [MESSAGE];
      }
    }

    const result = await pending;
    expect(result.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(settledAt! - started).toBeGreaterThanOrEqual(ARRIVES_AT_MS);
    expect(settledAt! - started).toBeLessThanOrEqual(ARRIVES_AT_MS + SLACK_MS);

    await plugin.disconnect();
  });
});
