import type { EventEmitter } from 'node:events';
import { asCursor, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { fakePool } from './fake-pg.js';

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
  clients: [] as { emit: (event: string, arg?: unknown) => boolean }[],
  /** The table, per topic — what the recovery read must actually come back with. */
  rows: new Map<string, Record<string, unknown>[]>(),
}));

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter {
    constructor() {
      super();
      state.clients.push(this);
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

  // Served through the same cursor-honouring helper as every other suite: a pool that answers []
  // for every windowed SELECT makes the post-failure recovery assertion below pass whether or not
  // the plugin ever recovered.
  return {
    Pool: vi.fn(() =>
      fakePool(async (sql, values) => {
        if (state.poolFails) throw new Error('query failed (mock)');
        const all = state.rows.get(String(values[0])) ?? [];
        return { rows: servePool(all, sql, values) ?? [] };
      }),
    ),
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
  state.rows.clear();
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

    // Recovery has to be READ, not merely resolved: a pool that answers [] for every windowed
    // SELECT would satisfy `resolves.toBeDefined()` from a plugin that never recovered at all.
    state.poolFails = false;
    state.rows.set('t', [
      {
        seq: '1',
        topic: 't',
        sender: 'u',
        content: 'recovered',
        ts: new Date().toISOString(),
        in_reply_to: null,
      },
    ]);
    const page = await plugin.fetchRecent({ topic, since: asCursor('0') });
    expect(page.messages.map((m) => m.content), `${path} left the read path broken`).toEqual([
      'recovered',
    ]);
    expect(String(page.nextCursor)).toBe('1');
    await plugin.disconnect();
  }, 10000);
});

// Node kills the process on an 'error' event nothing is listening for, and pg raises one per
// CONNECTION, not per call: a server restart or an admin kill of a client sitting idle in the pool
// arrives that way, with no query in flight to reject. So every connection surface this plugin owns
// is graded here rather than one of them being covered by accident — a surface added later is a
// missing row rather than silence.

type Surface = 'pooled connection' | 'listener connection';
type Phase = 'idle' | 'with a live subscription' | 'with a blocking fetch parked';

const PHASES: Phase[] = ['idle', 'with a live subscription', 'with a blocking fetch parked'];

/** The listener connection is lazy, so it only exists in the phases that open one. */
const SURFACE_CELLS: { surface: Surface; phase: Phase }[] = PHASES.flatMap((phase) =>
  (['pooled connection', 'listener connection'] as Surface[])
    .filter((surface) => surface === 'pooled connection' || phase !== 'idle')
    .map((surface) => ({ surface, phase })),
);

const ADMIN_KILL = 'terminating connection due to administrator command';

describe("an 'error' event on a connection surface never reaches the process", () => {
  it('an unhandled error event on this fake really does throw, so the cells below can fail', () => {
    expect(() => fakePool().emit('error', new Error(ADMIN_KILL))).toThrow(ADMIN_KILL);
  });

  it.each(SURFACE_CELLS.map((c) => [`${c.surface}, ${c.phase}`, c] as const))(
    '%s',
    async (_label, cell) => {
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: REAL_URL });
      const topic = asTopic('t');

      let parked: Promise<unknown> | undefined;
      if (cell.phase === 'with a live subscription') await plugin.subscribe(topic, () => undefined);
      if (cell.phase === 'with a blocking fetch parked') {
        parked = plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 400 });
        await sleep(20);
      }

      const priv = plugin as unknown as { pool?: EventEmitter; listener?: EventEmitter };
      const surface = cell.surface === 'pooled connection' ? priv.pool : priv.listener;
      expect(surface, 'this cell has no connection to grade, so it proves nothing').toBeDefined();
      expect(() => (surface as EventEmitter).emit('error', new Error(ADMIN_KILL))).not.toThrow();

      await parked;
      expect(rejections, `${cell.surface} leaked a rejection`).toEqual([]);

      state.rows.set('t', [
        {
          seq: '1',
          topic: 't',
          sender: 'u',
          content: 'still serving',
          ts: new Date().toISOString(),
          in_reply_to: null,
        },
      ]);
      const page = await plugin.fetchRecent({ topic, since: asCursor('0') });
      expect(page.messages.map((m) => m.content), 'the read path died with the socket').toEqual([
        'still serving',
      ]);

      await plugin.disconnect();
    },
    10000,
  );
});
