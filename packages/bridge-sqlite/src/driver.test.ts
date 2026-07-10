import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDriver } from './driver.js';

const mode = (f: string): number => statSync(f).mode & 0o777;

// BUG-35/36 assertions exercise the native better-sqlite3 open/lock semantics specifically (the
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

// SEC-16 — the SQLite DB (all message content, hand-offs, presence) plus its WAL sidecars must be
// created 0600 so another local account on a shared host cannot read the conversation store.
// Neither driver exposes a mode option, so openDriver chmods the DB after open; the -wal/-shm
// sidecars, created lazily on first write, inherit the main DB's mode.
describe('openDriver file permissions (SEC-16)', () => {
  it('creates the DB and its -wal/-shm sidecars 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-sqlite-mode-'));

    // Control: a plain file under this env's umask reproduces the pre-fix (world-readable) mode.
    // If umask already strips group/other, the 0600 assertions below would be trivially met, so
    // don't claim a false proof — just note it.
    const control = join(dir, 'control');
    writeFileSync(control, '');
    const umaskExposes = (statSync(control).mode & 0o077) !== 0;

    const dbPath = join(dir, 'p.db');
    const d = openDriver(dbPath);
    // First write materializes the -wal/-shm sidecars; SQLite creates them inheriting the main
    // DB's (now 0600) mode, so the earlier chmod on the DB is what protects them.
    d.exec('CREATE TABLE t (x)');
    d.prepare('INSERT INTO t (x) VALUES (?)').run(1);

    expect(mode(dbPath)).toBe(0o600);
    // Sidecars must exist after a write and must be locked down too (SEC-16 explicitly).
    expect(mode(`${dbPath}-wal`)).toBe(0o600);
    expect(mode(`${dbPath}-shm`)).toBe(0o600);
    d.close();

    if (umaskExposes) {
      // Sanity: the fix meaningfully narrowed the mode a bare open would have produced (0644).
      expect(mode(control) & 0o077).not.toBe(0);
    }
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

// BUG-35 — a fresh-file delete→WAL conversion racing another opener must NOT crash connect().
// SQLite does not consult the busy handler for a journal-mode change, so openDriver sets
// busy_timeout first, bounded-retries the WAL pragma, and degrades to the default journal mode
// rather than throwing "database is locked".
describe.skipIf(BetterCtor === null)('openDriver concurrent first-boot WAL race (BUG-35)', () => {
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

// BUG-36 — an *open* failure (bad path/permissions/corrupt file) must surface better-sqlite3's own
// precise message, not be swallowed and replaced by the node:sqlite fallback. The fallback fires
// only on a module-*load* failure.
describe.skipIf(BetterCtor === null)('openDriver surfaces the real open error (BUG-36)', () => {
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
});
