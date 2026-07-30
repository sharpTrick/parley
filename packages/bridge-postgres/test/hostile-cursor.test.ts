import { asCursor, asTopic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// `since` is opaque and agent-supplied: core's `parley_fetch_recent` takes `z.string().optional()`
// and passes it straight through, so a hallucinated cursor, an empty string, or one carried over from
// another backend's store all reach this plugin. Bound into `seq > $2::bigint`, the cast decides what
// happens — and it decides two different wrong things. 'abc' raises SQLSTATE 22P02, which tools.ts
// rethrows, rendering a PostgreSQL error string into agent context; while ' 5 ', '0x10' (PostgreSQL
// 16 reads hexadecimal integer literals) and '-1' are quietly ACCEPTED, because bigint input syntax
// is far laxer than a cursor, and the bogus value is then handed back as `nextCursor`.
//
// So the contract is stated instead of delegated: a cursor is a decimal bigint this backend minted,
// anything else is refused by name, and the refusal happens before any SQL is issued — which is what
// makes it impossible for a driver or SQLSTATE string to be the thing the agent sees.

const state = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter {
    async connect(): Promise<void> {}
    async query(sql: string): Promise<{ rows: unknown[] }> {
      state.queries.push(sql);
      return { rows: [] };
    }
    async end(): Promise<void> {}
    release(): void {}
  }

  return {
    Pool: vi.fn(() =>
      fakePool(async (sql) => {
        state.queries.push(sql);
        return { rows: [] };
      }, () => new MockClient()),
    ),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';

/**
 * One row per distinct SPELLING class, not one per string someone thought of. The interesting half
 * is the spellings `::bigint` silently ACCEPTS — signs, surrounding whitespace, and (since
 * PostgreSQL 16) hexadecimal, octal and underscore-separated integer literals — because those turn a
 * cursor the plugin never minted into a real, wrong window instead of an error.
 */
const HOSTILE = [
  '',
  'abc',
  '1e3',
  '5.0',
  '-1',
  '+5',
  ' 5 ',
  '0x10',
  '0o20',
  '1_000',
  '9223372036854775808',
  '99999999999999999999',
  '1;DROP TABLE t',
  '٥',
  '１２３',
  '1\u000A2',
];

/** A cursor this backend really can mint, including both ends of the bigint range. */
const LEGITIMATE = ['0', '1', '512', '9223372036854775807'];

const BLOCK_MS = [0, 40];

const HOSTILE_CELLS = HOSTILE.flatMap((since) => BLOCK_MS.map((blockMs) => ({ since, blockMs })));

async function connected(): Promise<PostgresPlugin> {
  const plugin = new PostgresPlugin();
  await plugin.connect({ url: URL, table_name: 'parley_hc' });
  state.queries = [];
  return plugin;
}

beforeEach(() => {
  state.queries = [];
});

describe('a cursor this backend did not mint is refused by name, before any SQL', () => {
  it.each(
    HOSTILE_CELLS.map((c) => [`${JSON.stringify(c.since)}, blockMs ${c.blockMs}`, c] as const),
  )('%s', async (_label, cell) => {
    const plugin = await connected();
    try {
      const attempt = plugin.fetchRecent({
        topic: asTopic('hc'),
        since: asCursor(cell.since),
        blockMs: cell.blockMs,
      });
      await expect(attempt).rejects.toThrow(/^parley-postgres: invalid cursor /);
      await attempt.catch((err: unknown) => {
        const message = String((err as Error).message);
        expect(message, 'the refusal must quote the value the caller passed').toContain(
          JSON.stringify(cell.since),
        );
        // A driver or SQLSTATE string reaching the agent is the failure being prevented, so the
        // absence of one is asserted rather than inferred from the prefix.
        expect(message).not.toMatch(/invalid input syntax|out of range for type|22P02/);
      });
      expect(state.queries, 'a rejected cursor still reached the database').toEqual([]);
    } finally {
      await plugin.disconnect();
    }
  }, 20000);
});

describe('a cursor this backend did mint is still accepted', () => {
  it.each(LEGITIMATE.flatMap((since) => BLOCK_MS.map((blockMs) => [`${since}, blockMs ${blockMs}`, since, blockMs] as const)))(
    '%s',
    async (_label, since, blockMs) => {
      const plugin = await connected();
      try {
        const page = await plugin.fetchRecent({
          topic: asTopic('hc'),
          since: asCursor(since),
          blockMs,
        });
        expect(page.messages).toEqual([]);
        expect(String(page.nextCursor), 'an empty page must hold the cursor steady').toBe(since);
        expect(state.queries.length, 'a legitimate cursor must reach the database').toBeGreaterThan(
          0,
        );
      } finally {
        await plugin.disconnect();
      }
    },
    20000,
  );

  // A since-less fetch has no cursor to validate and must not be caught by the check.
  it('a fetch with no since is unaffected', async () => {
    const plugin = await connected();
    try {
      await expect(plugin.fetchRecent({ topic: asTopic('hc') })).resolves.toBeDefined();
      expect(state.queries.length).toBeGreaterThan(0);
    } finally {
      await plugin.disconnect();
    }
  });
});
