import type {
  BackendConfig, BackendIdentity, BackendPlugin, Handle,
} from '@sharptrick/parley-core';
import { PRUNE_INTERVAL_MS, validateBackendConfig } from './config.js';
import { readOrMintStoreId } from './cursor.js';
import { openDriver } from './driver.js';
import { SqlitePoller } from './poll.js';
import { SCHEMA } from './schema.js';
import { type PreparedStatements, prepareAll } from './store.js';

export { classifyDbError, type DbErrorClass } from './classify.js';
export {
  CATCHUP_LEDGER_MAX, ESCALATE_AFTER, MAX_PAGE, MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS,
  MIN_RETENTION_DAYS, POLL_BATCH, PRUNE_BATCH, PRUNE_INTERVAL_MS, retentionCutoff,
  type SqliteBackendConfig, validateBackendConfig,
} from './config.js';
export { backoffMs, type SubscriptionHealth, type SubscriptionState } from './poll.js';

/**
 * The SQLite backend (DESIGN §9). Zero-infra, **polling-only** — no socket, no notify bus,
 * no broker. The cursor (`<storeId>.<rowid>`) makes polling fully correct, so the poll interval
 * is a pure latency/cost knob. WAL + busy_timeout (in {@link openDriver}) make concurrent
 * multi-process posts safe (§9/§10).
 */
export class SqlitePlugin extends SqlitePoller implements BackendPlugin {
  async connect(config: BackendConfig): Promise<void> {
    if (this.driver !== undefined) {
      throw new Error(
        'parley-sqlite: already connected — call disconnect() before connecting again ' +
          '(a second connect() would orphan every running poll loop against the previous store)',
      );
    }
    const cfg = validateBackendConfig(config);
    const dbPath = cfg.db_path ?? 'parley.db';

    const driver = openDriver(dbPath, {});
    let prepared: PreparedStatements;
    let storeId: string;
    try {
      driver.exec(SCHEMA);
      prepared = prepareAll(driver);
      storeId = readOrMintStoreId(driver, dbPath);
    } catch (e) {
      // Keep connect() all-or-nothing: close the handle and leave every field untouched, so that a
      // failed connect neither leaks a driver per attempt nor leaves an instance that answers
      // "already connected" to the next connect() and "not connected" to every operation.
      driver.close();
      throw e;
    }

    this.pollIntervalMs = cfg.poll_interval_ms ?? 1000;
    this.retentionDays = cfg.retention_days;
    this.stopped = false;
    // Keep the bump below every throw above it, so that a connect() that is refused — already
    // connected, or a store that failed after opening — cannot stop the loops an earlier connect()
    // armed and left healthy.
    this.generation++;
    this.health.length = 0;
    this.pruneFailures = 0;
    this.lastPruneDiag = 0;
    this.driver = driver;
    Object.assign(this, prepared);
    this.storeId = storeId;

    if (this.retentionDays !== undefined) {
      this.prune();
      // Keep the .unref(), so that a leaked-but-never-disconnect()ed plugin cannot by itself pin
      // the event loop — pruning is a best-effort cost knob, not a reason to keep the process
      // alive.
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    if (this.pruneBatchTimer !== undefined) clearTimeout(this.pruneBatchTimer);
    this.pruneBatchTimer = undefined;
    for (const cancel of this.cancellers) cancel();
    this.cancellers.length = 0;
    // Keep the hand-off points cleared with the driver, so that a reconnect onto a different or
    // reset store cannot resume a live loop at a rowid belonging to the previous one.
    this.caughtUpThrough.clear();
    for (const h of this.health) {
      h.state = 'stopped';
      h.lastError = 'disconnected';
    }
    this.driver?.close();
    this.driver = undefined;
    this.storeId = undefined;
    // Keep these cleared with the driver that prepared them, so that a call after teardown reports
    // require()'s "not connected" rather than the driver's "database connection is not open",
    // which names neither this plugin nor the lifecycle mistake behind it.
    Object.assign(this, prepareAll());
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    // Local backend: a handle is a name convention, not a provisioned account (DESIGN §4).
    return { handle, backendRef: handle };
  }
}
