import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type openDriver as OpenDriver, openDriver } from '../src/driver.js';

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
 *
 * Every case OWNS its umask rather than inheriting the runner's, because the umask is what decides
 * how much of this is graded: under 0077 the driver's own create is already 0600, so the entire
 * pre-creation window can be deleted with every assertion here still passing. Nothing in
 * `.github/workflows/ci.yml` or `vitest.config.ts` pins one.
 */

const mode = (f: string): number => statSync(f).mode & 0o777;
const dir = () => mkdtempSync(join(tmpdir(), 'parley-mode-'));

const UMASKS = [0o000, 0o022, 0o077];
const oct = (m: number): string => `0${m.toString(8).padStart(3, '0')}`;

let previousUmask: number | undefined;
function withUmask(mask: number): void {
  previousUmask ??= process.umask(mask);
}
afterEach(() => {
  if (previousUmask !== undefined) process.umask(previousUmask);
  previousUmask = undefined;
  vi.doUnmock('node:module');
  vi.resetModules();
});

/**
 * A copy of the driver whose native constructor records what was on disk at the instant it ran.
 * The pre-creation claim is about a WINDOW, and the final mode cannot see one: the only moment the
 * window is observable is the driver's own open.
 */
async function loadRecordingDriver(): Promise<{
  openDriver: typeof OpenDriver;
  atOpen: () => { existed: boolean; mode?: number };
}> {
  const seen: Array<{ existed: boolean; mode?: number }> = [];
  vi.resetModules();
  vi.doMock('node:module', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:module')>();
    return {
      ...real,
      default: real,
      createRequire: (from: string | URL) => {
        const inner = real.createRequire(from);
        const recording = ((id: string) => {
          const mod: unknown = inner(id);
          if (id !== 'better-sqlite3') return mod;
          return new Proxy(mod as new (p: string) => object, {
            construct: (target, args) => {
              const path = String(args[0]);
              seen.push(
                existsSync(path) ? { existed: true, mode: mode(path) } : { existed: false },
              );
              return Reflect.construct(target, args) as object;
            },
          });
        }) as unknown as NodeJS.Require;
        return Object.assign(recording, inner);
      },
    };
  });
  const driver = await import('../src/driver.js');
  return { openDriver: driver.openDriver, atOpen: () => seen[0] ?? { existed: false } };
}

describe('the store is claimed at 0600 before the driver can create it', () => {
  for (const umask of UMASKS) {
    it(`umask ${oct(umask)}: the file the driver opens already exists at 0600`, async () => {
      withUmask(umask);
      const { openDriver: recording, atOpen } = await loadRecordingDriver();
      const d = recording(join(dir(), 'p.db'));
      d.close();
      expect(
        atOpen(),
        'nothing was recorded: the native constructor never ran, so this graded no window at all',
      ).toEqual({ existed: true, mode: 0o600 });
    });
  }
});

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

describe.each(UMASKS.map(oct))('at-rest mode for every pre-existing store state (umask %s)', (label) => {
  const umask = Number.parseInt(label, 8);
  for (const c of PRE_EXISTING) {
    it(`${c.name}: every file ends at 0600, each change reported once`, () => {
      withUmask(umask);
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
    withUmask(umask);
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
