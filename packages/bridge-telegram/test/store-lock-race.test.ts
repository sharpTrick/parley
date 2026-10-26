import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreLock } from '../src/store-file.js';

/**
 * Where a competing claimant is let in, counted in SYSCALLS the claim under test has made rather
 * than in named steps of it. Hoisted, because `vi.mock`'s factory is evaluated before the module
 * body. Naming the boundaries after today's phases would freeze today's implementation: a counter
 * grades the same invariant against any sequence of calls, including one with none of them left.
 */
const interleave = vi.hoisted(() => ({
  /** Let the competitor in BEFORE this many traced calls have been made. 0 = never. */
  before: 0,
  made: 0,
  armed: false,
  fired: false,
  run: undefined as (() => void) | undefined,
}));

/** Called before each traced syscall; runs the competitor once, at the armed boundary. */
const reached = (): void => {
  if (!interleave.armed) return;
  interleave.made++;
  if (interleave.made !== interleave.before) return;
  // Disarmed FIRST, so that the competitor's own claim cannot recurse into this hook.
  interleave.armed = false;
  interleave.fired = true;
  interleave.run?.();
};

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const traced = ['writeFileSync', 'readFileSync', 'renameSync', 'unlinkSync'] as const;
  const wrapped: Record<string, unknown> = {};
  for (const name of traced) {
    wrapped[name] = (...args: unknown[]): unknown => {
      reached();
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ...real, default: real, ...wrapped };
});

/**
 * Two bridges starting at once on a store file whose claim names a process that has since died.
 * Both read the SAME dead pid, so both are entitled to replace the claim — and whatever the
 * replacement is made of has to be an operation that can only succeed for the claim the claimant
 * actually observed. Clearing it with a bare unlink is not: each starter deletes the other's fresh
 * claim and both end up holding the file. That is the two-writers-on-one-store state the class doc
 * calls structurally unsupported — the same cursor handed to two different messages, and each
 * compaction renaming its own view of history over the other's, with no Bot API history endpoint
 * to rebuild from.
 *
 * The row is the BOUNDARY the second claimant is let in at, swept over every syscall the first one
 * makes. A table anchored on named phases would let a later change move the defect into a gap
 * nobody had a row for, which is how the unlink survived a table that only ever ran one claimant.
 */
describe('telegram store claim under contention', () => {
  const BOUNDARIES = Array.from({ length: 12 }, (_, i) => i + 1);
  /** Boundaries at which the sweep actually let the competitor in — the table's own control. */
  const fired: number[] = [];

  let dir = '';
  afterEach(() => {
    interleave.armed = false;
    interleave.before = 0;
    interleave.run = undefined;
    vi.restoreAllMocks();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it.each(BOUNDARIES)(
    'leaves exactly one holder when a second claimant runs at syscall %i',
    (boundary) => {
      dir = mkdtempSync(join(tmpdir(), 'parley-tg-race-'));
      const path = join(dir, 'store.jsonl');
      mkdirSync(dir, { recursive: true });
      const deadPid = spawnSync('true').pid ?? 0;
      expect(deadPid).toBeGreaterThan(0);
      writeFileSync(`${path}.lock`, `${deadPid}\n`);
      const realKill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        reached();
        return realKill(pid, signal as never);
      }) as typeof process.kill);

      const first = new StoreLock(path);
      const second = new StoreLock(path);
      const claim = (lock: StoreLock): boolean => {
        try {
          lock.claim();
          return true;
        } catch {
          return false;
        }
      };

      let secondHeld = false;
      interleave.made = 0;
      interleave.fired = false;
      interleave.before = boundary;
      interleave.run = () => {
        secondHeld = claim(second);
      };
      interleave.armed = true;
      const firstHeld = claim(first);
      interleave.armed = false;
      if (interleave.fired) fired.push(boundary);

      // Never two, and never none: a crashed bridge's claim must still be recoverable, or the store
      // file can never be opened again.
      expect([firstHeld, secondHeld].filter(Boolean)).toHaveLength(1);
      expect(existsSync(`${path}.lock`)).toBe(true);

      // And the one that lost must not be able to unlink the winner's claim on its way out, or a
      // third bridge joins the file next.
      const [winner, loser] = firstHeld ? [first, second] : [second, first];
      loser.release();
      expect(existsSync(`${path}.lock`)).toBe(true);
      winner.release();
      expect(existsSync(`${path}.lock`)).toBe(false);
    },
  );

  it('let the competitor in at several distinct boundaries', () => {
    // A sweep whose hook never fires grades nothing, and every row above would still pass.
    expect(fired.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...fired)).toBeGreaterThanOrEqual(4);
  });
});
