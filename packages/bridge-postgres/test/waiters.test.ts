import { asCursor, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';

// A blocking fetchRecent parks on the topic's NOTIFY channel, and several may park on the SAME
// channel at once. The hazard is a readiness flag that means "someone intends to LISTEN" instead of
// "the channel IS LISTENed": a later waiter piggybacks on a doorbell that was never installed, and
// nothing wakes it until its whole budget expires. This matrix pins the invariant for every
// interleaving: in EVERY cell, either the LISTEN is really established or every parked waiter is
// released promptly — never at blockMs — and no channel is left registered on the CONNECTION
// afterwards. What the plugin believes about its own bookkeeping is not the property: a leaked
// server-side LISTEN wakes the process for every future post to that topic, forever, and only the
// connection's observed LISTEN-minus-UNLISTEN set can see it.

const state = vi.hoisted(() => ({
  clients: [] as MockClientShape[],
  /** How `LISTEN` behaves on the listener connection for this cell. */
  listenMode: 'fast' as 'fast' | 'slow' | 'reject-slow',
  listenDelayMs: 100,
  /** Channels whose LISTEN actually succeeded. */
  established: [] as string[],
  /** Channels an UNLISTEN actually reached the connection for. */
  unlistened: [] as string[],
  /** Every LISTEN attempt, successful or not. */
  attempted: [] as string[],
  /** Fired synchronously when a LISTEN is attempted, before its delay. */
  onListenAttempt: null as ((channel: string) => void) | null,
  /** When true, the exclusive-`since` read returns one row — a message has become visible. */
  rowVisible: false,
}));

interface MockClientShape {
  emit: (event: string, arg?: unknown) => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the CONNECTION is still registered for: every LISTEN that no UNLISTEN has undone. */
function observedChannels(): string[] {
  const net = new Map<string, number>();
  for (const c of state.established) net.set(c, (net.get(c) ?? 0) + 1);
  for (const c of state.unlistened) net.set(c, (net.get(c) ?? 0) - 1);
  return [...net.entries()].filter(([, n]) => n > 0).map(([c]) => c);
}

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockClientShape {
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {}
    async query(sql: string): Promise<{ rows: unknown[] }> {
      const unlisten = /^UNLISTEN "(.+)"$/.exec(sql);
      if (unlisten !== null) {
        state.unlistened.push(unlisten[1] as string);
        return { rows: [] };
      }
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) {
        const channel = listen[1] as string;
        state.attempted.push(channel);
        state.onListenAttempt?.(channel);
        if (state.listenMode === 'fast') {
          state.established.push(channel);
          return { rows: [] };
        }
        await sleep(state.listenDelayMs);
        if (state.listenMode === 'reject-slow') throw new Error('LISTEN failed (mock)');
        state.established.push(channel);
      }
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  const poolQuery = async (sql: string, values: readonly unknown[]): Promise<{ rows: unknown[] }> => {
    // Serve the row through the same cursor-honouring helper the other suites use. A fake that
    // returns it for every `seq > $2` regardless of the cursor makes the drain loop re-deliver it
    // forever, which is the fake's bug and not the plugin's.
    const all = state.rowVisible
      ? [
          {
            seq: '1',
            topic: String(values[0]),
            sender: 'u',
            content: 'landed',
            ts: new Date().toISOString(),
            in_reply_to: null,
          },
        ]
      : [];
    return { rows: servePool(all, sql, values) ?? [] };
  };

  return {
    Pool: vi.fn(() => fakePool(poolQuery)),
    Client: MockClient,
  };
});

const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const BLOCK_MS = 1000;

beforeEach(() => {
  state.clients.length = 0;
  state.established.length = 0;
  state.unlistened.length = 0;
  state.attempted.length = 0;
  state.listenMode = 'fast';
  state.listenDelayMs = 100;
  state.onListenAttempt = null;
  state.rowVisible = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

interface Cell {
  listenMode: 'fast' | 'slow' | 'reject-slow';
  waiters: number;
  skewMs: number;
}

const CELLS: Cell[] = ['fast', 'slow', 'reject-slow'].flatMap((listenMode) =>
  [1, 2, 3].flatMap((waiters) =>
    [0, 50].map((skewMs) => ({ listenMode, waiters, skewMs }) as Cell),
  ),
);

describe('blocking fetchRecent waiters on a shared NOTIFY channel', () => {
  it.each(
    CELLS.map((c) => [`LISTEN ${c.listenMode}, ${c.waiters} waiter(s), ${c.skewMs}ms skew`, c] as const),
  )('%s: never parks on a doorbell that was not installed', async (_label, cell) => {
    state.listenMode = cell.listenMode;

    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    const topic = asTopic('t');
    const channel = channelFor(topic);

    const started = Date.now();
    const elapsed: number[] = [];
    const runs: Promise<void>[] = [];
    for (let i = 0; i < cell.waiters; i++) {
      runs.push(
        (async () => {
          if (i > 0) await sleep(cell.skewMs * i);
          await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: BLOCK_MS });
          elapsed.push(Date.now() - started);
        })(),
      );
    }

    // Keep ringing the doorbell for as long as it genuinely exists; if it never does, the waiters
    // must have been released on their own rather than sleeping out the budget.
    let ringing = true;
    void (async () => {
      while (ringing) {
        if (state.established.includes(channel)) {
          state.clients[0]?.emit('notification', { channel });
        }
        await sleep(20);
      }
    })();

    await Promise.all(runs);
    ringing = false;

    for (const ms of elapsed) expect(ms).toBeLessThan(BLOCK_MS * 0.6);
    expect(state.attempted.filter((c) => c === channel).length).toBeGreaterThan(0);
    expect(observedChannels(), 'channel left LISTENed on the connection').toEqual([]);
    expect(
      (plugin as unknown as { waiters: Map<string, unknown> }).waiters.size,
      'waiter registry leaked',
    ).toBe(0);

    await plugin.disconnect();
  }, 10000);

  it('a subscription and a blocking waiter share ONE LISTEN, which outlives the waiter', async () => {
    state.listenMode = 'slow';
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    const topic = asTopic('shared');
    const channel = channelFor(topic);

    const sub = plugin.subscribe(topic, () => undefined);
    const wait = plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: BLOCK_MS });
    await sub;
    await sleep(20);
    state.clients[0]?.emit('notification', { channel });
    await wait;

    expect(state.attempted.filter((c) => c === channel).length).toBe(1);
    // The subscription still needs the channel after the waiter leaves, so no UNLISTEN may have
    // reached the connection.
    expect(state.unlistened).toEqual([]);
    expect(observedChannels()).toEqual([channel]);

    await plugin.disconnect();
  }, 10000);

  it('a waiter sharing a REJECTED subscribe leaves nothing LISTENed and does not park', async () => {
    state.listenMode = 'reject-slow';
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    const topic = asTopic('doomed');
    const channel = channelFor(topic);

    const started = Date.now();
    const sub = plugin.subscribe(topic, () => undefined);
    const wait = plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: BLOCK_MS });
    await expect(sub).rejects.toThrow(/LISTEN failed/);
    await wait;

    expect(Date.now() - started).toBeLessThan(BLOCK_MS * 0.6);
    expect(state.attempted.filter((c) => c === channel).length).toBe(1);
    expect(observedChannels()).toEqual([]);
    expect((plugin as unknown as { subs: Map<string, unknown> }).subs.size).toBe(0);

    await plugin.disconnect();
  }, 10000);
});

