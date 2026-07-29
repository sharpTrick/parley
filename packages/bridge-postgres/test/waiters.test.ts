import { asCursor, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';

// A blocking fetchRecent parks on the topic's NOTIFY channel, and several may park on the SAME
// channel at once. The hazard is a readiness flag that means "someone intends to LISTEN" instead of
// "the channel IS LISTENed": a later waiter piggybacks on a doorbell that was never installed, and
// nothing wakes it until its whole budget expires. This matrix pins the invariant for every
// interleaving: in EVERY cell, either the LISTEN is really established or every parked waiter is
// released promptly — never at blockMs — and no channel is left believed-listening afterwards.

const state = vi.hoisted(() => ({
  clients: [] as MockClientShape[],
  /** How `LISTEN` behaves on the listener connection for this cell. */
  listenMode: 'fast' as 'fast' | 'slow' | 'reject-slow',
  listenDelayMs: 100,
  /** Channels whose LISTEN actually succeeded. */
  established: [] as string[],
  /** Every LISTEN attempt, successful or not. */
  attempted: [] as string[],
}));

interface MockClientShape {
  emit: (event: string, arg?: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

vi.mock('pg', () => {
  class MockClient implements MockClientShape {
    private readonly handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    constructor() {
      state.clients.push(this);
    }
    on(event: string, cb: (arg?: unknown) => void): void {
      (this.handlers[event] ??= []).push(cb);
    }
    emit(event: string, arg?: unknown): void {
      for (const cb of this.handlers[event] ?? []) cb(arg);
    }
    async connect(): Promise<void> {}
    async query(sql: string): Promise<{ rows: unknown[] }> {
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) {
        const channel = listen[1] as string;
        state.attempted.push(channel);
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

  return {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
      query: vi.fn(async (sql: string) => ({
        rows: /MAX\(seq\)/.test(sql) ? [{ max: '0' }] : [],
      })),
      end: vi.fn(async () => undefined),
    })),
    Client: MockClient,
  };
});

const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const BLOCK_MS = 1000;

beforeEach(() => {
  state.clients.length = 0;
  state.established.length = 0;
  state.attempted.length = 0;
  state.listenMode = 'fast';
  state.listenDelayMs = 100;
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

    const priv = plugin as unknown as {
      listens: Map<string, unknown>;
      waiters: Map<string, unknown>;
    };
    expect(priv.listens.size, 'channel left believed-listening').toBe(0);
    expect(priv.waiters.size, 'waiter registry leaked').toBe(0);

    await plugin.disconnect();
  }, 10000);

  it('a subscription and a blocking waiter share ONE LISTEN for the channel', async () => {
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
    // The subscription still needs the channel after the waiter leaves.
    const priv = plugin as unknown as { listens: Map<string, unknown> };
    expect(priv.listens.has(channel)).toBe(true);

    await plugin.disconnect();
  }, 10000);
});
