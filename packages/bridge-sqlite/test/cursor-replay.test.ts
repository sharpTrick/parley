import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCursor, asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

/**
 * Core's read-state outlives the database, so `since` can name a store that no longer exists: a
 * recreated file, a `:memory:` process, or another backend's numeric cursor arriving through
 * mis-namespaced read-state. Every such cursor must REPLAY the topic — the one thing it must never
 * do is bind `id > <foreign rowid>` and skip whatever sits below it, silently, behind a
 * `nextCursor` that claims those messages were read.
 */

const me = asHandle('alice');
const T = asTopic('ctx');

let open: SqlitePlugin[] = [];
let dirs: string[] = [];

function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-cursor-'));
  dirs.push(d);
  return join(d, 'p.db');
}

async function plugin(path = dbPath()): Promise<SqlitePlugin> {
  const p = new SqlitePlugin();
  await p.connect({ db_path: path, poll_interval_ms: 20 });
  open.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Wipe the database file and its sidecars, then reopen the same path — a store reset. */
async function reset(p: SqlitePlugin, path: string): Promise<SqlitePlugin> {
  await p.disconnect();
  open = open.filter((o) => o !== p);
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  return plugin(path);
}

async function fill(p: SqlitePlugin, topic: Topic, contents: string[]): Promise<void> {
  for (const c of contents) await p.post(topic, me, c);
}

async function storeIdOf(p: SqlitePlugin): Promise<string> {
  const probe = asTopic('store-id-probe');
  await p.post(probe, me, 'probe');
  const { nextCursor } = await p.fetchRecent({ topic: probe });
  return nextCursor.split('.')[0]!;
}

/** Page from `since` to exhaustion — what catch-up as a whole surfaces, not one page of it. */
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

function expectStrictlyIncreasing(cursors: string[]): void {
  const ids = cursors.map((c) => Number(c.split('.').at(-1)));
  expect(ids.some(Number.isNaN)).toBe(false);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(ids.length);
}

/**
 * Well-formed cursors belonging to some other store. The rowids straddle a 7-row topic's
 * high-water mark on purpose: a foreign cursor BELOW that mark is exactly the one a high-water
 * heuristic mistakes for its own and quietly resumes after.
 */
const FOREIGN_CURSORS: Array<{ name: string; make: (otherStoreId: string) => string }> = [
  { name: 'a bare rowid below the high-water mark (nats seq, postgres bigserial)', make: () => '3' },
  { name: 'a bare rowid at the high-water mark', make: () => '7' },
  { name: 'a bare rowid above the high-water mark', make: () => '10000' },
  { name: 'a telegram-sized bare id', make: () => '123456789' },
  { name: 'another store’s cursor, low rowid', make: (other) => `${other}.2` },
  { name: 'another store’s cursor, high rowid', make: (other) => `${other}.99999` },
];

describe('a cursor from another store replays the topic instead of skipping it', () => {
  for (const shape of FOREIGN_CURSORS) {
    it(shape.name, async () => {
      const expected = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
      const p = await plugin();
      await fill(p, T, expected);
      const otherStoreId = await storeIdOf(await plugin());

      const drained = await drainFrom(p, T, asCursor(shape.make(otherStoreId)), 3);
      expect(drained.contents).toEqual(expected);
      expectStrictlyIncreasing(drained.cursors);
    });
  }

  it('a cursor this store minted is still exclusive, not replayed', async () => {
    const p = await plugin();
    await fill(p, T, ['m0', 'm1', 'm2']);
    const { messages } = await p.fetchRecent({ topic: T });
    const afterFirst = await p.fetchRecent({ topic: T, since: messages[0]!.cursor });
    expect(afterFirst.messages.map((m) => m.content)).toEqual(['m1', 'm2']);
    expect(afterFirst.nextCursor).toBe(messages[2]!.cursor);
  });
});

const SIZES = [0, 1, 5, 50];

describe('catch-up across a real store reset loses nothing', () => {
  for (const before of SIZES) {
    for (const after of SIZES) {
      it(`${before} rows before the reset, ${after} rows after`, async () => {
        const path = dbPath();
        const old = await plugin(path);
        await fill(old, T, Array.from({ length: before }, (_u, i) => `old-${i}`));
        const staleCursor = (await old.fetchRecent({ topic: T, limit: 500 })).nextCursor;

        const fresh = await reset(old, path);
        const expected = Array.from({ length: after }, (_u, i) => `new-${i}`);
        await fill(fresh, T, expected);

        const drained = await drainFrom(fresh, T, staleCursor, 3);
        expect(drained.contents).toEqual(expected);
        expectStrictlyIncreasing(drained.cursors);
      });
    }
  }
});

describe('replay pages losslessly at every limit', () => {
  for (const limit of [1, 2, 5, 50]) {
    it(`limit ${limit}`, async () => {
      const expected = Array.from({ length: 7 }, (_u, i) => `m${i}`);
      const p = await plugin();
      await fill(p, T, expected);
      const drained = await drainFrom(p, T, asCursor('4'), limit);
      expect(drained.contents).toEqual(expected);
      expectStrictlyIncreasing(drained.cursors);
    });
  }

  it('an empty topic answers a foreign cursor with a replayable cursor of this store', async () => {
    const p = await plugin();
    await fill(p, asTopic('other'), ['noise']);
    const empty = asTopic('empty');

    const first = await p.fetchRecent({ topic: empty, since: asCursor('99999'), limit: 2 });
    expect(first.messages).toEqual([]);
    expect(first.nextCursor).toBe(`${await storeIdOf(p)}.0`);

    const again = await p.fetchRecent({ topic: empty, since: first.nextCursor, limit: 2 });
    expect(again.messages).toEqual([]);
    expect(again.nextCursor).toBe(first.nextCursor);
  });
});

/**
 * A cursor whose shape this backend cannot place at all must throw. Absorbing it would bind SQL
 * NULL, match zero rows with no error, and re-echo itself as `nextCursor` — wedging the topic
 * forever rather than losing one page.
 */
const MALFORMED_CURSORS = [
  '',
  's123_456',
  'abc.5',
  'zzzzzzzzzzzzzzzz.1',
  '1.2.3',
  '-1',
  '1e3',
  '5 ',
];

describe('a malformed cursor throws instead of silently matching nothing', () => {
  for (const since of MALFORMED_CURSORS) {
    it(`rejects ${JSON.stringify(since)}`, async () => {
      const p = await plugin();
      await fill(p, T, ['a', 'b']);
      await expect(p.fetchRecent({ topic: T, since: asCursor(since) })).rejects.toThrow(
        /parley-sqlite: malformed cursor/,
      );
    });
  }
});
