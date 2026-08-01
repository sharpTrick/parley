import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservedStore } from '../src/store.js';
import { record, storePath } from './rig.js';

let path: string;
beforeEach(() => {
  path = storePath();
});

/**
 * Two writers on ONE store file is the shape the class doc calls structurally unsupported, and it
 * used to be unsupported without being refused: both loaded the same identity and the same
 * sequence, so two different messages carried the identical cursor, and then either one's
 * compaction renamed its own view of history over the other's — silently, with no Bot API endpoint
 * that could ever rebuild what it discarded. The claim has to be on a SIBLING rather than on the
 * store's own descriptor, which is what the compacting phase below grades: a compaction replaces
 * the store file wholesale, so a claim living on it goes with the file it replaced.
 */
describe('telegram ObservedStore single-writer claim', () => {
  /** What the first writer is doing when the second one tries to open the same file. */
  const PHASES = [
    { name: 'idle-open', drive: () => undefined },
    { name: 'appending', drive: (s: ObservedStore) => void s.append(record('-1', 1, 'a')) },
    {
      name: 'compacting',
      drive: (s: ObservedStore) => {
        for (let i = 1; i <= 8; i++) s.append(record('-1', i, `m${i}`));
      },
    },
  ];

  it.each(PHASES)('refuses a second in-process writer while the first is $name', ({ drive }) => {
    const first = new ObservedStore(path, 2, 10);
    drive(first);
    expect(() => new ObservedStore(path, 2, 10)).toThrow(
      new RegExp(`already claimed by process ${process.pid}`),
    );
    expect(() => new ObservedStore(path, 2, 10)).toThrow(path);
    // The refusal is the claim's, not the file's: closing the first hands it over.
    first.close();
    const second = new ObservedStore(path, 2, 10);
    expect(second.append(record('-2', 1, 'after'))).toBeDefined();
    second.close();
  });

  /**
   * The half no second instance in THIS process can reach: a claim left by another process. It is
   * honoured while that process lives and replaced once it is gone — a crashed bridge must not
   * leave a store file that can never be opened again, and a live one must not be joined.
   */
  const FOREIGN_CLAIMS = [
    { name: 'a live process', pid: () => String(spawnedPid), admitted: false },
    { name: 'a process that is gone', pid: () => String(deadPid), admitted: true },
    { name: 'nothing readable', pid: () => 'not-a-pid', admitted: true },
    { name: 'an empty claim', pid: () => '', admitted: true },
  ];

  let spawnedPid = 0;
  let deadPid = 0;
  beforeEach(() => {
    const live = spawn('sleep', ['30'], { stdio: 'ignore' });
    live.unref();
    spawnedPid = live.pid ?? 0;
    const gone = spawnSync('true');
    deadPid = gone.pid ?? 0;
    expect(spawnedPid).toBeGreaterThan(0);
    expect(deadPid).toBeGreaterThan(0);
    return () => {
      live.kill('SIGKILL');
    };
  });

  it.each(FOREIGN_CLAIMS)('a claim naming $name is honoured: $admitted', ({ pid, admitted }) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.lock`, `${pid()}\n`);
    if (!admitted) {
      expect(() => new ObservedStore(path, 2, 10)).toThrow(/already claimed by process/);
      return;
    }
    const store = new ObservedStore(path, 2, 10);
    expect(store.append(record('-1', 1, 'a'))).toBeDefined();
    store.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  /**
   * The negative control: the guard has to be about SHARING a file, not about a second store
   * existing. Two writers on two paths both keep everything they wrote, across a cold reload of
   * each — which is exactly what the shared-path cells above lose.
   */
  it('keeps every record when two writers hold two different store files', () => {
    const other = join(dirname(path), 'other.jsonl');
    const a = new ObservedStore(path, 10, 10);
    const b = new ObservedStore(other, 10, 10);
    for (let i = 1; i <= 4; i++) {
      expect(a.append(record('-1', i, `a${i}`))).toBeDefined();
      expect(b.append(record('-1', i, `b${i}`))).toBeDefined();
    }
    expect(a.epoch()).not.toBe(b.epoch());
    a.close();
    b.close();

    for (const [file, tag] of [[path, 'a'], [other, 'b']] as const) {
      const reloaded = new ObservedStore(file, 10, 10);
      expect(reloaded.entries('-1').map((r) => r.content)).toEqual([1, 2, 3, 4].map((i) => `${tag}${i}`));
      reloaded.close();
    }
  });
});
