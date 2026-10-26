import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyDbError, type DbErrorClass } from '../src/classify.js';
import { NODE_SQLITE_MIN, type openDriver as OpenDriver, type SqlDriver } from '../src/driver.js';
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
async function loadWithout(missing: string[]): Promise<{
  openDriver: typeof OpenDriver;
  SqlitePlugin: typeof SqlitePluginClass;
}> {
  vi.resetModules();
  if (missing.length > 0) {
    vi.doMock('node:module', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:module')>();
      return {
        ...real,
        default: real,
        createRequire: (from: string | URL) => {
          const inner = real.createRequire(from);
          const absent = ((id: string) => {
            if (missing.includes(id)) {
              // A builtin this Node predates fails with its own code, not MODULE_NOT_FOUND.
              throw Object.assign(new Error(`Cannot find module '${id}'`), {
                code: id.startsWith('node:') ? 'ERR_UNKNOWN_BUILTIN_MODULE' : 'MODULE_NOT_FOUND',
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

const load = (kind: SqlDriver['kind']): ReturnType<typeof loadWithout> =>
  loadWithout(kind === 'node:sqlite' ? ['better-sqlite3'] : []);

let open: SqlitePluginClass[] = [];
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
  vi.doUnmock('node:module');
  vi.resetModules();
});

it('grades every driver this package can select at runtime', () => {
  // A silent skip here would certify the fallback on the incumbent's results, so say which driver
  // is missing and why: node:sqlite arrived in Node 22.5, which is this package's declared floor.
  expect(loadable('better-sqlite3'), 'better-sqlite3 must load for the parity baseline').toBe(true);
  expect(
    loadable('node:sqlite'),
    `node:sqlite is unavailable on Node ${process.versions.node}; parity for the fallback driver is UNGRADED`,
  ).toBe(true);
});

/**
 * `engines` keeps this package off a Node that has neither driver; the message is what an operator
 * gets when they land there anyway — a runtime downgrade under an existing install, or an install
 * that ignored the engine warning. "fallback failed" alone names neither the cause nor the fix.
 */
it('with neither driver available, the failure names the Node version node:sqlite needs', async () => {
  const { openDriver } = await loadWithout(['better-sqlite3', 'node:sqlite']);
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const attempt = (): SqlDriver => openDriver(join(dir(), 'p.db'));
    expect(attempt).toThrow(new RegExp(`node:sqlite requires Node >= ${NODE_SQLITE_MIN}`));
    expect(attempt).toThrow(process.versions.node);
    expect(attempt).toThrow(/better-sqlite3/);
    const lines = spy.mock.calls.map(([l]) => String(l));
    expect(lines.filter((l) => l.includes(NODE_SQLITE_MIN)).length).toBeGreaterThan(0);
  } finally {
    spy.mockRestore();
  }
});

/**
 * `classifyDbError` decides whether a failing background tick is silent, backed off, or fatal, and
 * it reaches that decision from an error's `code` OR its message. Only the message arms ever fire on
 * node:sqlite, which stamps `ERR_SQLITE_ERROR` on every class it raises — so a decision table built
 * from hand-written better-sqlite3-shaped errors grades the incumbent twice and leaves the
 * fallback's only working arm untested. Deleting both message arms is invisible to such a table and
 * costs a node:sqlite install every classification it has: contention becomes a stderr line per
 * topic per minute, and corruption stops looking fatal.
 *
 * So the driver is a DIMENSION here, as it already is for the seam in conformance.test.ts, and
 * every error below is raised BY the driver under test rather than constructed to match an arm.
 */
interface Provocation {
  name: string;
  expected: DbErrorClass;
  /** Do something that makes the driver throw. Push every driver opened onto `opened`. */
  raise(openDriver: typeof OpenDriver, path: string, opened: SqlDriver[]): void;
}

const INSERT = 'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?,?,?,?,?)';
const insert = (d: SqlDriver): void => {
  d.prepare(INSERT).run('ctx', 'alice', 'x', new Date().toISOString(), null);
};

const PROVOCATIONS: Provocation[] = [
  {
    name: 'a write held off by another connection’s write lock',
    expected: 'lock',
    raise: (openDriver, path, opened) => {
      const holder = openDriver(path);
      opened.push(holder);
      holder.exec(SCHEMA);
      holder.exec('BEGIN IMMEDIATE');
      insert(holder);
      // busy_timeout 0, so the contender reports the lock instead of waiting out the default 5 s.
      const contender = openDriver(path, { busyTimeoutMs: 0 });
      opened.push(contender);
      contender.exec('BEGIN IMMEDIATE');
      insert(contender);
    },
  },
  {
    name: 'a store whose bytes are not a database',
    expected: 'fatal',
    raise: (openDriver, path, opened) => {
      writeFileSync(path, Buffer.from('this is not a SQLite file and never was'));
      const d = openDriver(path);
      opened.push(d);
      d.prepare('SELECT count(*) FROM sqlite_master').get();
    },
  },
  {
    name: 'a query against a table that is not there',
    expected: 'fatal',
    raise: (openDriver, path, opened) => {
      const d = openDriver(path);
      opened.push(d);
      d.prepare('SELECT id FROM messages').all();
    },
  },
  {
    name: 'a write to a store the connection may not write',
    expected: 'unavailable',
    raise: (openDriver, path, opened) => {
      const d = openDriver(path);
      opened.push(d);
      d.exec(SCHEMA);
      // `query_only` reproduces the README's read-only remount from inside the process, so the case
      // grades the same SQLITE_READONLY a root-owned test run could never provoke with chmod.
      d.exec('PRAGMA query_only = true');
      insert(d);
    },
  },
];

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

  /**
   * At-rest hardening is graded in test/at-rest-mode.test.ts against whichever driver resolves —
   * but both drivers are reached by the same `db_path`, and they do not agree on what one means:
   * node:sqlite resolves SQLite URIs, better-sqlite3 opens a file literally named after one. So the
   * file that has to be narrowed is a DIFFERENT file per driver, and any rule written over the
   * string protects at most one of them. Read the expectation off the directory instead — whatever
   * this driver put there is this driver's store, whichever name it went in under.
   */
  const PATH_FORMS = [
    ':memory:',
    'p.db',
    'p.db?x=1',
    'file::memory:',
    'file::memory:?cache=shared',
    'file:p.db',
  ];

  for (const spec of PATH_FORMS) {
    it(`${JSON.stringify(spec)}: leaves nothing on disk readable beyond its owner`, async () => {
      const { openDriver } = await load(kind);
      const here = dir();
      const previousCwd = process.cwd();
      const previousUmask = process.umask(0o022);
      process.chdir(here);
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let left: Array<[string, number]> = [];
      let d: SqlDriver | undefined;
      try {
        try {
          d = openDriver(spec);
          expect(d.kind).toBe(kind);
          d.exec('CREATE TABLE t (x)');
          d.prepare('INSERT INTO t (x) VALUES (?)').run(1);
        } catch {
          // A form this driver refuses still has to leave nothing exposed behind it.
        }
        // Read the directory before close(): the checkpoint on close removes the sidecars.
        left = readdirSync(here)
          .sort()
          .map((f) => [f, mode(join(here, f))]);
      } finally {
        d?.close();
        spy.mockRestore();
        process.chdir(previousCwd);
        process.umask(previousUmask);
      }
      expect(
        left.filter(([, m]) => (m & 0o077) !== 0),
        `${kind} left part of the store at ${JSON.stringify(spec)} readable by other accounts`,
      ).toEqual([]);
    });
  }

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

  for (const p of PROVOCATIONS) {
    it(`classifies ${p.name} as ${p.expected}, from an error this driver raised`, async () => {
      const { openDriver } = await load(kind);
      const opened: SqlDriver[] = [];
      let caught: unknown;
      try {
        p.raise(openDriver, join(dir(), 'p.db'), opened);
      } catch (e) {
        caught = e;
      } finally {
        for (const d of opened) {
          try {
            d.close();
          } catch {
            // A driver already closed by the failure path is not what this case grades.
          }
        }
      }
      // Without this the case can pass by provoking nothing: `classifyDbError(undefined)` is a
      // total function that answers 'unavailable' for anything it does not recognise.
      expect(caught, `${p.name} raised nothing on ${kind} — the case grades no error at all`).toBeInstanceOf(Error);
      // And without this it can pass on an error the DRIVER never produced — an fs ENOENT from the
      // pre-create step classifies 'unavailable' just as convincingly as a real SQLITE_READONLY.
      expect(
        (caught as { code?: unknown }).code,
        `${p.name} on ${kind} raised a non-SQLite error; the driver's own shape is the point`,
      ).toMatch(/^(SQLITE_|ERR_SQLITE_)/);
      expect(classifyDbError(caught)).toBe(p.expected);
    });
  }

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
