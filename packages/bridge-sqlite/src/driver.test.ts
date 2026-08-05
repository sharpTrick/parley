import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDriver, WAL_RETRIES } from './driver.js';

// The open/lock assertions below exercise native better-sqlite3 semantics specifically (the
// node:sqlite fallback behaves differently), so load it directly and skip those blocks cleanly
// when it is absent — matching openDriver, which only falls back on a module-*load* failure.
const require = createRequire(import.meta.url);
interface RawConn {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown };
  close(): void;
}
const BetterCtor: (new (p: string) => RawConn) | null = (() => {
  try {
    return require('better-sqlite3') as new (p: string) => RawConn;
  } catch {
    return null;
  }
})();

/**
 * At-rest mode is graded once, over every pre-existing store state, in test/at-rest-mode.test.ts —
 * whose 'absent' row is this file's old 0600 case. What is left here is the control: if this
 * environment's umask already strips group/other, that matrix would pass trivially and prove
 * nothing, so say so rather than certifying a mode nothing narrowed.
 */
describe('openDriver file permissions', () => {
  it('has a umask loose enough for the at-rest matrix to mean something', () => {
    const control = join(mkdtempSync(join(tmpdir(), 'parley-sqlite-mode-')), 'control');
    writeFileSync(control, '');
    expect(
      statSync(control).mode & 0o077,
      'umask already strips group/other: the 0600 assertions elsewhere are UNGRADED here',
    ).not.toBe(0);
  });

  it('skips :memory: without throwing', () => {
    const d = openDriver(':memory:');
    expect(() => {
      d.exec('CREATE TABLE t (x)');
      d.prepare('INSERT INTO t (x) VALUES (?)').run(1);
    }).not.toThrow();
    d.close();
  });
});

/**
 * `synchronous = NORMAL` is a WAL-mode bargain: under WAL a power loss costs recent transactions,
 * under a rollback journal it risks the file itself. So what has to hold is the PAIRING, on every
 * way an open can end — including the ones that never reach WAL — rather than either value alone
 * on the one path where both happen to be right.
 *
 * The rows below are how an open ends, not where the code lives: a fresh file, a first-boot
 * conversion a peer holds the write lock through for the whole (synchronous) call, and a store no
 * journal mode can be applied to. Each carries the precondition it claims, so a fixture that stops
 * provoking its own case fails instead of grading nothing.
 */
