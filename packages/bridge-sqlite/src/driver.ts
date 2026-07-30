import { chmodSync, closeSync, openSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { classifyDbError, errMessage } from './classify.js';

// Lazy CJS require so the native module (better-sqlite3) or the built-in (node:sqlite)
// is only loaded on demand — and the experimental warning for node:sqlite only appears
// if we actually fall back to it.
const require = createRequire(import.meta.url);

export type SqlParam = string | number | bigint | null;

export interface RunResult {
  lastInsertRowid: number | bigint;
  changes: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlParam[]): RunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

/**
 * The 4-method driver surface (DESIGN §9). better-sqlite3 and node:sqlite both satisfy it
 * almost identically, so swapping drivers touches ONLY this file. Both are synchronous, both
 * support WAL + busy_timeout for safe concurrent multi-process writes (DESIGN §9/§10).
 */
export interface SqlDriver {
  readonly kind: 'better-sqlite3' | 'node:sqlite';
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface OpenOptions {
  /** PRAGMA busy_timeout (ms) — retry window when another process holds the write lock. */
  busyTimeoutMs?: number;
}

// Minimal structural shapes (we use createRequire, so we don't import the modules' types).
interface RawStmt {
  run(...p: SqlParam[]): RunResult;
  get(...p: SqlParam[]): unknown;
  all(...p: SqlParam[]): unknown[];
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
  close(): void;
}

function wrap(kind: SqlDriver['kind'], db: RawDb): SqlDriver {
  return {
    kind,
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...p) => stmt.run(...p),
        get: (...p) => stmt.get(...p),
        all: (...p) => stmt.all(...p),
      };
    },
    close: () => {
      db.close();
    },
  };
}

/**
 * Load the native module once (memoized), distinguishing "not installed / no prebuilt" — where
 * the node:sqlite fallback is legitimate — from a real load error, which must surface.
 * `undefined` = not yet attempted; `null` = absent (fall back); a function = the constructor.
 * Deliberately split from DB open so a bad path / permissions / corrupt-file error (which comes
 * from `new Database(path)`, not the `require`) is NOT mistaken for a missing module.
 */
let betterSqliteCtor: (new (p: string) => RawDb) | null | undefined;
function loadBetterSqlite(): (new (p: string) => RawDb) | null {
  if (betterSqliteCtor !== undefined) return betterSqliteCtor;
  try {
    betterSqliteCtor = require('better-sqlite3') as new (p: string) => RawDb;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Only a genuinely-absent module is a fallback trigger; any other load error must propagate
    // so we surface it rather than silently switching the project onto the experimental builtin.
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_DLOPEN_FAILED') throw e;
    betterSqliteCtor = null;
  }
  return betterSqliteCtor;
}

/**
 * Open a SQLite database with WAL + busy_timeout. Prefers the mature native driver
 * (better-sqlite3); falls back to Node's built-in `node:sqlite` ONLY if the native module fails
 * to *load* (e.g. no prebuilt for this ABI and no toolchain) — an *open* failure (bad path,
 * permissions, corrupt file) surfaces better-sqlite3's own precise message instead. The plugin
 * code above is driver-agnostic.
 */
export function openDriver(path: string, opts: OpenOptions = {}): SqlDriver {
  const onDisk = path !== ':memory:' && !path.startsWith('file::memory:');
  // Keep this ahead of the driver open, so that there is no window in which the driver creates
  // the whole conversation store at the umask default and it is briefly world-readable.
  if (onDisk) precreate(path);
  const driver = openConnection(path);
  try {
    applyPragmas(driver, opts.busyTimeoutMs ?? 5000);
  } catch (e) {
    // Keep the close on the failure path, so that a caller retrying a permanently-failing open —
    // a supervisor restarting a bridge against a typo'd path — cannot leak a handle per attempt.
    driver.close();
    throw e;
  }
  // An existing store (or a -wal/-shm sidecar SQLite created at the umask default) can still be
  // group/world-readable, and neither driver exposes a mode option. Narrow anything wider, and
  // say so — including when it cannot be done, which is what a second bridge running as a
  // different UID hits.
  if (onDisk) {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) restrictMode(f);
  }
  return driver;
}

