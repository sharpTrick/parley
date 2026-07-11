import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';

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
 * Load the native module once (memoized). BUG-36: distinguish "not installed / no prebuilt" —
 * where the node:sqlite fallback is legitimate — from a real load error, which must surface.
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
 * permissions, corrupt file) surfaces better-sqlite3's own precise message instead (BUG-36). The
 * plugin code above is driver-agnostic.
 */
export function openDriver(path: string, opts: OpenOptions = {}): SqlDriver {
  const busy = opts.busyTimeoutMs ?? 5000;
  const Better = loadBetterSqlite();
  let driver: SqlDriver;
  if (Better !== null) {
    // Construct OUTSIDE any try/catch: a bad path / permissions / corrupt file throws its OWN
    // actionable message rather than being swallowed and replaced by node:sqlite's vaguer one.
    driver = wrap('better-sqlite3', new Better(path));
  } else {
    try {
      const mod = require('node:sqlite') as { DatabaseSync: new (p: string) => RawDb };
      driver = wrap('node:sqlite', new mod.DatabaseSync(path));
    } catch (e) {
      // The native module was absent AND the builtin fallback also failed → surface the fallback
      // failure WITH the original error attached as `cause`, not in place of it.
      process.stderr.write(
        'parley-sqlite: better-sqlite3 unavailable; node:sqlite fallback failed\n',
      );
      throw new Error(`node:sqlite fallback failed opening ${path}`, { cause: e });
    }
  }
  // BUG-35: set busy_timeout FIRST so any later contention retries, THEN bounded-retry the WAL
  // conversion. SQLite does NOT consult the busy handler for a journal-mode change, so a plain
  // reorder is insufficient — a fresh-file delete→WAL conversion racing another opener returns
  // SQLITE_BUSY immediately even with a timeout set.
  driver.exec(`PRAGMA busy_timeout = ${busy}`);
  for (let i = 0; ; i++) {
    try {
      // WAL: readers don't block the single writer; multiple processes can post concurrently.
      driver.exec('PRAGMA journal_mode = WAL');
      break;
    } catch (e) {
      if (i >= 20) {
        // WAL is persistent; the conversion race only exists until the file is first converted.
        // Degrade rather than crash connect(): the default journal mode is still correct.
        process.stderr.write(
          `parley-sqlite: WAL conversion still busy after ${i} retries; ` +
            `continuing in default journal mode: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        break;
      }
      // Synchronous few-ms backoff (openDriver is sync): Atomics.wait on a throwaway buffer.
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, 5 + i); // ~5–25 ms, monotonically backing off
    }
  }
  driver.exec('PRAGMA synchronous = NORMAL');
  // SEC-16: SQLite creates the DB (and, since journal_mode = WAL above, its -wal/-shm sidecars)
  // at the umask default — typically 0644, world-readable — and neither driver exposes a mode
  // option, so chmod them to 0600 after open. Skip in-memory paths; the sidecars may not exist
  // yet (e.g. before the first write), so guard each chmod individually.
  if (path !== ':memory:' && !path.startsWith('file::memory:')) {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best-effort: file may be on a mode-less FS */
    }
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(sidecar, 0o600);
      } catch {
        /* not created yet / absent — ignore */
      }
    }
  }
  return driver;
}