// A blocking fetch holds a plain setTimeout for its whole budget — up to core's 60s cap. If
// disconnect() does not release the parked waits, shutdown is not shutdown: the call keeps running
// and its timer keeps the Node event loop referenced long after the plugin has torn everything
// else down. The property is that teardown DRAINS the in-flight waiter registry, so it is
// parameterized over how many waits are parked, on how many channels, how long they asked for, and
// whether teardown lands before or after the LISTEN they are waiting on is established.

interface TeardownCell {
  waiters: number;
  topics: number;
  blockMs: number;
  duringListen: boolean;
}

/** Every wait must settle inside this once disconnect() lands, whatever budget it asked for. */
const RELEASE_BUDGET_MS = 500;

const TEARDOWN_CELLS: TeardownCell[] = [1, 3].flatMap((waiters) =>
  [1, 2].flatMap((topics) =>
    [1000, 4000].flatMap((blockMs) =>
      [false, true].map((duringListen) => ({ waiters, topics, blockMs, duringListen })),
    ),
  ),
);

describe('disconnect() releases every in-flight blocking wait', () => {
  it.each(
    TEARDOWN_CELLS.map(
      (c) =>
        [
          `${c.waiters} waiter(s) on ${c.topics} topic(s), blockMs ${c.blockMs}, teardown ${
            c.duringListen ? 'during LISTEN' : 'after LISTEN'
          }`,
          c,
        ] as const,
    ),
  )('%s', async (_label, cell) => {
    state.listenMode = cell.duringListen ? 'slow' : 'fast';
    state.listenDelayMs = 150;

    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });

    const started = Date.now();
    const elapsed: number[] = [];
    const runs = Array.from({ length: cell.waiters }, (_, i) =>
      plugin
        .fetchRecent({
          topic: asTopic(`t${i % cell.topics}`),
          since: asCursor('0'),
          blockMs: cell.blockMs,
        })
        .then(() => {
          elapsed.push(Date.now() - started);
        }),
    );

    await sleep(50);
    await plugin.disconnect();
    await Promise.all(runs);

    expect(elapsed.length).toBe(cell.waiters);
    for (const ms of elapsed) {
      expect(ms, 'a wait outlived the disconnect that was supposed to release it').toBeLessThan(
        RELEASE_BUDGET_MS,
      );
    }
  }, 15000);
});

