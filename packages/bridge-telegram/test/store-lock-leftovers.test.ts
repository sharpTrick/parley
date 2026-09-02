import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { siblingPaths, StoreLock } from '../src/store-file.js';

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
  ];

  const GRID = SIBLINGS.flatMap((which) => CORPSES.map((corpse) => ({ which, ...corpse })));

  it.each(GRID)('starts over a leftover $which carrying $name', ({ which, bytes }) => {
    const path = freshStore();
    // Every row but the claim path itself needs a claim to take over from, or the take-over the
    // leftover would block is never reached.
    if (which !== 'lock') writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);
    writeFileSync(pathOf(path, which), bytes());

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
  it.each(SIBLINGS)('refuses over a live %s only where the protocol reads a holder', (which) => {
    const path = freshStore();
    if (which !== 'lock') writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);
    writeFileSync(pathOf(path, which), `${process.pid}\n`);

    const lock = new StoreLock(path);
    let refused = false;
    try {
      lock.claim();
    } catch {
      refused = true;
    }
    lock.release();
    expect(refused).toBe(HOLDER_PATHS.has(which));
  });

  /** The refusal names every path an operator must clear, or one start heals and the next does not. */
  it('names both claim-protocol paths an operator has to clear', () => {
    const path = freshStore();
    writeFileSync(pathOf(path, 'lock'), `${process.pid}\n`);
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

  it('leaves a competitor take-over token that replaced the corpse it read', () => {
    const path = freshStore();
    const foreign = foreignPid();
    writeFileSync(pathOf(path, 'lock'), `${deadPid()}\n`);
    writeFileSync(pathOf(path, 'break'), `${deadPid()}\n`);

    interleave(2, () => writeFileSync(pathOf(path, 'break'), `${foreign}\n`));
    const lock = new StoreLock(path);
    expect(() => lock.claim()).toThrow(/already claimed/);
    competitor.armed = false;

    // The hook has to have run, or the case grades nothing.
    expect(competitor.fired).toBe(true);
    expect(readFileSync(pathOf(path, 'break'), 'utf8').trim()).toBe(String(foreign));
  });

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
