import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDEXED_FIELDS, MAX_INDEXED_BYTES } from '../src/errors.js';
import { PostgresPlugin } from '../src/index.js';
import { buildSchema } from '../src/schema.js';
import { dropTable, isUp, PG_URL, rand, withAdmin } from './pg-harness.js';
import { type Field, incompressible } from './storable-corpus.js';

// Two facts about a SERVER are compiled into this plugin: how large an index key PostgreSQL will
// take, and which of this schema's columns are index keys at all. Both were wrong for four rounds —
// the test corpus asserted 8191 bytes (the real ceiling is 2704) and named `sender` and
// `in_reply_to` as index keys (neither is indexed) — and nothing noticed, because no value in the
// suite landed in the window where the two answers differ.
//
// So neither is restated here. The column set is DERIVED from `buildSchema`, and the ceiling is
// MEASURED against the server this suite is running on. A number nobody re-measures is a fiction
// waiting for the deployment that disagrees with it.

const up = await isUp(PG_URL);

/** Strip line comments, so a commented-out index cannot be read as one the schema creates. */
function statements(ddl: string): string {
  return ddl.replace(/--[^\n]*/g, '');
}

const CREATE_INDEX =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?[\w.]+"?\s+ON\s+"?[\w.]+"?\s*\(([^)]*)\)/gi;
const INLINE_PRIMARY_KEY = /^[\t ]*"?(\w+)"?\s+[A-Za-z0-9 ]*?PRIMARY\s+KEY/gim;
const TABLE_PRIMARY_KEY = /PRIMARY\s+KEY\s*\(([^)]*)\)/gi;

function columnsIn(list: string): string[] {
  return list
    .split(',')
    .map((c) => (/"?(\w+)"?/.exec(c.trim())?.[1] ?? '').toLowerCase())
    .filter((c) => c.length > 0);
}

/** Every column this DDL puts into a btree — a CREATE INDEX list, or either PRIMARY KEY spelling. */
export function indexedColumns(ddl: string): Set<string> {
  const sql = statements(ddl);
  const found = new Set<string>();
  for (const m of sql.matchAll(CREATE_INDEX)) for (const c of columnsIn(m[1] as string)) found.add(c);
  for (const m of sql.matchAll(TABLE_PRIMARY_KEY)) for (const c of columnsIn(m[1] as string)) found.add(c);
  for (const m of sql.matchAll(INLINE_PRIMARY_KEY)) found.add((m[1] as string).toLowerCase());
  return found;
}

/**
 * Every column either table declares, and the seam field whose bytes end up in it. Total on purpose:
 * an index added on a column missing from here fails the derivation below by name instead of
 * quietly widening or narrowing the screen.
 */
const COLUMN_FIELD: Record<string, Field | null> = {
  seq: null,
  topic: 'topic',
  sender: 'handle',
  content: 'content',
  ts: null,
  created_at: null,
  in_reply_to: 'inReplyTo',
  handle: 'handle',
  backend_ref: null,
};

