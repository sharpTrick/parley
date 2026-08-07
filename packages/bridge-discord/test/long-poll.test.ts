import { asCursor, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CLASS: a plugin-level table whose assertions are satisfied by a core-level fallback. Every cell
// here that is about the PLUGIN's waiter drives `plugin.fetchRecent` DIRECTLY, because core's
// `fetchRecentBlocking` re-queries every 250 ms and therefore returns the message whether or not
// the plugin ever armed a waiter — a table routed through it stays green with the whole native
// long-poll deleted. One wrapper cell is kept at the bottom, and it says which layer it can see.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import { FakeWs, instances, resetGateway, state } from './fake-gateway.js';
import { HUGE_HB, probe, reachReady, stubFetch, type FetchStub } from './harness.js';

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
  probe<Map<string, unknown>>(plugin, 'waiters').size;

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
        // The wakeup lands between IDENTIFY and READY, so the socket has to finish the handshake
        // it is already in — a SECOND HELLO would be answered by ending the socket, since one
        // IDENTIFY per socket is what keeps a repeating peer off Discord's per-token quota.
        label: 'while the gateway handshake is still completing',
        drive: async (p, call) => {
          let identifying: FakeWs | undefined;
          state.onIdentify = (s: FakeWs) => {
            identifying = s;
          };
          call();
          await vi.advanceTimersByTimeAsync(10);
          const ws = instances.at(-1)!;
          ws.hello(HUGE_HB);
          await vi.advanceTimersByTimeAsync(10);
          arrive(undefined);
          identifying!.ready();
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

describe('the REST cost of a long-poll is its wakeups, not its budget', () => {
  // CLASS: a plugin that re-queries because time passed rather than because something happened.
  // Every table above asserts LATENCY, and a duplicate page query is invisible to a latency bound
  // (a localhost round trip fits inside any slack) — but it doubles the call rate against a bot
  // token whose global limits routinely ask for longer than a whole call's budget. So the axis is
  // WHAT WOKE THE CALL, and the assertion is the exact number of `…/messages` queries it issued:
  // one for the mandatory immediate page, plus one more only when something OTHER than the
  // deadline said there might be new state to read.
  let rest: FetchStub;

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

  const queries = (): number => rest.count('/messages');

  // The budget is the axis a leak would ride: page 0 always runs (MIN_QUERY_BUDGET_MS), so a
  // post-wake query that does not check the deadline costs a second one at EVERY budget.
  for (const blockMs of [1, 50, 1500, BLOCK_MS]) {
    it(`times out after ${blockMs}ms with nothing arriving: exactly one query`, async () => {
      const plugin = await connect();
      await reachReady(plugin, TOPIC);

      const pending = plugin.fetchRecent({ topic: TOPIC, since: SINCE, blockMs });
      await vi.advanceTimersByTimeAsync(blockMs + 10);

      expect((await pending).messages).toEqual([]);
      expect(queries(), 'the timed-out wait re-queried for nothing').toBe(1);
      await plugin.disconnect();
    });
  }

  it('a MESSAGE_CREATE wakes it: exactly two queries', async () => {
    const plugin = await connect();
    const ws = await reachReady(plugin, TOPIC);

    const pending = plugin.fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS });
    await vi.advanceTimersByTimeAsync(10);
    rest.page = [MESSAGE];
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: MESSAGE });
    await vi.advanceTimersByTimeAsync(10);

    expect((await pending).messages.map((m) => m.content)).toEqual(['fresh']);
    expect(queries(), 'the wakeup did not cost exactly one re-read').toBe(2);
    await plugin.disconnect();
  });

  it('the socket dies mid-wait: exactly two queries', async () => {
    // The socket that would have woken it is gone, so what it carried before dying is unknown —
    // one re-read is the point of releasing the waiter. A THIRD would mean the release itself
    // re-armed something.
    const plugin = await connect();
    const ws = await reachReady(plugin, TOPIC);

    const pending = plugin.fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS });
    await vi.advanceTimersByTimeAsync(10);
    state.onIdentify = () => undefined;
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(10);

    expect((await pending).messages).toEqual([]);
    expect(queries()).toBe(2);
    await plugin.disconnect();
  });

  it('the transport was never live: exactly one query', async () => {
    state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
    const plugin = await connect();

    const pending = plugin.fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS });
    for (let t = 0; t < HANDSHAKE_MS * 2; t += 10) await vi.advanceTimersByTimeAsync(10);

    expect((await pending).messages).toEqual([]);
    expect(queries(), 'a call that never armed a waiter still queried twice').toBe(1);
    await plugin.disconnect();
  });

  it('disconnect() releases it: exactly one query', async () => {
    const plugin = await connect();
    await reachReady(plugin, TOPIC);

    const pending = plugin.fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS });
    await vi.advanceTimersByTimeAsync(10);
    await plugin.disconnect();
    await vi.advanceTimersByTimeAsync(10);

    expect((await pending).messages).toEqual([]);
    expect(queries(), 'a torn-down plugin queried the provider again').toBe(1);
  });
});

