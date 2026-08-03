import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { siblingPaths } from '../src/store-file.js';
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
    // An EMPTY target loads clean, so nothing downstream re-mints an identity and rewrites the file
    // — which is the one shape under which a followed symlink at the store path survives the whole
    // run and every observed message goes through it. A non-empty one is broken by the first
    // compaction's rename, and would hide the disclosure behind a repair.
    { name: 'a symlink to an empty file outside the store directory', kind: 'symlink-empty' as const, compacts: false },
    { name: 'a symlink to a directory outside the store directory', kind: 'symlink-dir' as const, compacts: false },
    { name: 'a dangling symlink', kind: 'symlink-dangling' as const, compacts: false },
    { name: 'a directory', kind: 'dir' as const, compacts: false },
    { name: 'a FIFO', kind: 'fifo' as const, compacts: false },
  ];

  /** A bystander's file and directory, outside the store's own directory entirely. */
  interface Victim {
    root: string;
    file: string;
    empty: string;
    dir: string;
  }

  const layVictim = (): Victim => {
    const root = mkdtempSync(join(tmpdir(), 'parley-tg-victim-'));
    const victim = {
      root,
      file: join(root, 'victim.txt'),
      empty: join(root, 'empty.txt'),
      dir: join(root, 'victim-dir'),
    };
    writeFileSync(victim.file, 'private\n');
    chmodSync(victim.file, 0o644);
    writeFileSync(victim.empty, '');
    chmodSync(victim.empty, 0o644);
    mkdirSync(victim.dir);
    return victim;
  };

  /** Squat `at` with one kind of thing an attacker who can write the store's directory can put there. */
  const squat = (kind: (typeof SQUATTED)[number]['kind'], at: string, victim: Victim): void => {
    if (kind === 'file') writeFileSync(at, 'junk\n');
    if (kind === 'symlink-file') symlinkSync(victim.file, at);
    if (kind === 'symlink-empty') symlinkSync(victim.empty, at);
    if (kind === 'symlink-dir') symlinkSync(victim.dir, at);
    if (kind === 'symlink-dangling') symlinkSync(join(victim.root, 'not-there'), at);
    if (kind === 'dir') mkdirSync(at);
    if (kind === 'fifo') execFileSync('mkfifo', [at]);
  };

  it.each(SQUATTED)('refuses to compact through $name, leaving what it points at alone', ({ kind, compacts }) => {
    const victim = layVictim();
    const victimFile = victim.file;
    const victimDir = victim.dir;
    const outside = victim.root;
    const store = join(dir, 'squat', 'store.jsonl');
    mkdirSync(dirname(store), { recursive: true });
    const tmp = `${store}.tmp`;
    squat(kind, tmp, victim);

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

  /**
   * `<store_path>.tmp` was never the only predictable name beside the store. The store FILE itself,
   * the `<store_path>.hw` high-water and the two lock siblings are equally choosable by anyone who
   * can create a file in the directory `store_path` names, and each was opened by a call that
   * follows a symlink: the plaintext of every observed message went through a squatted store path,
   * and a squatted `.hw` truncated whatever it pointed at.
   *
   * The path axis is read out of `siblingPaths`, so a sibling a later change adds is swept here
   * without anyone remembering to. What is graded is the property, not any refusal's spelling:
   * nothing outside the store's own directory is written through, truncated, re-moded or added to,
   * and the store either refuses naming a path or serves every record out of a regular file of its
   * own. A squat that made the store BLOCK would fail this too — a `readFileSync` on a squatted FIFO
   * parks the whole process, which no assertion about the outcome could ever reach.
   */
  const SQUATTABLE = ['store', ...Object.keys(siblingPaths(''))];
  const pathOf = (store: string, which: string): string =>
    which === 'store' ? store : (siblingPaths(store) as Record<string, string>)[which] ?? store;

  const FAMILY = SQUATTED.flatMap(({ kind }) => SQUATTABLE.map((which) => ({ kind, which })));

  /** Every file under `root`, recursively — what a leak would have to show up in. */
  const filesUnder = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((e) => {
      const full = join(root, e.name);
      return e.isDirectory() ? filesUnder(full) : [full];
    });

  it.each(FAMILY)('reaches nothing outside its own directory when $which is squatted with a $kind', ({ kind, which }) => {
    const victim = layVictim();
    const store = join(dir, 'family', 'store.jsonl');
    mkdirSync(dirname(store), { recursive: true });
    const target = pathOf(store, which);
    squat(kind, target, victim);

    captureStderr();
    let refusal: Error | undefined;
    try {
      const observed = new ObservedStore(store, 2, 10);
      for (let i = 1; i <= 8; i++) observed.append(record('-1', i, `secret-${i}`));
      expect(observed.entries('-1').map((r) => r.content)).toEqual(['secret-7', 'secret-8']);
      observed.close();
    } catch (err) {
      refusal = err as Error;
    }

    expect(readFileSync(victim.file, 'utf8')).toBe('private\n');
    expect(readFileSync(victim.empty, 'utf8')).toBe('');
    expect(modeOf(victim.file)).toBe(0o644);
    expect(modeOf(victim.empty)).toBe(0o644);
    expect(readdirSync(victim.dir)).toEqual([]);
    expect(filesUnder(victim.root).sort()).toEqual([victim.empty, victim.file].sort());
    for (const leaked of filesUnder(victim.root)) {
      expect(readFileSync(leaked, 'utf8')).not.toContain('secret-');
    }

    if (refusal === undefined) {
      expect(lstatSync(store).isFile()).toBe(true);
      expect(modeOf(store) & 0o077).toBe(0);
    } else {
      expect(refusal.message).toContain(target);
    }
    rmSync(victim.root, { recursive: true, force: true });
  });
});