/** Largest `n` for which `accepts(n)` holds, given `accepts(lo)` and `!accepts(hi)`. */
async function largestAccepted(
  accepts: (n: number) => Promise<boolean>,
  lo: number,
  hi: number,
): Promise<number> {
  let good = lo;
  let bad = hi;
  while (good + 1 < bad) {
    const mid = (good + bad) >> 1;
    if (await accepts(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

describe('the index-key budget is measured, and the fields it covers are derived', () => {
  it('the DDL scanner finds an index key and only an index key', () => {
    expect(indexedColumns('CREATE INDEX "t_x" ON "t" (sender);')).toEqual(new Set(['sender']));
    expect(indexedColumns('CREATE UNIQUE INDEX "t_x" ON "t" (topic, seq);')).toEqual(
      new Set(['topic', 'seq']),
    );
    expect(indexedColumns('CREATE INDEX "t_x" ON "t" (created_at DESC);')).toEqual(
      new Set(['created_at']),
    );
    expect(indexedColumns('  handle      TEXT PRIMARY KEY,')).toEqual(new Set(['handle']));
    expect(indexedColumns('  seq         BIGSERIAL PRIMARY KEY,')).toEqual(new Set(['seq']));
    expect(indexedColumns('  PRIMARY KEY (topic, seq)')).toEqual(new Set(['topic', 'seq']));

    expect(indexedColumns('SELECT 1 FROM "t" WHERE sender = $1 ORDER BY seq')).toEqual(new Set());
    expect(indexedColumns('DROP INDEX "t_ts";')).toEqual(new Set());
    expect(indexedColumns('-- CREATE INDEX "t_x" ON "t" (sender);')).toEqual(new Set());
    expect(indexedColumns('  in_reply_to TEXT -- backendMsgId this threads under')).toEqual(
      new Set(),
    );
  });

  it('the fields the size screen covers are exactly the ones this schema indexes', () => {
    const columns = [...indexedColumns(buildSchema('parley_budget'))];
    expect(columns.length, 'the scanner found no index at all in buildSchema').toBeGreaterThan(0);
    const unmapped = columns.filter((c) => !(c in COLUMN_FIELD));
    expect(unmapped, 'an indexed column no seam field is mapped to — extend COLUMN_FIELD').toEqual(
      [],
    );
    const derived = new Set(columns.map((c) => COLUMN_FIELD[c]).filter((f) => f !== null));
    expect([...derived].sort(), 'the screened set and the indexed set have drifted apart').toEqual(
      [...INDEXED_FIELDS].sort(),
    );
  });
});

const table = `parley_budget_${rand()}`;

describe.skipIf(!up)(`the budget matches the server the suite is running on (${table})`, () => {
  let plugin: PostgresPlugin;

  beforeAll(async () => {
    plugin = new PostgresPlugin();
    await plugin.connect({ url: PG_URL, table_name: table, pool_size: 1 });
  });

  afterAll(async () => {
    await plugin.disconnect().catch(() => undefined);
    await dropTable(table);
  });

  it('MAX_INDEXED_BYTES is the largest value this server will index, not a number from a manual', async () => {
    const { topicMax, handleMax } = await withAdmin(async (admin) => {
      const insertTopic = async (n: number): Promise<boolean> => {
        try {
          await admin.query(
            `INSERT INTO "${table}" (topic, sender, content, ts) VALUES ($1, 'u', 'c', 't')`,
            [incompressible(n, 41)],
          );
          return true;
        } catch {
          return false;
        }
      };
      const insertHandle = async (n: number): Promise<boolean> => {
        try {
          await admin.query(
            `INSERT INTO "${table}_senders" (handle, backend_ref) VALUES ($1, $1)`,
            [incompressible(n, 42)],
          );
          return true;
        } catch {
          return false;
        }
      };
      expect(await insertTopic(20000), 'the server took a 20 KB index key — no ceiling to find').toBe(
        false,
      );
      expect(await insertHandle(20000), 'the server took a 20 KB index key — no ceiling to find').toBe(
        false,
      );
      return {
        topicMax: await largestAccepted(insertTopic, 1, 20000),
        handleMax: await largestAccepted(insertHandle, 1, 20000),
      };
    });

    expect(
      MAX_INDEXED_BYTES,
      `this server indexes topics up to ${topicMax} bytes; the screen budgets ${MAX_INDEXED_BYTES}`,
    ).toBe(topicMax);
    expect(
      MAX_INDEXED_BYTES,
      `this server indexes handles up to ${handleMax} bytes; the screen budgets ${MAX_INDEXED_BYTES}`,
    ).toBeLessThanOrEqual(handleMax);
  }, 60000);

  it.each([
    ['post', 'topic'],
    ['fetchRecent', 'topic'],
    ['subscribe', 'topic'],
    ['post', 'handle'],
    ['resolveIdentity', 'handle'],
  ])('%s refuses an oversized %s by name rather than letting the server answer', async (call, field) => {
    const long = incompressible(MAX_INDEXED_BYTES + 1, 7);
    const topic = asTopic(field === 'topic' ? long : `budget-${rand()}`);
    const handle = asHandle(field === 'handle' ? long : 'u');
    const attempt =
      call === 'post'
        ? plugin.post(topic, handle, 'hi')
        : call === 'fetchRecent'
          ? plugin.fetchRecent({ topic })
          : call === 'subscribe'
            ? plugin.subscribe(topic, () => undefined)
            : plugin.resolveIdentity(handle);

    const message = await attempt.then(
      () => 'RESOLVED',
      (e: unknown) => (e as Error).message,
    );
    expect(message).toMatch(new RegExp(`^parley-postgres: invalid ${field} — `));
    expect(message, 'the refusal must say nothing was written').toMatch(/[Nn]othing was written/);
    expect(message, "a driver string, and the deployment's own relation name, reached the caller").not.toMatch(
      /index row size|btree version|54000|_topic_seq|_senders_pkey/,
    );
  }, 30000);
});

const refusalTable = `parley_refuse_${rand()}`;

// The screen above closes the ONE server refusal this plugin now anticipates. The class is every
// other one: a permission the role does not have, a filled disk, a relation dropped under a live
// pool, an index an operator added by hand. `answerAbandoned` and `lockWaitAbandoned` each rename a
// single shape and return everything else with `return err as Error`, so before `serverRefused` any
// other SQLSTATE reached agent context as a bare PostgreSQL string.
describe.skipIf(!up)(`a refusal this plugin never anticipated is still named (${refusalTable})`, () => {
  let plugin: PostgresPlugin;

  beforeAll(async () => {
    plugin = new PostgresPlugin();
    await plugin.connect({ url: PG_URL, table_name: refusalTable, pool_size: 1 });
  });

  afterAll(async () => {
    await plugin.disconnect().catch(() => undefined);
    await dropTable(refusalTable);
  });

  it('an index an operator added by hand refuses a post, and the refusal names this plugin', async () => {
    await withAdmin(async (admin) => {
      await admin.query(`CREATE INDEX "${refusalTable}_content" ON "${refusalTable}" (content)`);
    });
    const message = await plugin
      .post(asTopic(`refuse-${rand()}`), asHandle('u'), incompressible(4000, 8))
      .then(
        () => 'RESOLVED',
        (e: unknown) => (e as Error).message,
      );
    expect(message).toMatch(/^parley-postgres: /);
    expect(message, 'the refusal must say nothing was written').toMatch(/[Nn]othing was written/);
    expect(message, 'the server refused it — this must not read as an accepted post').not.toBe(
      'RESOLVED',
    );
    await withAdmin(async (admin) => {
      await admin.query(`DROP INDEX "${refusalTable}_content"`);
    });
  }, 30000);

  it.each(['post', 'fetchRecent', 'resolveIdentity'])(
    '%s names this plugin when the relation is gone from under it',
    async (call) => {
      const gone = `parley_gone_${rand()}`;
      const solo = new PostgresPlugin();
      await solo.connect({ url: PG_URL, table_name: gone, pool_size: 1 });
      try {
        await withAdmin(async (admin) => {
          await admin.query(`DROP TABLE "${gone}" CASCADE`);
          await admin.query(`DROP TABLE "${gone}_senders" CASCADE`);
        });
        const topic = asTopic(`gone-${rand()}`);
        const attempt =
          call === 'post'
            ? solo.post(topic, asHandle('u'), 'hi')
            : call === 'fetchRecent'
              ? solo.fetchRecent({ topic })
              : solo.resolveIdentity(asHandle('u'));
        const message = await attempt.then(
          () => 'RESOLVED',
          (e: unknown) => (e as Error).message,
        );
        expect(message, 'the relation is gone — this must not read as a success').not.toBe(
          'RESOLVED',
        );
        expect(message).toMatch(/^parley-postgres: /);
        expect(message, 'a bare driver string reached agent context').not.toMatch(
          /^relation |does not exist$/,
        );
      } finally {
        await solo.disconnect().catch(() => undefined);
        await dropTable(gone);
      }
    },
    30000,
  );
});
