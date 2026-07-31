import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
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

/** Sibling path claiming a store file for one process — see {@link StoreLock}. */
const LOCK_SUFFIX = '.lock';

/**
 * Narrow a store file readable beyond its owner, reporting the change. An `openSync` mode applies
 * only to a file it CREATES, so an upgrade onto a store written by an earlier version — or a
 * compaction output a broken umask widened — is otherwise left silently world-readable. Keep this
 * to files the store owns, so that a pre-existing DIRECTORY — an operator's working directory, a
 * shared state root — is never narrowed on their behalf.
 */
export function restrictMode(path: string): void {
  let current: number;
  try {
    current = statSync(path).mode & 0o777;
  } catch {
    return;
  }
  if ((current & 0o077) === 0) return;
  const target = current & 0o700;
  try {
    chmodSync(path, target);
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
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
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
  /** Set once {@link claim} succeeded, so {@link release} can never unlink another process's claim. */
  private held = false;

  constructor(private readonly storePath: string) {
    this.path = `${storePath}${LOCK_SUFFIX}`;
  }

  claim(): void {
    if (this.tryClaim()) return;
    const holder = lockHolder(this.path);
    if (holder === undefined || !processExists(holder)) {
      try {
        unlinkSync(this.path);
      } catch {
        // Another starter cleared the same stale claim; the retry below decides who holds it.
      }
      if (this.tryClaim()) return;
    }
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

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
    this.lock = new StoreLock(path);
    this.lock.claim();
  }

  /** The file's bytes, or `''` when there is none yet — a first run against this path. */
  read(): string {
    try {
      return readFileSync(this.path, 'utf8');
    } catch {
      return '';
    }
  }

  /** Take the append descriptor, narrowing a mode an earlier version or a broad umask left open. */
  open(): void {
    this.fd = openSync(this.path, 'a', OWNER_ONLY_FILE);
    restrictMode(this.path);
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
    const tmp = `${this.path}.tmp`;
    const fd = this.openTemp(tmp);
    try {
      writeSync(fd, text);
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
      this.fd = openSync(this.path, 'a', OWNER_ONLY_FILE);
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
      this.fd = openSync(this.path, 'a', OWNER_ONLY_FILE);
    } catch {
      return undefined;
    }
    return this.fd;
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
