import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openDriver } from '../src/driver.js';
import { SqlitePlugin } from '../src/index.js';
import { SCHEMA } from '../src/schema.js';

/**
 * The cross-process story rests on three things a bug can silently remove: the pragmas openDriver
 * sets, the retry they buy the shipped write path, and the schema every writer agrees on. Each is
 * asserted here through an observable consequence, not through the source that sets it.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const dir = () => mkdtempSync(join(tmpdir(), 'parley-mp-'));
const lockHolder = fileURLToPath(new URL('./lock-holder.mjs', import.meta.url));
const writerScript = fileURLToPath(new URL('../src/concurrent-writer.mjs', import.meta.url));

const require = createRequire(import.meta.url);
interface RawConn {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown };
  close(): void;
}
const BetterCtor: (new (p: string) => RawConn) | null = (() => {
  try {
    return require('better-sqlite3') as new (p: string) => RawConn;
  } catch {
    return null;
  }
})();

let open: SqlitePlugin[] = [];
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

/**
 * Every pragma the driver sets buys a property and costs one. A pragma listed under
 * "cross-process safety" whose cost goes unstated reads as free — `synchronous = NORMAL` is the
 * live example: a committed post can be lost on power loss, in the store DESIGN calls the durable
 * source of truth. Each entry therefore carries the consequence its README line has to state.
 */
const PRAGMAS = [
  { name: 'journal_mode', expected: 'wal', consequence: /readers never block the writer/i },
  { name: 'busy_timeout', expected: 5000, consequence: /retries instead of erroring/i },
  { name: 'synchronous', expected: 1, consequence: /lost on power loss/i },
];

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

describe('driver pragmas are observable, not just set', () => {
  for (const p of PRAGMAS) {
    it(`${p.name} reads back as ${String(p.expected)} on a driver-opened DB`, () => {
      const path = join(dir(), 'p.db');
      const d = openDriver(path);
      const row = d.prepare(`PRAGMA ${p.name}`).get() as Record<string, unknown>;
      const value = Object.values(row)[0];
      expect(typeof value === 'string' ? value.toLowerCase() : value).toBe(p.expected);
      d.close();
    });

    it(`${p.name} is documented with its consequence, not just its name`, () => {
      expect(README).toContain(p.name);
      expect(README).toMatch(p.consequence);
    });
  }

  it('WAL is live on disk: a write materializes the -wal sidecar', () => {
    const path = join(dir(), 'p.db');
    const d = openDriver(path);
    d.exec(SCHEMA);
    d.prepare('INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?,?,?,?,?)').run(
      'ctx',
      'alice',
      'x',
      new Date().toISOString(),
      null,
    );
    expect(existsSync(`${path}-wal`)).toBe(true);
    d.close();
  });
});

describe.skipIf(BetterCtor === null)('busy_timeout is what makes a contended write survive', () => {
  it('a configured timeout retries for its full window; 0 gives up at once', () => {
    const path = join(dir(), 'p.db');
    const seed = openDriver(path);
    seed.exec(SCHEMA);

    const holder = new (BetterCtor as new (p: string) => RawConn)(path);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare(
      'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?,?,?,?,?)',
    ).run('ctx', 'holder', 'x', new Date().toISOString(), null);

    const elapsed = (busyTimeoutMs: number): number => {
      const d = openDriver(path, { busyTimeoutMs });
      const started = Date.now();
      expect(() =>
        d
          .prepare('INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?,?,?,?,?)')
          .run('ctx', 'other', 'y', new Date().toISOString(), null),
      ).toThrow(/locked/i);
      const took = Date.now() - started;
      d.close();
      return took;
    };

    expect(elapsed(0)).toBeLessThan(150);
    expect(elapsed(400)).toBeGreaterThanOrEqual(350);

    holder.exec('COMMIT');
    holder.close();
    seed.close();
  });

  it("SqlitePlugin.post() waits out another OS process's write lock instead of throwing", async () => {
    const path = join(dir(), 'p.db');
    const plugin = new SqlitePlugin();
    open.push(plugin);
    await plugin.connect({ db_path: path, poll_interval_ms: 20 });

    const child = fork(lockHolder, [path, '400']);
    await new Promise<void>((resolve, reject) => {
      child.on('message', (m) => {
        if (m === 'locked') resolve();
      });
      child.on('error', reject);
      child.on('exit', () => {
        reject(new Error('lock holder exited before taking the lock'));
      });
    });

    const started = Date.now();
    await expect(plugin.post(T, me, 'through-contention')).resolves.toMatch(/^\d+$/);
    // It really was contended — the write could not have landed before the holder released.
    expect(Date.now() - started).toBeGreaterThan(100);

    await new Promise((r) => child.on('exit', r));
    const { messages } = await plugin.fetchRecent({ topic: T });
    expect(messages.map((m) => m.content)).toEqual(['through-contention']);
  });
});

describe('one schema, many creators', () => {
  const creators: Array<{ name: string; create: (path: string) => Promise<void> }> = [
    {
      name: 'SqlitePlugin.connect',
      create: async (path) => {
        const p = new SqlitePlugin();
        await p.connect({ db_path: path, poll_interval_ms: 20 });
        await p.disconnect();
      },
    },
    {
      name: 'concurrent-writer.mjs',
      create: (path) =>
        new Promise<void>((resolve, reject) => {
          const child = fork(writerScript, [path, 'ctx', '1', 'w0']);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`writer exited ${String(code)}`)),
          );
          child.on('error', reject);
        }),
    },
  ];

  it('every creator of the messages table produces byte-identical DDL', async () => {
    const schemas: string[] = [];
    for (const creator of creators) {
      const path = join(dir(), 'p.db');
      await creator.create(path);
      const d = openDriver(path);
      const rows = d
        .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string; sql: string }>;
      d.close();
      schemas.push(JSON.stringify(rows, null, 2));
    }
    expect(schemas[1]).toBe(schemas[0]);
  });
});
