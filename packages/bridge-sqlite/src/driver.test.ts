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

// A fresh-file delete→WAL conversion racing another opener must NOT crash connect(). SQLite does
// not consult the busy handler for a journal-mode change, so openDriver sets busy_timeout first,
// bounded-retries the WAL pragma, and degrades to the default journal mode rather than throwing
// "database is locked".
describe.skipIf(BetterCtor === null)('openDriver concurrent first-boot WAL race', () => {
  it('retries then degrades to a usable driver instead of throwing when WAL conversion is blocked', () => {
    const Ctor = BetterCtor as new (p: string) => RawConn;
    const dir = mkdtempSync(join(tmpdir(), 'parley-sqlite-wal-'));
    const dbPath = join(dir, 'p.db');

    // Connection A: a fresh delete-mode file holding an IMMEDIATE write lock, so the delete→WAL
    // conversion openDriver runs cannot acquire its exclusive lock — the exact first-boot race.
    const a = new Ctor(dbPath);
    a.exec('PRAGMA busy_timeout = 0');
    a.exec('CREATE TABLE t (x)');
    a.exec('BEGIN IMMEDIATE');
    a.prepare('INSERT INTO t (x) VALUES (?)').run(1);

    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let d: ReturnType<typeof openDriver> | undefined;
    try {
      // Pre-fix openDriver ran `PRAGMA journal_mode = WAL` FIRST (0 ms window) and threw
      // "database is locked". Post-fix: busy_timeout first, bounded WAL retry, then degrade →
      // a usable driver with no throw out of connect().
      expect(() => {
        d = openDriver(dbPath, { busyTimeoutMs: 200 });
      }).not.toThrow();
      expect(d).toBeDefined();
      // It degraded loudly (WAL never converted while A held the lock the whole time).
      const warned = spy.mock.calls.some(([c]) => /WAL conversion still busy/.test(String(c)));
      expect(warned).toBe(true);
    } finally {
      spy.mockRestore();
    }

    a.exec('COMMIT');
    expect(() => (d as ReturnType<typeof openDriver>).exec('SELECT 1')).not.toThrow();
    (d as ReturnType<typeof openDriver>).close();
    a.close();
  });
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
  const stub = { fail: undefined as Error | undefined, walAttempts: 0, closes: 0 };

  class StubDb {
    exec(sql: string): void {
      if (!walSql.test(sql)) return;
      stub.walAttempts++;
      if (stub.fail !== undefined) throw stub.fail;
    }
    prepare(): { run: () => unknown; get: () => unknown; all: () => unknown[] } {
      return { run: () => ({ lastInsertRowid: 0, changes: 0 }), get: () => undefined, all: () => [] };
    }
    close(): void {
      stub.closes++;
    }
  }

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
    it(`${c.name} ${c.waitsItOut ? 'is retried then degraded' : 'propagates on the first attempt'}`, async () => {
      const { openDriver: open, WAL_RETRIES: retries } = await loadWithStub();
      stub.fail = c.make();
      stub.walAttempts = 0;
      stub.closes = 0;
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
      const stillBusy = lines.filter((l) => /WAL conversion still busy/.test(l));

      if (c.waitsItOut) {
        expect(threw).toBeUndefined();
        expect(stub.walAttempts).toBe(retries + 1);
        expect(stillBusy).toHaveLength(1);
        expect(stillBusy[0]).toContain(c.make().message);
        expect(elapsed).toBeLessThan(2000);
        return;
      }
      expect(threw).toBe(c.make().message);
      expect(stub.walAttempts).toBe(1);
      expect(stillBusy).toEqual([]);
      expect(elapsed).toBeLessThan(150);
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
