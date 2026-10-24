import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectPoisonCostsOneMessage, POISON_RECORD_CLAUSE } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Cursor, type Message } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '../src/driver.js';
import { SqlitePlugin } from '../src/index.js';

/**
 * This backend's poison record: `content` is declared `TEXT NOT NULL`, but SQLite's TEXT affinity
 * does not CONVERT a BLOB, so any peer writing the same file can leave a row whose `content` comes
 * back as a Buffer — and `rowToMessage` -> `buildMessage` -> `parseMentions` throws on it. Planted
 * from a second connection for exactly that reason: the plugin's own `post` cannot write one.
 */
const require = createRequire(import.meta.url);

interface RawDb {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

const T = asTopic('poison');
const INTERVAL_MS = 1000;

let plugin: InstanceType<typeof SqlitePlugin>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await plugin.disconnect();
  vi.useRealTimers();
});

it(POISON_RECORD_CLAUSE, async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'parley-poison-')), 'p.db');
  plugin = new SqlitePlugin();
  await plugin.connect({ db_path: dbPath, poll_interval_ms: INTERVAL_MS });

  const delivered: Message[] = [];
  await plugin.subscribe(T, (m) => {
    delivered.push(m);
  });

  await expectPoisonCostsOneMessage({
    survivors: ['first', 'third'],
    plant: () => {
      const Database = require('better-sqlite3') as new (path: string) => RawDb;
      const peer = new Database(dbPath);
      const insert = peer.prepare(
        'INSERT INTO messages (topic, sender, content, ts) VALUES (?, ?, ?, ?)',
      );
      const ts = new Date().toISOString();
      insert.run(T, 'alice', 'first', ts);
      insert.run(T, 'alice', Buffer.from([0x00, 0xff]), ts);
      insert.run(T, 'alice', 'third', ts);
      peer.close();
    },
    settle: async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    },
    delivered: () => delivered.map((m) => m.content),
  });
});

/**
 * The catch-up half of the same clause. A page that rejects is worse than a dropped record here:
 * core rethrows it, so the bridge fails every start, and nothing past the poison row is reachable
 * by catch-up at all. And an EMPTY page is what every caller reads as "topic exhausted", so a page
 * made only of poison must not come back empty while convertible rows still sit above it.
 */
type Kind = SqlDriver['kind'];
const KINDS: Kind[] = ['better-sqlite3', 'node:sqlite'];
const P = Symbol('poison');
type Slot = string | typeof P;
const PAGE = 3;

async function pluginFor(kind: Kind): Promise<typeof SqlitePlugin> {
  vi.resetModules();
  if (kind === 'better-sqlite3') {
    vi.doUnmock('node:module');
  } else {
    vi.doMock('node:module', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:module')>();
      return {
        ...real,
        default: real,
        createRequire: (from: string | URL) => {
          const inner = real.createRequire(from);
          const absent = ((id: string) => {
            if (id === 'better-sqlite3') {
              throw Object.assign(new Error(`Cannot find module '${id}'`), {
                code: 'MODULE_NOT_FOUND',
              });
            }
            return inner(id) as unknown;
          }) as unknown as NodeJS.Require;
          return Object.assign(absent, inner);
        },
      };
    });
  }
  return (await import('../src/index.js')).SqlitePlugin;
}

const LAYOUTS: Array<[string, Slot[]]> = [
  ['first row of a page', [P, 'a', 'b', 'c', 'd']],
  ['middle row of a page', ['a', P, 'b', 'c']],
  ['last row of a page', ['a', 'b', P, 'c']],
  ['a whole page, rows above it', [P, P, P, 'a', 'b']],
  ['several whole pages, rows above them', [P, P, P, P, P, P, P, 'a']],
  ['a whole page at the head', ['a', 'b', 'c', P, P, P]],
  ['the only row', [P]],
  ['scattered across pages', [P, 'a', P, P, P, P, 'b', P]],
];

describe.each(KINDS)('catch-up through a poison record (%s)', (kind) => {
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'parley-poison-')), 'p.db');
    const Plugin = await pluginFor(kind);
    plugin = new Plugin();
    await plugin.connect({ db_path: dbPath, poll_interval_ms: INTERVAL_MS });
    expect((plugin as unknown as { driver: SqlDriver }).driver.kind).toBe(kind);
  });

  afterEach(() => {
    vi.doUnmock('node:module');
  });

  const plant = (slots: Slot[]): void => {
    const Database = require('better-sqlite3') as new (path: string) => RawDb;
    const peer = new Database(dbPath);
    const insert = peer.prepare('INSERT INTO messages (topic, sender, content, ts) VALUES (?, ?, ?, ?)');
    const ts = new Date().toISOString();
    for (const s of slots) insert.run(T, 'alice', s === P ? Buffer.from([0x00, 0xff]) : s, ts);
    peer.close();
  };

  it.each(LAYOUTS)(`${POISON_RECORD_CLAUSE}: poison as %s, paged from a cursor`, async (_n, slots) => {
    const start = (await plugin.fetchRecent({ topic: T })).nextCursor;
    plant(slots);
    const errs = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      // Core's own exhaustion rule: an empty page, or one that made no cursor progress.
      const got: string[] = [];
      let since = start;
      let exhaustedAt: Cursor | undefined;
      for (let i = 0; i < slots.length + 2; i++) {
        const { messages, nextCursor } = await plugin.fetchRecent({ topic: T, since, limit: PAGE });
        expect(messages.length).toBeLessThanOrEqual(PAGE);
        got.push(...messages.map((m) => m.content));
        if (messages.length === 0 || nextCursor === since) {
          exhaustedAt = nextCursor;
          break;
        }
        since = nextCursor;
      }
      expect(got).toEqual(slots.filter((s) => s !== P));
      // The page that reads as exhausted hands back the topic's head, past every poison row, so
      // the next read does not re-scan them, and a row posted now is the only thing it serves.
      const head = (await plugin.fetchRecent({ topic: T, limit: 1 })).nextCursor;
      expect(exhaustedAt).toEqual(head);
      const tail = await plugin.fetchRecent({ topic: T, since: head, limit: PAGE });
      expect(tail.messages).toEqual([]);
      await plugin.post(T, asHandle('bob'), 'after');
      const after = await plugin.fetchRecent({ topic: T, since: tail.nextCursor, limit: PAGE });
      expect(after.messages.map((m) => m.content)).toEqual(['after']);
      expect(errs.mock.calls.some(([l]) => String(l).includes('unconvertible'))).toBe(true);
    } finally {
      errs.mockRestore();
    }
  });

  it.each(LAYOUTS)(`${POISON_RECORD_CLAUSE}: poison as %s, the since-less window`, async (_n, slots) => {
    plant(slots);
    const errs = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const { messages, nextCursor } = await plugin.fetchRecent({ topic: T, limit: PAGE });
      expect(messages.map((m) => m.content)).toEqual(slots.slice(-PAGE).filter((s) => s !== P));
      const tail = await plugin.fetchRecent({ topic: T, since: nextCursor, limit: PAGE });
      expect(tail.messages).toEqual([]);
    } finally {
      errs.mockRestore();
    }
  });
});