describe('a wakeup reaches only the channels it names', () => {
  // CLASS: a fan-out keyed by an identifier, graded only on a single-key fixture. `dispatch` wakes
  // `waiters` for the channel the MESSAGE_CREATE named and `onSocketGone` wakes every channel —
  // two DIFFERENT fan-outs that a one-topic fixture cannot tell apart, and `armedWaiters` reads
  // `waiters.size`, which says how many channels have waiters and never which one fired. The table
  // above is exactly that fixture: every cell blocks on one topic, so `wake(waiters, id)` and
  // `wake(waiters)` are the same function to it. What the routing buys is that a busy guild does
  // not turn one MESSAGE_CREATE into one extra REST re-query per blocked topic, against a bot
  // token whose 429 budget this package documents at length — so the assertion is a per-channel
  // query VECTOR, and the axis is how many topics are blocked at once.
  const CHANNELS = ['770001', '770002', '770003'];
  let rest: FetchStub;

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

  let seq = 0;
  const messageOn = (channelId: string): Record<string, unknown> => ({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: ++seq,
    d: {
      id: String(900_000_000_000_000_000n + BigInt(seq)),
      channel_id: channelId,
      content: `to-${channelId}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      author: { id: '5', username: 'human' },
    },
  });

  /** `woken` and `dispatched` are indices into the fixture's channel list. */
  const WAKEUPS: Array<{
    label: string;
    fire: (ws: FakeWs, channels: string[]) => void;
    woken: (n: number) => number[];
    dispatched: (n: number) => number[];
  }> = [
    {
      label: 'a MESSAGE_CREATE on the first channel',
      fire: (ws, channels) => ws.serverSend(messageOn(channels[0]!)),
      woken: () => [0],
      dispatched: () => [0],
    },
    {
      label: 'a MESSAGE_CREATE on the last channel',
      fire: (ws, channels) => ws.serverSend(messageOn(channels.at(-1)!)),
      woken: (n) => [n - 1],
      dispatched: (n) => [n - 1],
    },
    {
      label: 'the socket going away',
      fire: (ws) => {
        state.onIdentify = () => undefined;
        ws.serverClose(1006);
      },
      woken: (n) => [...Array(n).keys()],
      dispatched: () => [],
    },
    {
      label: 'nothing at all',
      fire: () => undefined,
      woken: () => [],
      dispatched: () => [],
    },
  ];

  for (const n of [1, 3]) {
    for (const wakeup of WAKEUPS) {
      it(`${wakeup.label}, with ${n} topic(s) blocked`, async () => {
        const plugin = await connect();
        const channels = CHANNELS.slice(0, n);
        const heard: string[] = [];
        const handler = (m: { topic: Topic; content: string }): void => {
          heard.push(`${m.topic as string}:${m.content}`);
        };
        const ws = await reachReady(plugin, asTopic(channels[0]!), { handler });
        for (const channelId of channels.slice(1)) {
          const subscribed = plugin.subscribe(asTopic(channelId), handler);
          await vi.advanceTimersByTimeAsync(0);
          await subscribed;
        }

        const pending = channels.map((channelId) =>
          plugin.fetchRecent({ topic: asTopic(channelId), since: SINCE, blockMs: BLOCK_MS }),
        );
        await vi.advanceTimersByTimeAsync(10);
        expect(armedWaiters(plugin), 'not every topic armed, so the vector below proves nothing')
          .toBe(n);

        wakeup.fire(ws, channels);
        await vi.advanceTimersByTimeAsync(10);

        const woken = new Set(wakeup.woken(n));
        expect(
          channels.map((channelId) => rest.count(`/channels/${channelId}/messages`)),
          'a topic the wakeup did not name re-read the provider anyway',
        ).toEqual(channels.map((_, i) => (woken.has(i) ? 2 : 1)));
        expect(heard, 'a MESSAGE_CREATE reached a channel it did not name').toEqual(
          wakeup.dispatched(n).map((i) => `${channels[i]!}:to-${channels[i]!}`),
        );

        await plugin.disconnect();
        await Promise.all(pending);
      });
    }
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
