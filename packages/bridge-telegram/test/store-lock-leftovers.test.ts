import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { siblingPaths, StoreFile, StoreLock } from '../src/store-file.js';

/**
 * Lets one case run a competing starter INSIDE a claim, at a boundary counted in reads of the
 * claim protocol's own files rather than in named steps of it. Hoisted, because `vi.mock`'s factory
 * is evaluated before the module body; disarmed for every other case here, which runs against the
 * real filesystem.
 */
const competitor = vi.hoisted(() => ({
  after: 0,
  reads: 0,
  armed: false,
  fired: false,
  run: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    readFileSync: (...args: unknown[]): unknown => {
      const out = (real.readFileSync as (...a: unknown[]) => unknown)(...args);
      if (!competitor.armed) return out;
      competitor.reads++;
      if (competitor.reads !== competitor.after) return out;
      // Disarmed FIRST, so that the competitor's own reads cannot recurse into this hook.
      competitor.armed = false;
      competitor.fired = true;
      competitor.run?.();
      return out;
    },
  };
});

/** A pid that has certainly exited — a child reaped before anything can reuse the number. */
const deadPid = (): number => {
  const pid = spawnSync('true').pid ?? 0;
  expect(pid).toBeGreaterThan(0);
  return pid;
};

/** Set `path`'s mtime `ms` into the past — a claim its holder stopped refreshing that long ago. */
const backdate = (path: string, ms: number): void => {
  const then = (Date.now() - ms) / 1000;
  utimesSync(path, then, then);
};

/** Older than the lease a claim naming this pid is held by: what a crashed run leaves after it. */
const PAST_THE_LEASE_MS = 31_000;

let dir = '';
const freshStore = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'parley-tg-leftover-'));
  return join(dir, 'store.jsonl');
};

/** Run `run` once, after the claim under test has read `after` of the protocol's files. */
const interleave = (after: number, run: () => void): void => {
  competitor.after = after;
  competitor.reads = 0;
  competitor.fired = false;
  competitor.run = run;
  competitor.armed = true;
};

afterEach(() => {
  competitor.armed = false;
  competitor.after = 0;
  competitor.reads = 0;
  competitor.run = undefined;
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/**
 * A bridge SIGKILLed anywhere inside a stale-claim take-over leaves one of the claim protocol's own
 * siblings behind, naming a process that no longer exists. Nothing else ever removes one, so a
 * sibling that a later claim reads as a reason to refuse turns the very crash the take-over exists
 * to recover from into a store that can never be opened again — and an operator who clears the one
 * path the refusal names gets exactly one more start before the next crash re-arms it.
 *
 * The path axis is read out of `siblingPaths`, so a sibling a later change adds is graded here
 * without anyone remembering to, and the default a new one inherits is the safe one: a leftover
 * that names nothing alive must never stop a claim. Both legs are asserted — the claim itself and a
 * SECOND claim after it is released — because a fix that lets one start through while leaving the
 * residue in place shows up only on the start after that.
 */
describe('telegram store claim over a crashed take-over', () => {
  const SIBLINGS = Object.keys(siblingPaths(''));
  const pathOf = (store: string, which: string): string =>
    (siblingPaths(store) as Record<string, string>)[which] as string;

  const CORPSES = [
    { name: 'a pid that has exited', bytes: (): string => `${deadPid()}\n` },
    { name: 'nothing at all', bytes: (): string => '' },
    { name: 'bytes that are no pid', bytes: (): string => 'not-a-pid\n' },
    // A bridge restarted under its crashed run's pid — PID 1 in a container on a persistent volume.
    {
      name: 'this pid, its lease run out',
      bytes: (): string => `${process.pid}\n`,
      age: PAST_THE_LEASE_MS,
    },
  ];

  const GRID = SIBLINGS.flatMap((which) => CORPSES.map((corpse) => ({ which, ...corpse })));

  it.each(GRID)('starts over a leftover $which carrying $name', ({ which, bytes, age }) => {
    const path = freshStore();
    // Every row but the claim path itself needs a claim to take over from, or the take-over the
    // leftover would block is never reached.
    if (which !== 'lock') writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);
    writeFileSync(pathOf(path, which), bytes());
    if (age !== undefined) backdate(pathOf(path, which), age);

    const first = new StoreLock(path);
    expect(() => first.claim()).not.toThrow();
    expect(readFileSync(first.path, 'utf8').trim()).toBe(String(process.pid));
    first.release();

    const second = new StoreLock(path);
    expect(() => second.claim()).not.toThrow();
    second.release();
    expect(existsSync(pathOf(path, 'lock'))).toBe(false);
  });

  /**
   * The other half of the same property: clearing a leftover must not clear a claim. A leftover
   * naming a LIVE process is the one case the protocol is entitled to refuse on, and only for the
   * paths it reads a holder out of — every other one carries no pid at all, and a claim that
   * started refusing on one would be this same defect wearing a different file.
   */
  const HOLDER_PATHS = new Set(['lock', 'break']);
  const LIVE = [
    { name: 'a live foreign process', pid: (): number => process.ppid },
    { name: 'this pid inside its lease', pid: (): number => process.pid },
  ];
  const LIVE_GRID = SIBLINGS.flatMap((which) =>
    LIVE.map((live) => ({ which, holder: live.name, pid: live.pid })),
  );
  it.each(LIVE_GRID)(
    'refuses over $which naming $holder only where the protocol reads a holder',
    ({ which, pid }) => {
      const path = freshStore();
      if (which !== 'lock') writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);
      writeFileSync(pathOf(path, which), `${pid()}\n`);

      const lock = new StoreLock(path);
      let refused = false;
      try {
        lock.claim();
      } catch {
        refused = true;
      }
      lock.release();
      expect(refused).toBe(HOLDER_PATHS.has(which));
    },
  );

  /** The refusal names every path an operator must clear, or one start heals and the next does not. */
  it('names both claim-protocol paths an operator has to clear', () => {
    const path = freshStore();
    writeFileSync(pathOf(path, 'lock'), `${process.ppid}\n`);
    let message = '';
    try {
      new StoreLock(path).claim();
    } catch (err) {
      message = (err as Error).message;
    }
    for (const which of HOLDER_PATHS) expect(message).toContain(pathOf(path, which));
  });
});

