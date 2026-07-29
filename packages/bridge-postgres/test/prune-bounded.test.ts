import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// Retention is enabled on a table that already exists — typically one that has been accumulating
// forever, because "keep every message" is the default. The first prune after an operator sets
// `retention_days` therefore has the whole backlog to remove, and it runs on the same pool as
// post(), whose transactions are already serialized per topic by an advisory lock. One unbatched
// DELETE over millions of rows holds row locks and bloats WAL for as long as it takes, and every
// post() behind it waits. So the property is not "the old rows are gone" — the real-server cases
// cover that — it is that the work is issued in BOUNDED statements and still completes exactly.

const state = vi.hoisted(() => ({
  /** Rows still older than the cutoff; each DELETE removes up to its own LIMIT. */
  remaining: 0,
  deletes: [] as string[],
}));

vi.mock('pg', () => {
  const poolQuery = async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (!/^\s*DELETE/.test(sql)) return { rows: [], rowCount: 0 };
    state.deletes.push(sql);
    const limit = /LIMIT (\d+)/.exec(sql);
    const took = limit === null ? state.remaining : Math.min(state.remaining, Number(limit[1]));
    state.remaining -= took;
    return { rows: [], rowCount: took };
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
    Client: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    })),
  };
});

const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  state.remaining = 0;
  state.deletes.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// Expressed as multiples of whatever batch size the plugin actually asks for, so the case cannot
// silently stop testing the boundary when that number is tuned.
const BACKLOGS = [
  ['nothing to remove', (b: number) => 0 * b],
  ['one row', () => 1],
  ['one under a batch', (b: number) => b - 1],
  ['exactly one batch', (b: number) => b],
  ['one over a batch', (b: number) => b + 1],
  ['several batches', (b: number) => 3 * b + 7],
] as const;

describe('prune issues bounded statements and still removes the whole backlog', () => {
  it.each(BACKLOGS)('%s', async (_label, backlogFor) => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL, retention_days: 1 });
    await sleep(20);
    const prune = (plugin as unknown as { prune: () => Promise<void> }).prune.bind(plugin);

    state.deletes.length = 0;
    state.remaining = 1;
    await prune();
    const batch = Number(/LIMIT (\d+)/.exec(state.deletes[0] ?? '')?.[1]);
    expect(batch, 'prune issued a DELETE with no row cap').toBeGreaterThan(0);

    state.deletes.length = 0;
    state.remaining = backlogFor(batch);
    const backlog = state.remaining;
    await prune();

    expect(state.remaining, 'prune stopped before the backlog was gone').toBe(0);
    for (const sql of state.deletes) {
      expect(sql, 'an unbounded DELETE reached the server').toMatch(/LIMIT \d+/);
    }
    expect(state.deletes.length, 'statement count').toBe(Math.floor(backlog / batch) + 1);

    await plugin.disconnect();
  }, 15000);
});