describe.skipIf(BetterCtor === null)('what an open leaves the journal mode and the sync level at', () => {
  const FULL = 2;
  const BUSY_TIMEOUT_MS = 200;

  const scratch = (name: string): string => join(mkdtempSync(join(tmpdir(), 'parley-sqlite-wal-')), name);
  const read = (d: ReturnType<typeof openDriver>, name: string): unknown =>
    Object.values(d.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

  const OPENS: Array<{
    name: string;
    onDisk: boolean;
    walReachable: boolean;
    arrange(): { path: string; release(): void };
  }> = [
    {
      name: 'a fresh store nothing is contending for',
      onDisk: true,
      walReachable: true,
      arrange: () => ({ path: scratch('p.db'), release: () => {} }),
    },
    {
      name: 'a first-boot conversion a peer holds the write lock through',
      onDisk: true,
      walReachable: false,
      arrange: () => {
        const path = scratch('p.db');
        // A fresh delete-mode file under an IMMEDIATE write lock: the delete→WAL conversion cannot
        // take its exclusive lock, and the lock is held across the whole synchronous open, so no
        // retry budget can reach WAL here. SQLite-level locking, so this provokes as root too.
        const a = new (BetterCtor as new (p: string) => RawConn)(path);
        a.exec('PRAGMA busy_timeout = 0');
        a.exec('CREATE TABLE t (x)');
        a.exec('BEGIN IMMEDIATE');
        a.prepare('INSERT INTO t (x) VALUES (?)').run(1);
        return {
          path,
          release: () => {
            a.exec('COMMIT');
            a.close();
          },
        };
      },
    },
    {
      name: 'an in-memory store no journal mode applies to',
      onDisk: false,
      walReachable: false,
      arrange: () => ({ path: ':memory:', release: () => {} }),
    },
  ];

  for (const c of OPENS) {
    it(`${c.name}: never leaves the sync level below FULL outside WAL`, () => {
      const { path, release } = c.arrange();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let d: ReturnType<typeof openDriver> | undefined;
      let threw: Error | undefined;
      try {
        d = openDriver(path, { busyTimeoutMs: BUSY_TIMEOUT_MS });
      } catch (e) {
        threw = e as Error;
      } finally {
        spy.mockRestore();
      }

      try {
        const mode = d === undefined ? undefined : String(read(d, 'journal_mode')).toLowerCase();
        const sync = d === undefined ? undefined : Number(read(d, 'synchronous'));

        expect(
          d !== undefined && mode === 'wal',
          `${c.name}: the fixture no longer decides whether WAL is reached — the row grades nothing`,
        ).toBe(c.walReachable);

        if (sync !== undefined && sync < FULL) {
          expect(
            mode,
            `synchronous=${sync} outside WAL risks the store itself, not just its last transactions`,
          ).toBe('wal');
        }

        if (c.onDisk) {
          expect(
            mode === 'wal' || threw !== undefined,
            'a connection that never reached WAL was handed out anyway: peers lose the concurrent ' +
              'read/write property for this process’s whole lifetime, on one line of stderr',
          ).toBe(true);
          if (threw !== undefined) expect(threw.message).toMatch(/WAL/);
        } else {
          expect(
            threw,
            'a store with no journal to keep has no WAL to reach: refusing one is not the fix',
          ).toBeUndefined();
        }

        if (d !== undefined) expect(Number(read(d, 'busy_timeout'))).toBe(BUSY_TIMEOUT_MS);
      } finally {
        d?.close();
        release();
      }
    });
  }
});

/**
 * The WAL conversion is the one pragma that is retried, and it is retried because SQLite refuses a
 * journal-mode change under a peer's write lock without consulting the busy handler. Contention is
 * therefore the ONLY class worth waiting out: every other failure of that pragma — a file that is
 * not a database, a read-only mount, a full volume — is permanent, so spinning on it costs ~300 ms
 * of blocking Atomics.wait per open and then reports lock contention as the cause of something
 * else. This table grades the decision per class, not per symptom somebody happened to hit.
 */
describe('the WAL conversion retries contention and nothing else', () => {
  const walSql = /journal_mode/;
  const stub = {
    fail: undefined as Error | undefined,
    /** What a `PRAGMA journal_mode` read-back reports, whatever the conversion claimed. */
    mode: 'delete',
    walAttempts: 0,
    closes: 0,
    sql: [] as string[],
  };

  class StubDb {
    exec(sql: string): void {
      stub.sql.push(sql);
      if (!walSql.test(sql)) return;
      stub.walAttempts++;
      if (stub.fail !== undefined) throw stub.fail;
    }
    prepare(sql: string): { run: () => unknown; get: () => unknown; all: () => unknown[] } {
      return {
        run: () => ({ lastInsertRowid: 0, changes: 0 }),
        get: () => (walSql.test(sql) ? { journal_mode: stub.mode } : undefined),
        all: () => [],
      };
    }
    close(): void {
      stub.closes++;
    }
  }

  const reset = (fail: Error | undefined, mode: string): void => {
    stub.fail = fail;
    stub.mode = mode;
    stub.walAttempts = 0;
    stub.closes = 0;
    stub.sql = [];
  };

  /** Load driver.ts against a stub native module, so the pragma can fail with any class on demand. */
  async function loadWithStub(): Promise<typeof import('./driver.js')> {
    vi.resetModules();
    vi.doMock('node:module', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:module')>();
      return {
        ...real,
        default: real,
        createRequire: (from: string | URL) => {
          const inner = real.createRequire(from);
          const patched = ((id: string) =>
            id === 'better-sqlite3' ? StubDb : (inner(id) as unknown)) as unknown as NodeJS.Require;
          return Object.assign(patched, inner);
        },
      };
    });
    return import('./driver.js');
  }

  afterEach(() => {
    vi.doUnmock('node:module');
    vi.resetModules();
  });

  const err = (message: string, code: string): Error => Object.assign(new Error(message), { code });

  // Keep this pinned by value, so that raising the budget cannot silently multiply the synchronous
  // sleep every open that meets a locked conversion pays for.
  it('bounds the retry budget by value', () => {
    expect(WAL_RETRIES).toBe(20);
  });

  const CLASSES: Array<{ name: string; make: () => Error; waitsItOut: boolean }> = [
    { name: 'SQLITE_BUSY', make: () => err('database is locked', 'SQLITE_BUSY'), waitsItOut: true },
    {
      name: 'SQLITE_LOCKED',
      make: () => err('database table is locked', 'SQLITE_LOCKED'),
      waitsItOut: true,
    },
    {
      name: 'SQLITE_NOTADB',
      make: () => err('file is not a database', 'SQLITE_NOTADB'),
      waitsItOut: false,
    },
    {
      name: 'SQLITE_READONLY',
      make: () => err('attempt to write a readonly database', 'SQLITE_READONLY'),
      waitsItOut: false,
    },
    {
      name: 'SQLITE_CORRUPT',
      make: () => err('database disk image is malformed', 'SQLITE_CORRUPT'),
      waitsItOut: false,
    },
    { name: 'SQLITE_FULL', make: () => err('database or disk is full', 'SQLITE_FULL'), waitsItOut: false },
    { name: 'unclassified', make: () => new Error('something nobody anticipated'), waitsItOut: false },
  ];

  for (const c of CLASSES) {
    it(`${c.name} ${c.waitsItOut ? 'is retried, then fails naming contention' : 'propagates on the first attempt'}`, async () => {
      const { openDriver: open, WAL_RETRIES: retries } = await loadWithStub();
      reset(c.make(), 'delete');
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let threw: string | undefined;
      let lines: string[] = [];
      let elapsed = 0;
      try {
        const started = Date.now();
        try {
          open(join(mkdtempSync(join(tmpdir(), 'parley-wal-')), 'p.db')).close();
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        elapsed = Date.now() - started;
        lines = spy.mock.calls.map(([l]) => String(l));
      } finally {
        spy.mockRestore();
      }
      // The outcome is the raised error, not a line: a degrade announced on stderr and then served
      // anyway is what an MCP stdio host discards.
      expect(lines).toEqual([]);

      if (c.waitsItOut) {
        expect(threw).toMatch(new RegExp(`WAL conversion still busy after ${retries} retries`));
        expect(threw).toContain(c.make().message);
        expect(stub.walAttempts).toBe(retries + 1);
        expect(elapsed).toBeLessThan(2000);
        expect(stub.closes).toBe(1);
        return;
      }
      expect(threw).toBe(c.make().message);
      expect(stub.walAttempts).toBe(1);
      expect(threw).not.toMatch(/WAL conversion still busy/);
      expect(elapsed).toBeLessThan(150);
      expect(stub.closes).toBe(1);
    });
  }

  /**
   * The other half of the same class, and the half no exception announces: SQLite answers a
   * journal-mode change it cannot honour — the documented case is a filesystem with no shared
   * memory — with the mode it kept rather than with an error. So "the pragma did not throw" is not
   * evidence the precondition holds, and the sync level must be decided on the mode read back.
   */
  const READBACKS: Array<{ name: string; mode: string; converted: boolean }> = [
    { name: 'a conversion the read-back confirms', mode: 'wal', converted: true },
    { name: 'a conversion the store quietly refused, raising nothing', mode: 'delete', converted: false },
  ];

  for (const r of READBACKS) {
    it(`${r.name}: the sync level follows the mode read back`, async () => {
      const { openDriver: open } = await loadWithStub();
      reset(undefined, r.mode);
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let threw: string | undefined;
      try {
        open(join(mkdtempSync(join(tmpdir(), 'parley-wal-')), 'p.db')).close();
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      } finally {
        spy.mockRestore();
      }

      expect(stub.walAttempts).toBe(1);
      expect(
        stub.sql.some((s) => /synchronous\s*=\s*NORMAL/i.test(s)),
        `journal_mode read back as "${r.mode}": lowering the sync level here trades the store, not its last transactions`,
      ).toBe(r.converted);
      if (r.converted) {
        expect(threw).toBeUndefined();
        return;
      }
      expect(threw).toMatch(/reported no error but left journal_mode=delete/);
      expect(stub.closes).toBe(1);
    });
  }
});

// An *open* failure (bad path/permissions/corrupt file) must surface better-sqlite3's own precise
// message, not be swallowed and replaced by the node:sqlite fallback. The fallback fires only on
// a module-*load* failure.
describe.skipIf(BetterCtor === null)('openDriver surfaces the real open error', () => {
  it("propagates better-sqlite3's own message, not node:sqlite's, on an open failure", () => {
    let caught: unknown;
    try {
      openDriver('/no/such/dir/parley.db');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { code?: string };
    // better-sqlite3's actionable "directory does not exist", NOT swallowed and replaced by the
    // node:sqlite fallback's vaguer "unable to open database file" (ERR_SQLITE_ERROR).
    expect(err.message).toMatch(/directory|open database/i);
    expect(err.message).toMatch(/directory/i);
    expect(err.code).not.toBe('ERR_SQLITE_ERROR');
  });

  it('reports a non-database file as one, promptly, rather than as lock contention', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'parley-notadb-')), 'notes.txt');
    writeFileSync(path, 'my notes, not a message store — an operator typo\n');
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let threw: string | undefined;
    let lines: string[] = [];
    let elapsed = 0;
    try {
      const started = Date.now();
      try {
        openDriver(path).close();
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      elapsed = Date.now() - started;
      lines = spy.mock.calls.map(([l]) => String(l));
    } finally {
      spy.mockRestore();
    }
    expect(threw).toMatch(/file is not a database/i);
    expect(lines.filter((l) => /WAL conversion still busy/.test(l))).toEqual([]);
    expect(elapsed).toBeLessThan(150);
  });
});

