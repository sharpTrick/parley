import type { SqlDriver, SqlStatement } from './driver.js';
import { SQL } from './schema.js';

export type PreparedStatements = { [K in keyof typeof SQL as `${K}Stmt`]?: SqlStatement };

/**
 * Prepare — or, given no driver, clear — every statement in {@link SQL}, keyed by the field that
 * holds it. Keep both sides deriving from THAT one map, so that a statement added to it cannot be
 * prepared at connect and then left behind by `disconnect()`, where the next call would run it
 * against a closed driver.
 */
export function prepareAll(driver?: SqlDriver): PreparedStatements {
  return Object.fromEntries(
    Object.entries(SQL).map(([name, sql]) => [`${name}Stmt`, driver?.prepare(sql)]),
  ) as PreparedStatements;
}

/** The open handle, the statements prepared against it, and the not-connected guard. */
export abstract class SqliteStore {
  protected driver?: SqlDriver;
  protected pollIntervalMs = 1000;
  protected stopped = false;
  protected storeId?: string;
  protected insertStmt?: SqlStatement;
  protected selectAfterStmt?: SqlStatement;
  protected selectRecentStmt?: SqlStatement;
  protected maxIdStmt?: SqlStatement;
  protected pruneStmt?: SqlStatement;
  protected seqStmt?: SqlStatement;

  protected tornDown(): boolean {
    return this.stopped || this.driver === undefined;
  }

  protected require<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('SqlitePlugin not connected — call connect() first');
    return value;
  }
}
