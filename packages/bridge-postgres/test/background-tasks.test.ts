import { asCursor, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// Every fire-and-forget chore in this plugin (the prune tick, the drain loop, the listener
// reconnect, a waiter's snapshot re-check) is best-effort by design: its failure must cost latency
// or a skipped chore, never the process. Node kills the bridge on an unhandled rejection, so an
// operator with one typoed config value would otherwise get a server that dies with a stack trace
// naming nothing. This installs a process-level spy and forces each path to fail.

const state = vi.hoisted(() => ({
  /** When set, every pool query rejects — drives the drain/prune/waiter failure paths. */
  poolFails: false,
  /** When set, the LISTEN connection cannot be established — drives the reconnect failure path. */
  clientFails: false,
  clients: [] as { emit: (event: string, arg?: unknown) => void }[],
}));

vi.mock('pg', () => {
  class MockClient {
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
    async connect(): Promise<void> {
      if (state.clientFails) throw new Error('listener connect failed (mock)');
    }
    async query(): Promise<{ rows: unknown[] }> {
      if (state.clientFails) throw new Error('listener query failed (mock)');
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  const poolQuery = async (sql: string): Promise<{ rows: unknown[] }> => {
    if (state.poolFails) throw new Error('query failed (mock)');
    return { rows: /MAX\(seq\)/.test(sql) ? [{ max: '0' }] : [] };
  };

  return {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
      query: vi.fn(poolQuery) as unknown as typeof poolQuery,
      end: vi.fn(async () => undefined),
    })),
    Client: MockClient,
  };
});

const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let rejections: unknown[] = [];
const record = (err: unknown): void => {
  rejections.push(err);
};

beforeEach(() => {
  rejections = [];
  state.poolFails = false;
  state.clientFails = false;
  state.clients.length = 0;
  process.on('unhandledRejection', record);
});

afterEach(async () => {
  await sleep(20);
  process.off('unhandledRejection', record);
  vi.clearAllMocks();
});

/**
 * The prune cutoff is arithmetic on an operator-supplied number. `validateBackendConfig` is the
 * first line of defence, so these drive `retentionDays` past it to prove the second one: the chore
 * itself must swallow whatever the value does to it.
 */
const HOSTILE_RETENTION: unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e308,
  'abc',
  null,
  {},
  [],
];

describe('background chores never escape as an unhandled rejection', () => {
  it.each(HOSTILE_RETENTION.map((v) => [String(v), v] as const))(
    'the prune tick survives retention_days = %s',
    async (_label, value) => {
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: REAL_URL });
      (plugin as unknown as { retentionDays?: unknown }).retentionDays = value;

      const tick = (plugin as unknown as { prune: () => Promise<void> }).prune.bind(plugin);
      void tick();
      await sleep(50);

      expect(rejections, 'prune leaked a rejection').toEqual([]);
      const { messages } = await plugin.fetchRecent({ topic: asTopic('t') });
      expect(messages).toEqual([]);

      await plugin.disconnect();
    },
  );

  it.each([
    ['drain after a failing pool', 'drain'],
    ['listener reconnect that cannot reconnect', 'reconnect'],
    ['a blocking waiter whose re-check query fails', 'waiter'],
  ])('%s', async (_label, path) => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    const topic = asTopic('t');
    await plugin.subscribe(topic, () => undefined);

    if (path === 'drain') {
      state.poolFails = true;
      const channel = [
        ...(plugin as unknown as { subs: Map<string, unknown> }).subs.keys(),
      ][0] as string;
      state.clients[0]?.emit('notification', { channel });
      await sleep(60);
    } else if (path === 'reconnect') {
      state.clientFails = true;
      state.clients[0]?.emit('end');
      await sleep(700);
      state.clientFails = false;
    } else {
      const wait = plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 120 });
      state.poolFails = true;
      await wait.catch(() => undefined);
    }

    expect(rejections, `${path} leaked a rejection`).toEqual([]);

    state.poolFails = false;
    await expect(plugin.fetchRecent({ topic })).resolves.toBeDefined();
    await plugin.disconnect();
  }, 10000);
});
