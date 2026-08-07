import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { describe, Diagnostics, note } from './diagnostics.js';

/** Mode for everything the store creates — the plaintext of every message the bridge has seen. */
export const OWNER_ONLY_FILE = 0o600;
/** Mode for a directory the store creates for its path. */
export const OWNER_ONLY_DIR = 0o700;

/**
 * Every path the store writes BESIDE its file: the claim on it ({@link StoreLock}), the sibling held
 * across a stale-claim take-over ({@link StoreLock.replaceStale}), the sequence high-water
 * ({@link StoreFile.readMark}) and a compaction's rewrite target ({@link StoreFile.replace}).
 *
 * Derived in ONE place, so that a sibling a later change adds is one the suite grading a squat on
 * each of them inherits rather than falls behind: every one is a predictable name in a directory the
 * store does not own.
 */
export function siblingPaths(storePath: string): {
  lock: string;
  break: string;
  mark: string;
  tmp: string;
} {
  return {
    lock: `${storePath}.lock`,
    break: `${storePath}.lock.break`,
    mark: `${storePath}.hw`,
    tmp: `${storePath}.tmp`,
  };
}

/**
 * Flags every open of a store path carries on top of what the caller asked for. `store_path` can be
 * anywhere the operator put it and each sibling below is a predictable name beside it, so anyone who
 * can create a file in that directory chooses what these opens resolve to.
 *
 * Keep the refusal IN the open. `O_NOFOLLOW` makes the kernel reject a final component that is a
 * symlink as part of the same syscall, so there is no interval an attacker can win; an
 * `lstat`-then-open would hand them exactly that interval. `O_NONBLOCK`, so that a squatted FIFO
 * fails the open instead of parking the whole bridge inside it — a read of one blocks forever, and
 * `openSync`/`readFileSync` block the event loop with it.
 */
const GUARDED = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Open one of the store's own paths, refusing anything but a regular file. The `fstat` reads the
 * DESCRIPTOR rather than the name, so what it grades is the file this call is already holding.
 */
function openOwn(path: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags | GUARDED, OWNER_ONLY_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOOP') throw err;
    throw new Error(
      `ObservedStore: refusing to open '${path}' — it is a symlink. This file and its siblings ` +
        `carry the plaintext of every message the bridge has observed, so following one would ` +
        `write that wherever the link points and narrow that target's mode. Name a real file.`,
    );
  }
  let regular: boolean;
  try {
    regular = fstatSync(fd).isFile();
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  if (!regular) {
    closeSync(fd);
    throw new Error(
      `ObservedStore: refusing to use '${path}' — it exists and is not a regular file, so the ` +
        `observed-message store would be written somewhere nothing can read it back from.`,
    );
  }
  return fd;
}

