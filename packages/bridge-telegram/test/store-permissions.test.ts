import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservedStore } from '../src/store.js';
import { captureStderr, lineCount, record, storePath } from './rig.js';

const modeOf = (target: string): number => statSync(target).mode & 0o777;

let dir: string;
beforeEach(() => {
  dir = dirname(storePath());
});

/**
 * This file is the full plaintext of every message the bridge has observed — sender handles, chat
 * ids and bodies, in every chat the bot is in — living in the same state directory where core keeps
 * mere cursors at 0600 under a 0700 directory. Every path that CREATES or REPLACES it has to hold
 * that, not just the first one: an `openSync` mode applies only to a file it creates, and a
 * `renameSync` installs the temp file's mode over the target, so a store tightened on creation is
 * re-widened by the next compaction unless the temp file is tight too.
 */
describe('telegram ObservedStore file permissions', () => {
  interface Cell {
    name: string;
    /** Runs before the store is opened — an upgrade onto state an earlier version left behind. */
    prepare?: (path: string) => void;
    /** Append enough to force a compaction, so the file under test is a rewrite's output. */
    compact?: boolean;
    /** What must be unreadable by group and other. */
    targets: (path: string) => string[];
    /** The one path the store must NAME on stderr as tightened; nothing else may be reported. */
    tightens?: (path: string) => string;
  }

  const loose = (target: string): void => {
    chmodSync(target, 0o666);
    expect(modeOf(target) & 0o077).not.toBe(0);
  };

  const CELLS: Cell[] = [
    {
      name: 'the store file it creates',
      targets: (p) => [p],
    },
    {
      name: 'every directory it creates on the way',
      targets: (p) => [dirname(p), dirname(dirname(p))],
    },
    {
      name: 'the store file a compaction replaces',
      compact: true,
      targets: (p) => [p],
    },
    {
      // A leftover temp file is REPLACED, never written through: it is unlinked and recreated
      // exclusively, so its mode never reaches the store and there is nothing to tighten.
      name: 'the store file a compaction replaces over a leftover world-readable temp file',
      prepare: (p) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(`${p}.tmp`, 'junk from a crashed compaction\n');
        loose(`${p}.tmp`);
      },
      compact: true,
      targets: (p) => [p],
    },
    {
      name: 'a pre-existing world-readable store file',
      prepare: (p) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, `${JSON.stringify(record('-1', 1, 'from an older version'))}\n`);
        loose(p);
      },
      targets: (p) => [p],
      tightens: (p) => p,
    },
  ];

  it.each(CELLS)('keeps $name owner-only', ({ prepare, compact, targets, tightens }) => {
    // Nested, so the directories under test are ones the store had to create itself.
    const nested = join(dir, 'nested', 'deep', 'store.jsonl');
    prepare?.(nested);
    const stderr = captureStderr();

    const store = new ObservedStore(nested, 2, 10);
    for (let i = 1; i <= (compact === true ? 8 : 1); i++) {
      store.append(record('-1', 100 + i, `m${i}`));
    }
    store.close();

    for (const target of targets(nested)) expect(modeOf(target) & 0o077).toBe(0);
    // A tightening is never silent, and a store that was already tight says nothing at all.
    const named = tightens?.(nested);
    if (named === undefined) expect(stderr).toEqual([]);
    else expect(stderr.join('')).toContain(`tightened ${named}`);
  });

  /**
   * `<store_path>.tmp` is a predictable name in a directory the store does not own — `store_path`
   * can be anywhere the operator put it, and `mkdirSync(…, {mode: 0o700})` applies only to
   * directories the store itself created. A compaction renames whatever that name resolves to over
   * the store, so anything already there that is not a regular file this call created would let a
   * local attacker redirect the full plaintext of every observed message (and have its mode
   * narrowed for them). Every kind of squatted temp path is graded on the same two outcomes.
   */
  const SQUATTED = [
    { name: 'a world-readable regular file', kind: 'file' as const, compacts: true },
    { name: 'a symlink to a file outside the store directory', kind: 'symlink-file' as const, compacts: false },
    { name: 'a symlink to a directory outside the store directory', kind: 'symlink-dir' as const, compacts: false },
    { name: 'a dangling symlink', kind: 'symlink-dangling' as const, compacts: false },
    { name: 'a directory', kind: 'dir' as const, compacts: false },
    { name: 'a FIFO', kind: 'fifo' as const, compacts: false },
  ];

  it.each(SQUATTED)('refuses to compact through $name, leaving what it points at alone', ({ kind, compacts }) => {
    const outside = mkdtempSync(join(tmpdir(), 'parley-tg-victim-'));
    const victimFile = join(outside, 'victim.txt');
    const victimDir = join(outside, 'victim-dir');
    writeFileSync(victimFile, 'private\n');
    chmodSync(victimFile, 0o644);
    mkdirSync(victimDir);
    const store = join(dir, 'squat', 'store.jsonl');
    mkdirSync(dirname(store), { recursive: true });
    const tmp = `${store}.tmp`;
    if (kind === 'file') writeFileSync(tmp, 'junk\n');
    if (kind === 'symlink-file') symlinkSync(victimFile, tmp);
    if (kind === 'symlink-dir') symlinkSync(victimDir, tmp);
    if (kind === 'symlink-dangling') symlinkSync(join(outside, 'not-there'), tmp);
    if (kind === 'dir') mkdirSync(tmp);
    if (kind === 'fifo') execFileSync('mkfifo', [tmp]);

    const stderr = captureStderr();
    const observed = new ObservedStore(store, 2, 10);
    // Eight appends under newest-2 drive several compactions.
    for (let i = 1; i <= 8; i++) expect(observed.append(record('-1', i, `secret-${i}`))).toBeDefined();
    observed.close();

    // Nothing outside the store's own directory was touched, whatever the temp path pointed at.
    expect(readFileSync(victimFile, 'utf8')).toBe('private\n');
    expect(modeOf(victimFile)).toBe(0o644);
    expect(readdirSync(victimDir)).toEqual([]);
    if (compacts) {
      expect(stderr.join('')).not.toMatch(/refusing to compact/);
      expect(lineCount(store)).toBeLessThanOrEqual(4);
      // The squatted file was replaced, not written through: the rename consumed a fresh one.
      expect(existsSync(tmp)).toBe(false);
      expect(readFileSync(store, 'utf8')).toContain('secret-8');
    } else {
      // Loud, and the store keeps every record rather than trading durability for a compaction —
      // on the load path too, where a throw is the only way to say it.
      expect(stderr.join('')).toMatch(/refusing to compact/);
      expect(stderr.join('')).toContain(tmp);
      expect(lineCount(store)).toBe(8);
      expect(() => new ObservedStore(store, 2, 10)).toThrow(/refusing to compact/);
      rmSync(tmp, { recursive: true, force: true });
    }
    // Every record survived the obstruction, and the store compacts again once it clears.
    const reopened = new ObservedStore(store, 2, 10);
    expect(reopened.entries('-1').map((r) => r.content)).toEqual(['secret-7', 'secret-8']);
    reopened.close();
    expect(lineCount(store)).toBe(2);
    rmSync(outside, { recursive: true, force: true });
  });
});
