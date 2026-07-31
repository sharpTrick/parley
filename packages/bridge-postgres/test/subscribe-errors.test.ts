import { asTopic, type Message } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { SOURCE } from './sources.js';

// core's push loop rethrows anything `subscribe` rejects with that is not a `NoSuchTopicError`, so
// a raw driver string — 'Client has encountered a connection error and is not queryable',
// 'terminating connection due to administrator command' — stops the whole bridge coming up on a
// message naming neither this backend nor the topic. That makes the guarantee a property of the
// SEAM CALL and not of one statement inside it: every surface `subscribe` can fail on has to be
// named, and a surface added later has to be a missing row here rather than silence.
//
// So the surfaces are DERIVED from the awaits in `startSubscription` — the same discipline
// lifecycle.test.ts uses for the epoch guards — and each one declares whether it fails the seam
// call or only the fire-and-forget push behind it.

const state = vi.hoisted(() => ({
  clients: [] as { emit: (event: string, arg?: unknown) => boolean }[],
  /** Which surface the next attempt must fail on, or `null` for a healthy backend. */
  failing: null as null | string,
  rows: [] as Record<string, unknown>[],
}));

/** What a real driver says, so a cell cannot pass by matching a string the test invented. */
const DRIVER_ERRORS: Record<string, string> = {
  'this.ensureListener': 'connect ECONNREFUSED 127.0.0.1:5432',
  'this.acquireListen': 'Client has encountered a connection error and is not queryable',
  'pool.query': 'terminating connection due to administrator command',
  drain: 'terminating connection due to administrator command',
};

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter {
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {
      if (state.failing === 'this.ensureListener') {
        throw new Error(DRIVER_ERRORS['this.ensureListener'] as string);
      }
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (state.failing === 'this.acquireListen' && /^LISTEN /.test(sql)) {
        throw new Error(DRIVER_ERRORS['this.acquireListen'] as string);
      }
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn(() =>
      fakePool(async (sql, values) => {
        const windowed = /seq > \$\d+::bigint/.test(sql);
        if (state.failing === 'pool.query' && /MAX\(seq\)/.test(sql)) {
          throw new Error(DRIVER_ERRORS['pool.query'] as string);
        }
        if (state.failing === 'drain' && windowed) {
          throw new Error(DRIVER_ERRORS['drain'] as string);
        }
        return { rows: servePool(state.rows, sql, values) ?? [] };
      }),
    ),
    Client: MockClient,
  };
});

const PG_DSN = 'postgres://app:s3cret@db.example.com:5432/prod';

/** Every awaited call in `startSubscription`, read out of the source rather than listed here. */
function awaitedCalls(): string[] {
  const body = /(?<![.\w])startSubscription\([\s\S]*?\n {0,2}\}\n/.exec(SOURCE);
  return [...(body?.[0] ?? '').matchAll(/await ([\w.]+)\(/g)].map((m) => m[1] as string);
}

type Arm = 'rejects' | 'resolves';

/**
 * One row per way `subscribe` reaches the backend. `drain` is the fire-and-forget push read the
 * registration starts, not a statement the caller is waiting on, so it declares the other arm —
 * push-self-heal.test.ts owns what happens to the batch it dropped.
 */
const AWAITED_SURFACES: { surface: string; arm: Arm }[] = [
  { surface: 'this.ensureListener', arm: 'rejects' },
  { surface: 'pool.query', arm: 'rejects' },
  { surface: 'this.acquireListen', arm: 'rejects' },
];

const SURFACES: { surface: string; arm: Arm }[] = [
  ...AWAITED_SURFACES,
  { surface: 'drain', arm: 'resolves' },
];

beforeEach(() => {
  state.clients = [];
  state.failing = null;
  state.rows = [];
});

describe('every way subscribe can fail names this plugin and the topic', () => {
  it('every awaited call in startSubscription has a row below', () => {
    expect(
      awaitedCalls(),
      'a statement was added to or removed from startSubscription — give its surface a row',
    ).toEqual(AWAITED_SURFACES.map((s) => s.surface));
  });

  it.each(SURFACES.map((s) => [`${s.surface} (${s.arm})`, s] as const))(
    '%s',
    async (_label, cell) => {
      const topic = asTopic('brand-new');
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: PG_DSN, table_name: 'parley_se' });
      const got: Message[] = [];
      try {
        state.failing = cell.surface;
        let rejection: Error | undefined;
        await plugin.subscribe(topic, (m) => got.push(m)).catch((err: unknown) => {
          rejection = err as Error;
        });

        if (cell.arm === 'resolves') {
          expect(rejection, 'this surface is not one the caller waits on').toBeUndefined();
          return;
        }

        expect(rejection, 'this surface is supposed to fail the seam call').toBeDefined();
        const message = (rejection as Error).message;
        expect(message, 'a raw driver string escaped subscribe').toMatch(/^parley-postgres:/);
        expect(message, 'the failure must say which topic it was for').toContain(String(topic));
        expect(message, 'the failure must carry what the driver actually said').toContain(
          DRIVER_ERRORS[cell.surface] as string,
        );
        expect(
          (plugin as unknown as { subs: Map<string, unknown> }).subs.size,
          'a failed subscribe left a registration behind',
        ).toBe(0);
      } finally {
        state.failing = null;
        await plugin.disconnect().catch(() => undefined);
      }
    },
    10000,
  );
});
