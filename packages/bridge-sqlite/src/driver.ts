import { createRequire } from 'node:module';
import { precreate, restrictMode } from './at-rest.js';
import { classifyDbError, errMessage } from './classify.js';

// Keep this a lazy CJS require rather than a static import, so that node:sqlite's experimental
// warning reaches an operator only when the fallback is the driver actually in use.
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
 * permissions, corrupt file) surfaces better-sqlite3's own precise message instead.
 */
export function openDriver(path: string, opts: OpenOptions = {}): SqlDriver {
  // Keep this ahead of the driver open for every path but the one literal that names no file under
  // either driver, so that there is no window in which the driver creates the whole conversation
  // store at the umask default and it is briefly world-readable. Whether a path really names a
  // file is a question only the open below can answer, and by then the window has passed.
  if (path !== ':memory:') precreate(path);
  const driver = openConnection(path);
  let files: string[];
  try {
    files = storeFiles(driver, path);
    applyPragmas(driver, opts.busyTimeoutMs ?? 5000, files.length > 0);
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
  for (const f of files) for (const suffix of ['', '-wal', '-shm']) restrictMode(`${f}${suffix}`);
  return driver;
}

/**
 * Every name the store SQLite actually opened can be reached by, or none if it opened no file at
 * all. Ask the connection rather than classify the path: the drivers disagree about what a path
 * means — node:sqlite resolves SQLite URIs, better-sqlite3 opens a file literally named after one —
 * so a heuristic over the string decides at-rest hardening for a file it has never looked at. The
 * path as given is kept beside the resolved answer because a symlink or a relative path leaves the
 * same file under two names, and the one an operator configured is the one worth naming on stderr.
 */
function storeFiles(driver: SqlDriver, path: string): string[] {
  let resolved: unknown;
  try {
    const rows = driver.prepare('PRAGMA database_list').all() as Array<Record<string, unknown>>;
    const main = rows.find((r) => r['name'] === 'main');
    // Keep an unanswered question on the file side, so that a driver which will not say is
    // hardened and WAL-gated anyway: narrowing a file that turns out not to exist costs nothing,
    // and serving an unhardened store costs the whole conversation.
    if (main === undefined) return [path];
    resolved = main['file'];
  } catch {
    return [path];
  }
  if (typeof resolved !== 'string' || resolved === '') return [];
  return resolved === path ? [path] : [path, resolved];
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
    const driver = wrap('node:sqlite', new mod.DatabaseSync(path));
    // Announce the substitution, so that an operator whose optional install was skipped learns it
    // from a line rather than from the performance difference.
    process.stderr.write(
      'parley-sqlite: better-sqlite3 unavailable; using the node:sqlite fallback driver\n',
    );
    return driver;
  } catch (e) {
    // The native module was absent AND the builtin fallback also failed → surface the fallback
    // failure WITH the original error attached as `cause`, not in place of it.
    const detail = `node:sqlite fallback failed opening ${path}${versionHint(e)}`;
    process.stderr.write(`parley-sqlite: better-sqlite3 unavailable; ${detail}\n`);
    throw new Error(detail, { cause: e });
  }
}

/** Node version that introduced `node:sqlite`; below it the fallback driver does not exist. */
export const NODE_SQLITE_MIN = '22.5.0';

/**
 * Name the version requirement when the BUILTIN is what is missing — the one fallback failure an
 * operator cannot diagnose from the error itself, since a Node too old to carry `node:sqlite`
 * reports it exactly as it reports a typo'd module.
 */
function versionHint(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && code !== 'MODULE_NOT_FOUND') return '';
  return (
    `: node:sqlite requires Node >= ${NODE_SQLITE_MIN} and this is ${process.versions.node} — ` +
    `install better-sqlite3, or upgrade Node`
  );
}

/** How many times a lock-classed WAL conversion is retried before the open fails. */
export const WAL_RETRIES = 20;

function journalMode(driver: SqlDriver): string {
  const row = driver.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
  return String(Object.values(row ?? {})[0] ?? '').toLowerCase();
}

function walUnreachable(mode: string, contention: unknown): Error {
  const why =
    contention === undefined
      ? `reported no error but left journal_mode=${mode}`
      : `still busy after ${WAL_RETRIES} retries, leaving journal_mode=${mode}: ${errMessage(contention)}`;
  return new Error(
    `parley-sqlite: WAL conversion ${why}. Refusing the connection rather than serving the store ` +
      'in a rollback journal: WAL is what lets peer bridges read and write one file concurrently, ' +
      'and it is the only journal mode `synchronous = NORMAL` is corruption-safe in. WAL is ' +
      'persistent, so a first-boot race resolves itself — retry once the peer holding the write ' +
      'lock commits.',
  );
}

function applyPragmas(driver: SqlDriver, busyTimeoutMs: number, onDisk: boolean): void {
  // Keep busy_timeout first AND the WAL conversion bounded-retried, so that a fresh-file
  // delete→WAL conversion racing another opener is waited out rather than failing connect() on
  // the first attempt: SQLite does NOT consult the busy handler for a journal-mode change, so it
  // returns SQLITE_BUSY immediately even with a timeout set.
  driver.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  let contention: unknown;
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
        contention = e;
        break;
      }
      // Synchronous few-ms backoff (openDriver is sync): Atomics.wait on a throwaway buffer.
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, 5 + i); // ~5–25 ms, monotonically backing off
    }
  }
  // A memory store has no journal to keep and no disk to lose; neither pragma below applies.
  if (!onDisk) return;
  // Keep the read-back as the gate — not which branch left the loop, and not the absence of an
  // exception (SQLite answers a journal-mode change it cannot honour with the mode it kept) — so
  // that `synchronous = NORMAL`, a WAL-mode bargain, is never left on a connection running a
  // rollback journal, where it trades the store's integrity rather than its last transactions.
  const mode = journalMode(driver);
  if (mode !== 'wal') throw walUnreachable(mode, contention);
  driver.exec('PRAGMA synchronous = NORMAL');
}