/**
 * The fallback is only reachable now that better-sqlite3 is an OPTIONAL dependency, so a skipped
 * install silently lands an operator on the slower experimental driver. Grade the announcement,
 * not just the substitution: without a line on stderr the only symptom is the performance.
 *
 * Graded from BOTH sides of the code allowlist, because a code table exercised only on the codes it
 * admits is vacuous — deleting the check keeps every positive row green. An installed-but-broken
 * better-sqlite3 (a SyntaxError in its JS wrapper, EACCES on the `.node`, ERR_REQUIRE_ESM after a
 * packaging change) is not an absent one: swallowed, it is memoized as absent for the whole process
 * lifetime and the deployment runs on the experimental builtin with one generic line to say so.
 */
describe('a better-sqlite3 load failure falls back only for the codes that mean absent', () => {
  const LOAD_FAILURES: Array<{
    name: string;
    code?: string;
    message: string;
    outcome: 'fallback' | 'propagate';
  }> = [
    { name: 'MODULE_NOT_FOUND', code: 'MODULE_NOT_FOUND', message: 'Cannot find module', outcome: 'fallback' },
    { name: 'ERR_DLOPEN_FAILED', code: 'ERR_DLOPEN_FAILED', message: 'wrong ELF class', outcome: 'fallback' },
    { name: 'ERR_REQUIRE_ESM', code: 'ERR_REQUIRE_ESM', message: 'require() of an ES Module', outcome: 'propagate' },
    { name: 'EACCES', code: 'EACCES', message: 'permission denied, open better_sqlite3.node', outcome: 'propagate' },
    { name: 'a code-less SyntaxError', message: 'Unexpected token in better-sqlite3 wrapper', outcome: 'propagate' },
  ];

  for (const f of LOAD_FAILURES) {
    it(`${f.name} ${f.outcome === 'fallback' ? 'falls back, saying so on stderr' : 'propagates untouched'}`, async () => {
      const mod = await import('node:module');
      const loader = mod.default as unknown as { _load(req: string, ...rest: unknown[]): unknown };
      const original = loader._load;
      loader._load = function (req: string, ...rest: unknown[]): unknown {
        if (req === 'better-sqlite3') {
          const e = new Error(f.message) as NodeJS.ErrnoException;
          if (f.code !== undefined) e.code = f.code;
          throw e;
        }
        return original.call(this, req, ...rest);
      };
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.resetModules();
      try {
        const { openDriver: fresh } = await import('./driver.js');
        let driver: ReturnType<typeof openDriver> | undefined;
        let threw: unknown;
        try {
          driver = fresh(':memory:');
        } catch (e) {
          threw = e;
        }
        const said = spy.mock.calls.map((c) => String(c[0])).join('');

        if (f.outcome === 'fallback') {
          expect(threw).toBeUndefined();
          expect(driver?.kind).toBe('node:sqlite');
          expect(said).toMatch(/better-sqlite3 unavailable/);
          expect(said).toMatch(/node:sqlite/);
          driver?.close();
          return;
        }
        expect(driver).toBeUndefined();
        expect((threw as Error | undefined)?.message).toBe(f.message);
        expect(said).not.toMatch(/better-sqlite3 unavailable/);
      } finally {
        loader._load = original;
        spy.mockRestore();
        vi.resetModules();
      }
    });
  }
});
