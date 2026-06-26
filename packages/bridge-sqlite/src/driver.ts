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

function openBetterSqlite(path: string): SqlDriver {
  const Database = require('better-sqlite3') as new (p: string) => RawDb;
  return wrap('better-sqlite3', new Database(path));
}

function openNodeSqlite(path: string): SqlDriver {
  const mod = require('node:sqlite') as { DatabaseSync: new (p: string) => RawDb };
  return wrap('node:sqlite', new mod.DatabaseSync(path));
}

/**
 * Open a SQLite database with WAL + busy_timeout. Prefers the mature native driver
 * (better-sqlite3); falls back to Node's built-in `node:sqlite` if the native module fails
 * to load (e.g. no prebuilt for this ABI and no toolchain). The plugin code above is
 * driver-agnostic.
 */
export function openDriver(path: string, opts: OpenOptions = {}): SqlDriver {
  const busy = opts.busyTimeoutMs ?? 5000;
  let driver: SqlDriver;
  try {
    driver = openBetterSqlite(path);
  } catch {
    driver = openNodeSqlite(path);
  }
  // WAL: readers don't block the single writer; multiple processes can post concurrently.
  driver.exec('PRAGMA journal_mode = WAL');
  // busy_timeout: a concurrent post from another instance retries instead of erroring (DESIGN §9/§10).
  driver.exec(`PRAGMA busy_timeout = ${busy}`);
  driver.exec('PRAGMA synchronous = NORMAL');
  return driver;
}
