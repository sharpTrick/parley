import { SqliteCatchUp } from './catchup.js';
import { classifyDbError, errMessage } from './classify.js';
import { DIAG_INTERVAL_MS, PRUNE_BATCH, retentionCutoff } from './config.js';

/** The retention window, enforced by a bounded delete that reschedules itself. */
export abstract class SqliteRetention extends SqliteCatchUp {
  protected retentionDays?: number;
  protected pruneTimer?: ReturnType<typeof setInterval>;
  protected pruneBatchTimer?: ReturnType<typeof setTimeout>;
  protected pruneFailures = 0;
  protected lastPruneDiag = 0;

  /**
   * Delete up to {@link PRUNE_BATCH} rows older than `retention_days`, rescheduling itself while
   * batches come back full. A lock retries on the next interval, quietly; any other failure is
   * reported, so a retention policy the process cannot enforce is never silent.
   */
  protected prune(): void {
    if (this.retentionDays === undefined || this.tornDown()) return;
    try {
      const cutoff = retentionCutoff(this.retentionDays);
      const info = this.require(this.pruneStmt).run(cutoff, PRUNE_BATCH);
      this.pruneFailures = 0;
      if (Number(info.changes) >= PRUNE_BATCH) {
        this.pruneBatchTimer = setTimeout(() => this.prune(), 0).unref();
      }
    } catch (e) {
      if (classifyDbError(e) === 'lock') return;
      this.pruneFailures++;
      const now = Date.now();
      if (now - this.lastPruneDiag > DIAG_INTERVAL_MS || this.pruneFailures === 1) {
        this.lastPruneDiag = now;
        process.stderr.write(
          `parley-sqlite: retention prune failed (#${this.pruneFailures}): ${errMessage(e)}\n`,
        );
      }
    }
  }
}