/**
 * A claim naming THIS pid is the one holder the kernel cannot adjudicate — it is always alive — and
 * the same pid can be a live holder this module has never seen: a second PID-1 container on a shared
 * volume, another module instance, a worker thread. So it is graded by its lease, which its holder
 * keeps refreshing. A held claim refuses a second claimant however it arrives, for as long as its
 * holder runs; a crashed run's leftover is taken over once the lease runs out (the rows above); and
 * a holder that lets go stops refreshing.
 */
describe('telegram store claim naming this process', () => {
  const lockOf = (store: string): string => siblingPaths(store).lock;
  /** Spellings of one store path a second claimant in this process might arrive by. */
  const SPELLINGS = [
    { name: 'the same path', spell: (store: string): string => store },
    {
      name: 'a symlinked directory',
      spell: (): string => {
        const link = join(dir, 'via-link');
        symlinkSync(dir, link);
        return join(link, 'store.jsonl');
      },
    },
    { name: 'a relative path', spell: (store: string): string => relative(process.cwd(), store) },
  ];

  const HOLDERS = [
    {
      name: 'a claim taken fresh',
      hold: (store: string): StoreLock => {
        const lock = new StoreLock(store);
        lock.claim();
        return lock;
      },
    },
    {
      name: 'a take-over of a crashed claim',
      hold: (store: string): StoreLock => {
        writeFileSync(lockOf(store), 'not-a-pid\n');
        const lock = new StoreLock(store);
        lock.claim();
        return lock;
      },
    },
  ];

  const HELD_GRID = HOLDERS.flatMap((h) =>
    SPELLINGS.map((s) => ({ hold: h.hold, spell: s.spell, holder: h.name, by: s.name })),
  );

  it.each(HELD_GRID)('refuses a second claimant by $by while $holder holds it', ({ hold, spell }) => {
    const store = freshStore();
    const first = hold(store);
    // The precondition: the claim on disk names this process, or the row grades a foreign pid.
    expect(readFileSync(lockOf(store), 'utf8').trim()).toBe(String(process.pid));

    const second = new StoreLock(spell(store));
    expect(() => second.claim()).toThrow(/already claimed/);
    expect(readFileSync(lockOf(store), 'utf8').trim()).toBe(String(process.pid));
    first.release();
  });

  it('refuses a second claimant from another module instance while this one holds it', async () => {
    const store = freshStore();
    const first = new StoreLock(store);
    first.claim();
    vi.resetModules();
    const other = await import('../src/store-file.js');
    // The precondition: nothing this module instance remembers is reachable from the other.
    expect(other.StoreLock).not.toBe(StoreLock);

    expect(() => new other.StoreLock(store).claim()).toThrow(/already claimed/);
    expect(readFileSync(lockOf(store), 'utf8').trim()).toBe(String(process.pid));
    first.release();
  });

  it.each(HOLDERS)('keeps refusing while $name runs on for many leases', ({ hold }) => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const born = Date.now();
      const first = hold(store);
      // Asked at every half lease, so that a refresh slower than the lease cannot slip between.
      for (let step = 0; step < 40; step++) {
        vi.advanceTimersByTime(PAST_THE_LEASE_MS / 2);
        expect(() => new StoreLock(store).claim()).toThrow(/already claimed/);
      }
      // The precondition: the clock the lease is read against has moved past many leases.
      expect(Date.now() - born).toBeGreaterThanOrEqual(10 * PAST_THE_LEASE_MS);
      first.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the claim of a holder that took it over when the stale one releases', () => {
    const store = freshStore();
    const stale = new StoreLock(store);
    stale.claim();
    // The stale holder stopped refreshing past its lease — a stalled event loop — and was replaced.
    backdate(lockOf(store), PAST_THE_LEASE_MS);
    const successor = new StoreLock(store);
    expect(() => successor.claim()).not.toThrow();

    stale.release();
    expect(readFileSync(lockOf(store), 'utf8').trim()).toBe(String(process.pid));
    expect(() => new StoreLock(store).claim()).toThrow(/already claimed/);

    successor.release();
    expect(existsSync(lockOf(store))).toBe(false);
  });

  const OWNERS = [
    {
      name: 'a released claim',
      open: (store: string): (() => void) => {
        const lock = new StoreLock(store);
        lock.claim();
        return () => lock.release();
      },
    },
    {
      name: 'a closed store file',
      open: (store: string): (() => void) => {
        const file = new StoreFile(store);
        return () => file.close();
      },
    },
  ];

  /** Descriptors this process holds on `path`. */
  const openFdsOn = (path: string): number =>
    readdirSync('/proc/self/fd').filter((fd) => {
      try {
        const link = readlinkSync(join('/proc/self/fd', fd));
        return link === path || link === `${path} (deleted)`;
      } catch {
        return false;
      }
    }).length;

  it.each(OWNERS)('leaves no lease refresh running after $name', ({ open }) => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const before = vi.getTimerCount();
      const stop = open(store);
      // The precondition: holding the claim runs the refresh, on the descriptor, this case expects
      // to stop.
      expect(vi.getTimerCount()).toBe(before + 1);
      expect(openFdsOn(lockOf(store))).toBe(1);

      stop();
      expect(vi.getTimerCount()).toBe(before);
      expect(openFdsOn(lockOf(store))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Clearing a corpse is only safe if it can never clear a live starter, and the filesystem offers no
 * remove-if-this-content: a read followed by an unlink is a window in which a competitor's fresh
 * take-over token takes the place of the corpse that was read. So each case below runs a competitor
 * INSIDE that window and asserts the invariant that makes the leftover fix survivable — a claim
 * removes and publishes only state it wrote itself. Losing it does not merely deny one start: it
 * leaves a claim naming a process that holds nothing, which is the permanent refusal above, minted
 * fresh by the code that was supposed to end it.
 */
describe('telegram store claim touches only the state it wrote', () => {
  const pathOf = (store: string, which: string): string =>
    (siblingPaths(store) as Record<string, string>)[which] as string;
  /** Stands in for a competing starter: alive, and certainly not us. */
  const foreignPid = (): number => process.ppid;

  /** Competing starters a take-over token can come from: another process, or this pid elsewhere. */
  const COMPETITORS = [
    { name: 'another process', pid: foreignPid },
    { name: 'this pid in another module instance', pid: (): number => process.pid },
  ];

  it.each(COMPETITORS)(
    'leaves a take-over token from $name that replaced the corpse it read',
    ({ pid }) => {
      const path = freshStore();
      const rival = pid();
      writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);
      writeFileSync(pathOf(path, 'break'), `${deadPid()}\n`);

      interleave(2, () => writeFileSync(pathOf(path, 'break'), `${rival}\n`));
      const lock = new StoreLock(path);
      expect(() => lock.claim()).toThrow(/already claimed/);
      competitor.armed = false;

      // The hook has to have run, or the case grades nothing.
      expect(competitor.fired).toBe(true);
      expect(readFileSync(pathOf(path, 'break'), 'utf8').trim()).toBe(String(rival));
    },
  );

  it('never publishes a take-over token another process wrote', () => {
    const path = freshStore();
    const stale = deadPid();
    const foreign = foreignPid();
    writeFileSync(pathOf(path, 'lock'), `${stale}\n`);

    interleave(2, () => writeFileSync(pathOf(path, 'break'), `${foreign}\n`));
    const lock = new StoreLock(path);
    expect(() => lock.claim()).toThrow(/already claimed/);
    competitor.armed = false;

    expect(competitor.fired).toBe(true);
    expect(readFileSync(pathOf(path, 'lock'), 'utf8').trim()).toBe(String(stale));
  });

  it('leaves a take-over token another process wrote where it found it', () => {
    const path = freshStore();
    const foreign = foreignPid();
    writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);

    interleave(2, () => writeFileSync(pathOf(path, 'break'), `${foreign}\n`));
    const lock = new StoreLock(path);
    expect(() => lock.claim()).toThrow(/already claimed/);
    competitor.armed = false;

    expect(competitor.fired).toBe(true);
    expect(existsSync(pathOf(path, 'break'))).toBe(true);
    expect(readFileSync(pathOf(path, 'break'), 'utf8').trim()).toBe(String(foreign));
  });
});