/** The bytes at one of the store's own paths, or `''` when it is not a readable regular file. */
function readOwn(path: string): string {
  let fd: number;
  try {
    fd = openOwn(path, constants.O_RDONLY);
  } catch {
    return '';
  }
  try {
    return readFileSync(fd, 'utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Write every byte of `text` to `fd`, or fail. `writeSync` performs ONE `write(2)` and returns the
 * count the kernel took — it does NOT loop, unlike the `appendFileSync`/`writeFileSync` this module
 * relies on elsewhere. Keep the loop and the refusal, so that a filesystem which accepts a partial
 * write (ENOSPC after part of it, EFBIG under a size rlimit) cannot have a truncated prefix
 * published over the only copy of this backend's history as though it were whole.
 */
function writeAll(fd: number, path: string, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.byteLength) {
    const took = writeSync(fd, bytes, written, bytes.byteLength - written);
    if (took <= 0) {
      throw new Error(
        `ObservedStore: '${path}' took ${written} of ${bytes.byteLength} bytes and then stopped ` +
          `accepting any — refusing to publish a truncated observed-message store.`,
      );
    }
    written += took;
  }
}

/** Replace one of the store's own paths with `text`, refusing a squatted target as {@link openOwn}. */
function writeOwn(path: string, text: string): void {
  const fd = openOwn(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
  try {
    writeAll(fd, path, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Narrow a store file readable beyond its owner, reporting the change. An `openSync` mode applies
 * only to a file it CREATES, so an upgrade onto a store written by an earlier version — or a
 * compaction output a broken umask widened — is otherwise left silently world-readable. Take the
 * DESCRIPTOR and not the name, so that the mode change lands on the file this process opened and can
 * never be redirected onto a symlink's target, or onto a pre-existing DIRECTORY — an operator's
 * working directory, a shared state root — that is not ours to narrow.
 */
export function restrictMode(fd: number, path: string): void {
  let current: number;
  try {
    current = fstatSync(fd).mode & 0o777;
  } catch {
    return;
  }
  if ((current & 0o077) === 0) return;
  const target = current & 0o700;
  try {
    fchmodSync(fd, target);
    note(
      `tightened ${path} from 0${current.toString(8)} to 0${target.toString(8)} ` +
        `(the observed-message store must not be readable by other accounts)`,
    );
  } catch (err) {
    note(
      `cannot restrict ${path} (mode 0${current.toString(8)}, ${describe(err)}) — the ` +
        `observed-message store is readable by other accounts on this host`,
    );
  }
}

/** The pid a lock sibling names, or `undefined` when it carries nothing readable. */
function lockHolder(path: string): number | undefined {
  const pid = Number(readOwn(path).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** True while `pid` names a live process — EPERM is a process we may not signal, not a dead one. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * This process's exclusive claim on a store file, held through a `<path>.lock` sibling. Two bridges
 * on one observed-message store hand the SAME cursor to two different messages and each one's
 * compaction renames its own view over the other's history — silently, and with no Bot API history
 * endpoint to rebuild from — so the second one must fail to start rather than corrupt. A claim
 * naming a process that is gone is a crashed bridge's leftover and is replaced.
 */
export class StoreLock {
  readonly path: string;
  private readonly breakPath: string;
  /** Set once {@link claim} succeeded, so {@link release} can never unlink another process's claim. */
  private held = false;

  constructor(private readonly storePath: string) {
    const siblings = siblingPaths(storePath);
    this.path = siblings.lock;
    this.breakPath = siblings.break;
  }

  claim(): void {
    if (this.tryClaim()) return;
    const holder = lockHolder(this.path);
    if ((holder === undefined || !processExists(holder)) && this.replaceStale()) return;
    throw new Error(
      `ObservedStore: '${this.storePath}' is already claimed by process ` +
        `${holder === undefined ? 'unknown' : String(holder)} through '${this.path}'. Two ` +
        `bridges on one observed-message store mint colliding cursors and each compaction discards ` +
        `the other's history, so give this one its own backend_config.store_path. If no such ` +
        `process is running, remove '${this.path}'.`,
    );
  }

  /** Drop this process's claim on the store file. Never touches one it does not hold. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone — the claim is released either way.
    }
  }

  /**
   * Take over a claim whose process is gone. Every removal of the claim path happens under a
   * second sibling taken exclusively, the liveness question is re-asked beneath it, and the
   * take-over publishes by RENAME rather than by unlink-then-create — so that two starters which
   * both saw the same dead pid cannot each drop the other's fresh claim and both hold the store.
   */
  private replaceStale(): boolean {
    try {
      writeFileSync(this.breakPath, `${process.pid}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
    } catch {
      return false;
    }
    let renamed = false;
    try {
      if (this.tryClaim()) return true;
      const holder = lockHolder(this.path);
      if (holder !== undefined && processExists(holder)) return false;
      try {
        renameSync(this.breakPath, this.path);
      } catch {
        return false;
      }
      renamed = true;
      this.held = true;
      return true;
    } finally {
      if (!renamed) {
        try {
          unlinkSync(this.breakPath);
        } catch {
          // Never created, or already consumed by the rename; the take-over decided either way.
        }
      }
    }
  }

  /** Create the claim, or report that one is already there. Any other failure is the caller's. */
  private tryClaim(): boolean {
    try {
      writeFileSync(this.path, `${process.pid}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    this.held = true;
    return true;
  }
}

/**
 * The observed-message store's file on disk, and nothing about what the lines mean: this process's
 * {@link StoreLock} claim on it, the persistent append descriptor, and the atomic whole-file
 * replace a compaction is made of. Constructing one CLAIMS the file, so a second bridge on the same
 * store fails here rather than corrupting it.
 */
export class StoreFile {
  private readonly lock: StoreLock;
  /** Persistent append descriptor — one open fd for the process, not open/close per line. */
  private fd: number | undefined;
  /** Set by {@link close} — the difference between "released on purpose" and "lost the fd". */
  private closed = false;
  /**
   * A write that threw may have left bytes with no terminating newline (a short write on ENOSPC),
   * and the torn-tail repair only runs at LOAD. Keep the flag, so that the next line opens a fresh
   * one instead of gluing onto the fragment — which would lose a record `append` had already
   * returned as durable, alongside the fragment.
   */
  private tornTail = false;
  private readonly diagnostics = new Diagnostics();
  private readonly markPath: string;
  private readonly tmpPath: string;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
    const siblings = siblingPaths(path);
    this.markPath = siblings.mark;
    this.tmpPath = siblings.tmp;
    this.lock = new StoreLock(path);
    this.lock.claim();
  }

  /**
   * The sequence high-water recorded BESIDE the file, or 0 when there is none. Keep it out of the
   * append-only file, so that a tail rolled back to an earlier copy of it — which takes the newest
   * records and the watermark lines naming them away together, leaving a file whose every internal
   * claim agrees with itself — is still distinguishable from one that legitimately holds fewer.
   */
  readMark(): number {
    const mark = Number(readOwn(this.markPath).trim());
    return Number.isInteger(mark) && mark >= 0 ? mark : 0;
  }

  /**
   * Record `seq` beside the file. Write it AFTER the line it names, so that a crash between the two
   * leaves a mark BELOW the file rather than above it — above is what the loader reads as records
   * gone missing, and a mark that ran ahead would re-mint the store's identity after every crash.
   */
  mark(seq: number): void {
    try {
      writeOwn(this.markPath, `${seq}\n`);
    } catch (err) {
      this.diagnostics.report(
        `could not record the sequence high-water beside ${this.path} (${describe(err)}) — a tail ` +
          `rolled back to an earlier copy of the store file would not be detected`,
        'high-water-mark',
      );
    }
  }

  /** The file's bytes, or `''` when there is none yet — a first run against this path. */
  read(): string {
    return readOwn(this.path);
  }

  /** Take the append descriptor, narrowing a mode an earlier version or a broad umask left open. */
  open(): void {
    const fd = this.openAppend();
    this.fd = fd;
    restrictMode(fd, this.path);
  }

  /** True while the append descriptor is held — false after {@link close}, or if a reopen failed. */
  isOpen(): boolean {
    return this.fd !== undefined;
  }

  /** True iff a line could be written right now — {@link write} without the writing. */
  writable(): boolean {
    return this.openFd() !== undefined;
  }

  /**
   * Write one newline-terminated line, opening a fresh one first after a {@link tornTail}.
   *
   * Nothing is written when no append descriptor can be opened. A caller whose own state moves with
   * the write asks {@link writable} FIRST, so that the refusal lands before it has moved.
   */
  write(line: string): void {
    const fd = this.openFd();
    if (fd === undefined) return;
    try {
      appendFileSync(fd, this.tornTail ? `\n${line}\n` : `${line}\n`);
      this.tornTail = false;
    } catch (err) {
      this.tornTail = true;
      throw err;
    }
  }

  /**
   * Write one bookkeeping line, reporting rather than throwing when it cannot be written. These
   * lines carry protection and identity, not records: the caller of a seam method that triggers one
   * has nothing to retry, and failing its call would report a message as lost that is not.
   */
  note(line: string): void {
    try {
      this.write(line);
    } catch (err) {
      this.diagnostics.report(
        `could not record '${line.split(' ')[0] ?? ''}' in ${this.path} (${describe(err)}) — this ` +
          `run is unaffected and the next restart loses what the line carried`,
        'bookkeeping-line',
      );
    }
  }

  /**
   * Replace the whole file with `text`, via a temp file and a rename. Keep the replace atomic, so
   * that a crash or a full disk mid-rewrite cannot truncate the only copy of history this backend
   * can ever produce.
   */
  replace(text: string): void {
    const tmp = this.tmpPath;
    const fd = this.openTemp(tmp);
    try {
      writeAll(fd, tmp, text);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file is already gone; the original is untouched either way.
      }
      throw err;
    }
    closeSync(fd);
    renameSync(tmp, this.path);
    this.tornTail = false;
  }

  /**
   * {@link replace}, giving up the append descriptor across the rewrite. Release the descriptor
   * number BEFORE the rewrite can throw, so that a failed compaction cannot leave appends writing
   * into whatever file or socket has since reused it.
   */
  compact(text: string): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    try {
      this.replace(text);
    } finally {
      this.fd = this.openAppend();
    }
  }

  /** Release the append descriptor and give up this process's claim on the file. */
  close(): void {
    this.closed = true;
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    this.lock.release();
  }

  /**
   * Hold the append descriptor, reopening one a failed compaction could not restore. Keep the
   * retry, so that one transient EMFILE/ENOSPC inside a rewrite does not turn the store into a
   * permanent black hole that refuses every later record. A file {@link close}d on purpose stays
   * closed.
   */
  private openFd(): number | undefined {
    if (this.fd !== undefined) return this.fd;
    if (this.closed) return undefined;
    try {
      this.fd = this.openAppend();
    } catch {
      return undefined;
    }
    return this.fd;
  }

  /** The append descriptor on the store file itself, under {@link openOwn}'s refusals. */
  private openAppend(): number {
    return openOwn(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  }

  /**
   * The rewrite target, CREATED by this call. `<path>.tmp` is predictable and the rename
   * publishes whatever it names over the store, so open it exclusively (`wx` — `O_EXCL|O_CREAT`
   * refuses an existing file and never follows a symlink) and refuse anything already there that is
   * not a regular file. Otherwise anyone who can create a file in the store's directory redirects
   * the full plaintext of every observed message, and gets its mode changed for them.
   */
  private openTemp(tmp: string): number {
    try {
      return openSync(tmp, 'wx', OWNER_ONLY_FILE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (!lstatSync(tmp).isFile()) {
      throw new Error(
        `ObservedStore: refusing to compact through '${tmp}' — it exists and is not a regular ` +
          `file, so the rename would publish it as the observed-message store. Remove it.`,
      );
    }
    unlinkSync(tmp);
    return openSync(tmp, 'wx', OWNER_ONLY_FILE);
  }
}