function openConnection(path: string): SqlDriver {
  const Better = loadBetterSqlite();
  if (Better !== null) {
    // Construct OUTSIDE any try/catch: a bad path / permissions / corrupt file throws its OWN
    // actionable message rather than being swallowed and replaced by node:sqlite's vaguer one.
    return wrap('better-sqlite3', new Better(path));
  }
  try {
    const mod = require('node:sqlite') as { DatabaseSync: new (p: string) => RawDb };
    return wrap('node:sqlite', new mod.DatabaseSync(path));
  } catch (e) {
    // The native module was absent AND the builtin fallback also failed → surface the fallback
    // failure WITH the original error attached as `cause`, not in place of it.
    process.stderr.write('parley-sqlite: better-sqlite3 unavailable; node:sqlite fallback failed\n');
    throw new Error(`node:sqlite fallback failed opening ${path}`, { cause: e });
  }
}

/** How many times a lock-classed WAL conversion is retried before the driver degrades. */
export const WAL_RETRIES = 20;

function applyPragmas(driver: SqlDriver, busyTimeoutMs: number): void {
  // Keep busy_timeout first AND the WAL conversion bounded-retried, so that a fresh-file
  // delete→WAL conversion racing another opener cannot crash connect(): SQLite does NOT consult
  // the busy handler for a journal-mode change, so it returns SQLITE_BUSY immediately even with
  // a timeout set.
  driver.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  for (let i = 0; ; i++) {
    try {
      // WAL: readers don't block the single writer; multiple processes can post concurrently.
      driver.exec('PRAGMA journal_mode = WAL');
      break;
    } catch (e) {
      // Only contention is worth waiting out. Keep everything else propagating on the first
      // attempt, so that a file that is not a database, a read-only mount or a full volume shows
      // its own error instead of ~300 ms of blocking spin and a line blaming a peer's write lock.
      if (classifyDbError(e) !== 'lock') throw e;
      if (i >= WAL_RETRIES) {
        // WAL is persistent; the conversion race only exists until the file is first converted.
        // Degrade rather than crash connect(): the default journal mode is still correct.
        process.stderr.write(
          `parley-sqlite: WAL conversion still busy after ${i} retries; ` +
            `continuing in default journal mode: ${errMessage(e)}\n`,
        );
        break;
      }
      // Synchronous few-ms backoff (openDriver is sync): Atomics.wait on a throwaway buffer.
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, 5 + i); // ~5–25 ms, monotonically backing off
    }
  }
  driver.exec('PRAGMA synchronous = NORMAL');
}

/**
 * Claim the path at 0600 before anything else can create it. Stay silent on failure, so that a
 * bad path or a permissions problem surfaces the driver's own precise open error below rather
 * than this one.
 */
function precreate(path: string): void {
  try {
    closeSync(openSync(path, 'a', 0o600));
  } catch {
    /* the open below reports it */
  }
}

/** Narrow a file that is readable beyond its owner, reporting both the change and any failure. */
function restrictMode(path: string): void {
  let current: number;
  try {
    current = statSync(path).mode & 0o777;
  } catch {
    return; // sidecar not created yet
  }
  if ((current & 0o077) === 0) return;
  const target = current & 0o700;
  try {
    chmodSync(path, target);
    process.stderr.write(
      `parley-sqlite: tightened ${path} from 0${current.toString(8)} to 0${target.toString(8)} ` +
        `(the message store must not be readable by other accounts)\n`,
    );
  } catch (e) {
    process.stderr.write(
      `parley-sqlite: cannot restrict ${path} (mode 0${current.toString(8)}, ` +
        `${e instanceof Error ? e.message : String(e)}) — the message store is readable by other ` +
        `accounts on this host\n`,
    );
  }
}
