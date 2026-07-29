import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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

const SIDECARS = ['', '-wal', '-shm'] as const;

/** Close the store, act on its files while nothing holds them open, reopen the same path. */
async function reopen(
  p: SqlitePlugin,
  path: string,
  act: () => void,
): Promise<SqlitePlugin> {
  await p.disconnect();
  open = open.filter((o) => o !== p);
  act();
  return plugin(path);
}

/** Wipe the database file and its sidecars, then reopen the same path — a store reset. */
const reset = (p: SqlitePlugin, path: string): Promise<SqlitePlugin> =>
  reopen(p, path, () => {
    for (const s of SIDECARS) rmSync(`${path}${s}`, { force: true });
  });

function copyStore(from: string, to: string): void {
  for (const s of SIDECARS) {
    rmSync(`${to}${s}`, { force: true });
    if (existsSync(`${from}${s}`)) copyFileSync(`${from}${s}`, `${to}${s}`);
  }
}

async function fill(p: SqlitePlugin, topic: Topic, contents: string[]): Promise<void> {
  for (const c of contents) await p.post(topic, me, c);
}

/** Read the store's identity off an empty topic's replayable cursor, without writing to it. */
async function storeIdOf(p: SqlitePlugin): Promise<string> {
  const { nextCursor } = await p.fetchRecent({ topic: asTopic('store-id-probe') });
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
 * Well-formed cursors this store cannot honour. The rowids straddle a 7-row topic's high-water
 * mark on purpose: a cursor BELOW that mark is exactly the one a high-water heuristic mistakes for
 * its own and quietly resumes after. The last row is this store's OWN id above its high-water mark
 * — what a restore from an older backup leaves core holding — where the store id matches and only
 * the high-water comparison stands between catch-up and skipping the whole restored history.
 */
const UNHONOURABLE_CURSORS: Array<{
  name: string;
  make: (ids: { other: string; own: string }) => string;
}> = [
  { name: 'a bare rowid below the high-water mark (nats seq, postgres bigserial)', make: () => '3' },
  { name: 'a bare rowid at the high-water mark', make: () => '7' },
  { name: 'a bare rowid above the high-water mark', make: () => '10000' },
  { name: 'a telegram-sized bare id', make: () => '123456789' },
  { name: 'another store’s cursor, low rowid', make: ({ other }) => `${other}.2` },
  { name: 'another store’s cursor, high rowid', make: ({ other }) => `${other}.99999` },
  { name: 'this store’s own cursor one past the high-water mark', make: ({ own }) => `${own}.8` },
  { name: 'this store’s own cursor far above the high-water mark', make: ({ own }) => `${own}.99999` },
];

describe('a cursor this store cannot honour replays the topic instead of skipping it', () => {
  for (const shape of UNHONOURABLE_CURSORS) {
    it(shape.name, async () => {
      const expected = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
      const p = await plugin();
      await fill(p, T, expected);
      const ids = { other: await storeIdOf(await plugin()), own: await storeIdOf(p) };

      const drained = await drainFrom(p, T, asCursor(shape.make(ids)), 3);
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

/**
 * The high-water comparison decides whether a cursor carrying THIS store's id is honoured. It is
 * the only thing between a store restored from an older backup and `id > <future rowid>` matching
 * nothing forever, and it has to read the store-wide AUTOINCREMENT sequence: a per-topic MAX(id)
 * would call a legitimate cursor minted while a busier topic was written "from the future" and
 * replay history the reader already has.
 */
describe('this store’s own cursor is honoured up to the high-water mark and no further', () => {
  const ROWS = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const HONOURED = [
    { rowid: 0, remaining: ROWS },
    { rowid: 1, remaining: ROWS.slice(1) },
    { rowid: 6, remaining: ROWS.slice(6) },
    { rowid: 7, remaining: [] },
  ];

  for (const { rowid, remaining } of HONOURED) {
    it(`rowid ${rowid} resumes exclusively after it`, async () => {
      const p = await plugin();
      await fill(p, T, ROWS);
      const own = await storeIdOf(p);

      const drained = await drainFrom(p, T, asCursor(`${own}.${rowid}`), 3);
      expect(drained.contents).toEqual(remaining);
      expectStrictlyIncreasing(drained.cursors);
    });
  }

  it('the mark is the store-wide sequence, not the topic’s own MAX(id)', async () => {
    const p = await plugin();
    await fill(p, T, ROWS);
    await fill(p, asTopic('busier'), Array.from({ length: 20 }, (_u, i) => `b${i}`));
    const own = await storeIdOf(p);

    const drained = await drainFrom(p, T, asCursor(`${own}.20`), 3);
    expect(drained.contents).toEqual([]);
  });

  it('a store restored from an older backup replays everything the backup still holds', async () => {
    const path = dbPath();
    const backup = dbPath();
    const kept = Array.from({ length: 20 }, (_u, i) => `kept-${i}`);

    let p = await plugin(path);
    await fill(p, T, kept);

    p = await reopen(p, path, () => copyStore(path, backup));
    await fill(p, T, Array.from({ length: 30 }, (_u, i) => `rolled-back-${i}`));
    const tail = (await p.fetchRecent({ topic: T, limit: 500 })).nextCursor;

    p = await reopen(p, path, () => copyStore(backup, path));
    const drained = await drainFrom(p, T, tail, 3);
    expect(drained.contents).toEqual(kept);
    expectStrictlyIncreasing(drained.cursors);
  });
});

/**
 * The `before` dimension only varies which rowid the stale cursor names (none, the first, one well
 * above the new store's high-water mark), so it needs three values rather than a square matrix; the
 * `after` dimension decides whether the replay is empty or paged.
 */
const BEFORE_RESET = [0, 1, 50];
const AFTER_RESET = [0, 50];

describe('catch-up across a real store reset loses nothing', () => {
  for (const before of BEFORE_RESET) {
    for (const after of AFTER_RESET) {
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