// waitForNotify arms the doorbell and only THEN re-reads. A row that commits between the caller's
// initial empty read and the LISTEN being established sent a NOTIFY nobody was listening for, so
// without that one re-check the wait stalls for its whole budget with the message already durably
// visible. This is the lost-wakeup shape, and it is invisible unless a row is made to land inside
// that exact window — so these cells widen the window deliberately and never ring the doorbell.

interface SnapshotCell {
  appearAfterListenMs: number;
  withSubscription: boolean;
}

const LISTEN_WINDOW_MS = 400;

const SNAPSHOT_CELLS: SnapshotCell[] = [0, 100, 300].flatMap((appearAfterListenMs) =>
  [false, true].map((withSubscription) => ({ appearAfterListenMs, withSubscription })),
);

describe('a row landing in the LISTEN snapshot window still wakes the waiter', () => {
  it.each(
    SNAPSHOT_CELLS.map(
      (c) =>
        [
          `row visible ${c.appearAfterListenMs}ms into the LISTEN, ${
            c.withSubscription ? 'waiter shares the channel with a subscription' : 'waiter alone'
          }`,
          c,
        ] as const,
    ),
  )('%s', async (_label, cell) => {
    state.listenMode = 'slow';
    state.listenDelayMs = LISTEN_WINDOW_MS;
    // Nothing rings this doorbell: the row is committed by someone whose NOTIFY arrived before the
    // LISTEN existed. Only the post-registration re-check can end this wait early.
    state.onListenAttempt = () => {
      setTimeout(() => {
        state.rowVisible = true;
      }, cell.appearAfterListenMs);
    };

    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    const topic = asTopic('snapshot');

    const started = Date.now();
    const wait = plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: BLOCK_MS * 4 });
    const joined = cell.withSubscription ? plugin.subscribe(topic, () => undefined) : undefined;

    const page = await wait;
    const took = Date.now() - started;
    if (joined !== undefined) await joined;

    expect(page.messages.map((m) => m.content), 'the committed row was not returned').toEqual([
      'landed',
    ]);
    expect(took, 'the wait stalled instead of re-checking after the LISTEN').toBeLessThan(
      LISTEN_WINDOW_MS * 2,
    );

    await plugin.disconnect();
  }, 15000);
});
