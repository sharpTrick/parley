import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDriver } from '../src/driver.js';

const hoisted = vi.hoisted(() => ({ chmodFails: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    chmodSync: (p: string, m: number) => {
      if (hoisted.chmodFails) {
        throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
      }
      real.chmodSync(p, m);
    },
  };
});

/**
 * At-rest permissions across the states a store is actually found in — brand new, already locked
 * down, or left group/world-readable by an older version. The mode must end at 0600 in every case,
 * and any time the store is (or stays) readable by another account the operator must be told,
 * never silently.
 */

const mode = (f: string): number => statSync(f).mode & 0o777;
const dir = () => mkdtempSync(join(tmpdir(), 'parley-mode-'));

const PRE_EXISTING: Array<{ name: string; setup?: number; warns: boolean }> = [
  { name: 'absent', warns: false },
  { name: '0600', setup: 0o600, warns: false },
  { name: '0640', setup: 0o640, warns: true },
  { name: '0644', setup: 0o644, warns: true },
  { name: '0660', setup: 0o660, warns: true },
  { name: '0666', setup: 0o666, warns: true },
];

describe('at-rest mode for every pre-existing store state', () => {
  for (const c of PRE_EXISTING) {
    it(`${c.name}: ends at 0600 and ${c.warns ? 'reports the change' : 'stays quiet'}`, () => {
      const path = join(dir(), 'p.db');
      if (c.setup !== undefined) {
        writeFileSync(path, '');
        chmodSync(path, c.setup);
      }
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let lines: string[] = [];
      let modes: number[] = [];
      try {
        const d = openDriver(path);
        d.exec('CREATE TABLE t (x)');
        d.prepare('INSERT INTO t (x) VALUES (?)').run(1);
        lines = spy.mock.calls.map(([l]) => String(l));
        // Read the sidecars before close(): the checkpoint on close removes them.
        modes = [path, `${path}-wal`, `${path}-shm`].map(mode);
        d.close();
      } finally {
        spy.mockRestore();
      }

      expect(modes).toEqual([0o600, 0o600, 0o600]);

      const notices = lines.filter((l) => /tightened|cannot restrict/.test(l));
      expect(notices.length).toBe(c.warns ? 1 : 0);
      if (c.warns) expect(notices[0]).toContain(path);
    });
  }

  it('a store that cannot be tightened is reported, not silently left open', () => {
    const path = join(dir(), 'p.db');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let lines: string[] = [];
    try {
      // Stands in for the multi-UID deployment: a store owned by another account, where chmod
      // fails with EPERM and the process must not assume the store is protected.
      hoisted.chmodFails = true;
      const d = openDriver(path);
      lines = spy.mock.calls.map(([l]) => String(l));
      d.close();
    } finally {
      hoisted.chmodFails = false;
      spy.mockRestore();
    }
    expect(lines.some((l) => /cannot restrict/.test(l) && l.includes(path))).toBe(true);
  });
});
