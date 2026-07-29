import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCursor, asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

/**
 * A `since` cursor minted against a previous DB lifetime (recreated file, `:memory:`) points past
 * this DB's high-water mark. Whatever the guard does with it, catch-up must still be lossless:
 * paging from the stale fetch onward has to yield the whole topic, in order, with no gap — and the
 * answer must not depend on how the topic's size compares to `limit`.
 */

const me = asHandle('alice');
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-cursor-')), 'p.db');

let open: SqlitePlugin[] = [];
async function plugin(): Promise<SqlitePlugin> {
  const p = new SqlitePlugin();
  await p.connect({ db_path: dbFile(), poll_interval_ms: 20 });
  open.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

async function drainFrom(
  p: SqlitePlugin,
  topic: Topic,
  since: Cursor,
  limit: number,
): Promise<{ contents: string[]; cursors: string[] }> {
  const contents: string[] = [];
  const cursors: string[] = [];
  let cursor = since;
  for (let page = 0; page < 1000; page++) {
    const res = await p.fetchRecent({ topic, since: cursor, limit });
    for (const m of res.messages) {
      contents.push(m.content);
      cursors.push(m.cursor);
    }
    if (res.messages.length === 0) return { contents, cursors };
    cursor = res.nextCursor;
  }
  throw new Error('paging did not terminate');
}

const LIMITS = [1, 3, 50];

describe('stale-cursor catch-up is lossless for every (rows, limit)', () => {
  for (const limit of LIMITS) {
    for (const rows of [0, 1, limit - 1, limit, limit + 1, 3 * limit]) {
      if (rows < 0) continue;
      it(`limit ${limit}, ${rows} rows in the topic`, async () => {
        const p = await plugin();
        const t = asTopic(`t-${limit}-${rows}`);
        const expected = Array.from({ length: rows }, (_u, i) => `m${i + 1}`);
        for (const c of expected) await p.post(t, me, c);
        // Another topic keeps the DB's high-water mark alive even when `t` is empty, so the
        // empty-topic and populated-topic paths get the same kind of stale cursor.
        await p.post(asTopic('other'), me, 'noise');

        const stale = asCursor(String(10_000 + rows));
        const drained = await drainFrom(p, t, stale, limit);
        expect(drained.contents).toEqual(expected);
        // Cursors stay strictly increasing across pages — no repeats, no backtracking.
        const ids = drained.cursors.map((c) => Number(c));
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(new Set(ids).size).toBe(ids.length);
      });
    }
  }

  it('an empty topic and a populated one answer a stale cursor the same way', async () => {
    const p = await plugin();
    const empty = asTopic('empty');
    const full = asTopic('full');
    for (let i = 0; i < 5; i++) await p.post(full, me, `m${i}`);

    const stale = asCursor('99999');
    const emptyRes = await p.fetchRecent({ topic: empty, since: stale, limit: 2 });
    expect(emptyRes.messages).toEqual([]);
    expect(emptyRes.nextCursor).toBe('0');

    // The populated topic replays from the same origin rather than jumping to its tail: the first
    // page starts at the topic's very first message.
    const fullRes = await p.fetchRecent({ topic: full, since: stale, limit: 2 });
    expect(fullRes.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
  });
});
