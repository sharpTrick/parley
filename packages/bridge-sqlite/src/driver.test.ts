import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDriver } from './driver.js';

const mode = (f: string): number => statSync(f).mode & 0o777;

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
