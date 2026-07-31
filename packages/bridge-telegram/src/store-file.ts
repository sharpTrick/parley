import { chmodSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { describe, note } from './diagnostics.js';

/** Mode for everything the store creates — the plaintext of every message the bridge has seen. */
export const OWNER_ONLY_FILE = 0o600;
/** Mode for a directory the store creates for its path. */
export const OWNER_ONLY_DIR = 0o700;

/** Sibling path claiming a store file for one process — see {@link StoreLock}. */
const LOCK_SUFFIX = '.lock';

/**
 * Narrow a store file readable beyond its owner, reporting the change. An `openSync` mode applies
 * only to a file it CREATES, so an upgrade onto a store written by an earlier version — or a
 * compaction output a broken umask widened — is otherwise left silently world-readable. Only files
 * the store owns are touched: a pre-existing DIRECTORY can be the operator's working directory or
 * a shared state root, and narrowing that on their behalf is a bigger surprise than the one it
 * prevents.
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
