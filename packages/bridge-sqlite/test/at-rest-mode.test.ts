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

/**
 * The store is three files, and the message content lives in the `-wal` as much as in the `.db`.
 * An unclean shutdown of a looser build leaves a sidecar behind at its own mode, so each file has
 * to be inspected on its own — a sidecar SQLite happens to create by inheriting the tightened
 * `.db` mode proves nothing about one already on disk.
 */
const SUFFIX = { db: '', wal: '-wal', shm: '-shm' } as const;
type StoreFile = keyof typeof SUFFIX;
const FILES: StoreFile[] = ['db', 'wal', 'shm'];

const PRE_EXISTING: Array<{
  name: string;
  setup: Partial<Record<StoreFile, number>>;
  narrowed: StoreFile[];
}> = [
  { name: 'absent', setup: {}, narrowed: [] },
  { name: 'db 0600', setup: { db: 0o600 }, narrowed: [] },
  { name: 'db 0640', setup: { db: 0o640 }, narrowed: ['db'] },
  { name: 'db 0644', setup: { db: 0o644 }, narrowed: ['db'] },
  { name: 'db 0660', setup: { db: 0o660 }, narrowed: ['db'] },
  { name: 'db 0666', setup: { db: 0o666 }, narrowed: ['db'] },
  { name: 'db 0600, wal 0644', setup: { db: 0o600, wal: 0o644 }, narrowed: ['wal'] },
  { name: 'db 0644, wal 0600', setup: { db: 0o644, wal: 0o600 }, narrowed: ['db'] },
  { name: 'db 0600, shm 0666', setup: { db: 0o600, shm: 0o666 }, narrowed: ['shm'] },
  {
    name: 'db 0600, wal 0640, shm 0660',
    setup: { db: 0o600, wal: 0o640, shm: 0o660 },
    narrowed: ['wal', 'shm'],
  },
  {
    name: 'all three 0644',
    setup: { db: 0o644, wal: 0o644, shm: 0o644 },
    narrowed: ['db', 'wal', 'shm'],
  },
];

describe('at-rest mode for every pre-existing store state', () => {
  for (const c of PRE_EXISTING) {
    it(`${c.name}: every file ends at 0600, each change reported once`, () => {
      const path = join(dir(), 'p.db');
      for (const f of FILES) {
        const preset = c.setup[f];
        if (preset === undefined) continue;
        writeFileSync(`${path}${SUFFIX[f]}`, '');
        chmodSync(`${path}${SUFFIX[f]}`, preset);
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
        modes = FILES.map((f) => mode(`${path}${SUFFIX[f]}`));
        d.close();
      } finally {
        spy.mockRestore();
      }

      expect(modes).toEqual([0o600, 0o600, 0o600]);

      const tightened = lines
        .map((l) => /tightened (\S+) from/.exec(l)?.[1])
        .filter((f): f is string => f !== undefined);
      expect(tightened).toEqual(c.narrowed.map((f) => `${path}${SUFFIX[f]}`));
      expect(lines.filter((l) => /cannot restrict/.test(l))).toEqual([]);
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
