import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { openDriver as OpenDriver, SqlDriver } from '../src/driver.js';
import type { SqlitePlugin as SqlitePluginClass } from '../src/index.js';
import { SCHEMA } from '../src/schema.js';

/**
 * Both drivers ship: better-sqlite3 when it loads, Node's built-in `node:sqlite` when it does not
 * (no prebuilt for the ABI and no toolchain). The README promises the code above the driver cannot
 * tell them apart, and every other test in this package resolves better-sqlite3 — so the fallback,
 * the path a user with no native module lands on, was graded by nothing. These cases run one set of
 * assertions against both, so a driver difference (rowid type, PRAGMA read-back shape, `all()`
 * prototypes) cannot ship because the incumbent passed.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const mode = (f: string): number => statSync(f).mode & 0o777;
const dir = () => mkdtempSync(join(tmpdir(), 'parley-parity-'));

const require = createRequire(import.meta.url);
const loadable = (id: string): boolean => {
  try {
    require(id);
    return true;
  } catch {
    return false;
  }
};

const KINDS: Array<SqlDriver['kind']> = ['better-sqlite3', 'node:sqlite'];

/**
 * Load a fresh copy of the package with `better-sqlite3` made to look absent, exactly as an
 * un-prebuilt install does — the memoized ctor in driver.ts is why this needs a module reset rather
 * than a flag.
 */
async function load(kind: SqlDriver['kind']): Promise<{
  openDriver: typeof OpenDriver;
  SqlitePlugin: typeof SqlitePluginClass;
}> {
  vi.resetModules();
  if (kind === 'node:sqlite') {
    vi.doMock('node:module', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:module')>();
      return {
        ...real,
        default: real,
        createRequire: (from: string | URL) => {
          const inner = real.createRequire(from);
          const absent = ((id: string) => {
            if (id === 'better-sqlite3') {
              throw Object.assign(new Error("Cannot find module 'better-sqlite3'"), {
                code: 'MODULE_NOT_FOUND',
              });
            }
            return inner(id) as unknown;
          }) as unknown as NodeJS.Require;
          return Object.assign(absent, inner);
        },
      };
    });
  } else {
    vi.doUnmock('node:module');
  }
  const driver = await import('../src/driver.js');
  const index = await import('../src/index.js');
  return { openDriver: driver.openDriver, SqlitePlugin: index.SqlitePlugin };
}

let open: SqlitePluginClass[] = [];
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
  vi.doUnmock('node:module');
  vi.resetModules();
});

it('grades every driver this package can select at runtime', () => {
  // A silent skip here would certify the fallback on the incumbent's results, so say which driver
  // is missing and why: node:sqlite arrived in Node 22.5, and `engines` allows 22.0.
  expect(loadable('better-sqlite3'), 'better-sqlite3 must load for the parity baseline').toBe(true);
  expect(
    loadable('node:sqlite'),
    `node:sqlite is unavailable on Node ${process.versions.node}; parity for the fallback driver is UNGRADED`,
  ).toBe(true);
});

describe.each(KINDS)('driver parity: %s', (kind) => {
  it('is the driver openDriver selects', async () => {
    const { openDriver } = await load(kind);
    const d = openDriver(join(dir(), 'p.db'));
    expect(d.kind).toBe(kind);
    d.close();
  });

  const PRAGMAS = [
    { name: 'journal_mode', expected: 'wal' },
    { name: 'busy_timeout', expected: 5000 },
    { name: 'synchronous', expected: 1 },
  ];

  it('reads back every pragma the cross-process story rests on', async () => {
    const { openDriver } = await load(kind);
    const d = openDriver(join(dir(), 'p.db'));
    expect(d.kind).toBe(kind);
    for (const p of PRAGMAS) {
      const row = d.prepare(`PRAGMA ${p.name}`).get() as Record<string, unknown>;
      const value = Object.values(row)[0];
      expect(typeof value === 'string' ? value.toLowerCase() : value).toBe(p.expected);
    }
    d.close();
  });

  it('narrows a pre-existing world-readable store and its sidecars to 0600', async () => {
    const { openDriver } = await load(kind);
    const path = join(dir(), 'p.db');
    writeFileSync(path, '');
    chmodSync(path, 0o644);

    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let lines: string[] = [];
    let modes: number[] = [];
    try {
      const d = openDriver(path);
      expect(d.kind).toBe(kind);
      d.exec(SCHEMA);
      d.prepare('INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?,?,?,?,?)').run(
        'ctx',
        'alice',
        'x',
        new Date().toISOString(),
        null,
      );
      lines = spy.mock.calls.map(([l]) => String(l));
      expect(existsSync(`${path}-wal`)).toBe(true);
      modes = ['', '-wal', '-shm'].map((s) => mode(`${path}${s}`));
      d.close();
    } finally {
      spy.mockRestore();
    }
    expect(modes).toEqual([0o600, 0o600, 0o600]);
    expect(lines.some((l) => /tightened/.test(l) && l.includes(path))).toBe(true);
  });

  it('reports an insert through the same RunResult shape', async () => {
    const { openDriver } = await load(kind);
    const d = openDriver(join(dir(), 'p.db'));
    expect(d.kind).toBe(kind);
    d.exec(SCHEMA);
    const stmt = d.prepare(
      'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?,?,?,?,?)',
    );
    const info = stmt.run('ctx', 'alice', 'first', new Date().toISOString(), null);
    expect(Number(info.lastInsertRowid)).toBe(1);
    expect(Number(info.changes)).toBe(1);
    const second = stmt.run('ctx', 'alice', 'second', new Date().toISOString(), null);
    expect(Number(second.lastInsertRowid)).toBe(2);

    const rows = d.prepare('SELECT id, content FROM messages ORDER BY id').all() as Array<{
      id: number;
      content: string;
    }>;
    expect(rows.map((r) => [Number(r.id), r.content])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
    d.close();
  });

  it('carries the whole seam round-trip: post, fetchRecent, subscribe, disconnect', async () => {
    const { SqlitePlugin } = await load(kind);
    const p = new SqlitePlugin();
    open.push(p);
    await p.connect({ db_path: join(dir(), 'p.db'), poll_interval_ms: 10 });
    expect((p as unknown as { driver: SqlDriver }).driver.kind).toBe(kind);

    const first = await p.post(T, me, 'history');
    expect(first).toBe('1');

    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.post(T, me, 'live @bob');
    await vi.waitFor(() => expect(got).toEqual(['live @bob']), { timeout: 3000, interval: 5 });

    const { messages, nextCursor } = await p.fetchRecent({ topic: T });
    expect(messages.map((m) => m.content)).toEqual(['history', 'live @bob']);
    expect(messages.map((m) => m.backendMsgId)).toEqual(['1', '2']);
    expect(messages[1]!.mentions).toEqual(['bob']);
    expect(messages[1]!.cursor).toMatch(/^[0-9a-f]{16}\.2$/);
    expect(nextCursor).toBe(messages[1]!.cursor);

    const tail = await p.fetchRecent({ topic: T, since: nextCursor });
    expect(tail.messages).toEqual([]);
    expect(tail.nextCursor).toBe(nextCursor);

    await p.disconnect();
    await expect(p.post(T, me, 'after-teardown')).rejects.toThrow(/not connected/);
  });
});
