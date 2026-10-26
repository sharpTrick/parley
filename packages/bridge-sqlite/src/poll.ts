import { type MessageHandler, safeDeliver, type Topic } from '@sharptrick/parley-core';
import { classifyDbError, errMessage } from './classify.js';
import { DIAG_INTERVAL_MS, ESCALATE_AFTER, POLL_BATCH } from './config.js';
import { rowToMessage } from './cursor.js';
import { SqliteRetention } from './retention.js';
import type { MessageRow } from './schema.js';

/**
 * Ceiling on the degraded poll interval, so a down DB is re-probed forever but cheaply. It bounds
 * recovery latency only for intervals below it; keep it from lowering the delay past the configured
 * interval, so that escalation cannot read a failing store MORE often than a healthy one.
 */
const BACKOFF_CEILING_MS = 30_000;

/** One poll loop per subscribed topic. */
export abstract class SqlitePoller extends SqliteRetention {
  protected readonly cancellers: Array<() => void> = [];

  /**
   * Live path = a per-topic poll loop (DESIGN §9, polling-only). `SELECT WHERE id > :lastSeen ASC`
   * per tick, advancing `lastSeen` from the topic's tail at the moment of the call. Every row above
   * that is delivered once, in rowid order; `disconnect()` cancels the loop.
   *
   * Push is a SUBSET of the post-subscribe tail (DESIGN §6), and the subset it drops here is the
   * start-up window: core runs catch-up to completion and arms `subscribe` afterwards, so a row a
   * peer commits in between is above the caller's persisted cursor and below this tail. It is
   * reached by the next `fetchRecent` resuming from that cursor, never by push.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const storeId = this.require(this.storeId);
    const generation = this.generation;
    let lastSeen: number | bigint = this.maxId(topic);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let diagQuietUntil = 0;

    const tick = (): void => {
      if (this.tornDown()) return;
      let delay = this.pollIntervalMs;
      try {
        const stmt = this.require(this.selectAfterStmt);
        const rows = stmt.all(topic, lastSeen, POLL_BATCH) as MessageRow[];
        for (const row of rows) {
          // Keep these re-checks around EVERY handler call, so that a handler which tears the
          // plugin down re-entrantly stops the loop at that row: the rest of the batch is already
          // in memory, and every row past teardown is delivered out of a store nobody reads.
          if (this.orphaned(generation)) return;
          lastSeen = row.id;
          safeDeliver(handler, () => rowToMessage(row, storeId));
        }
        // Keep this check, so that a loop torn down on the batch's final row does not re-arm:
        // `disconnect()` has already emptied the canceller list, so a timer installed past this
        // point answers to nothing and holds the event loop open for a whole poll interval. It is
        // the only guard on the reschedule — nothing between here and there can re-enter the
        // lifecycle.
        if (this.orphaned(generation)) return;
        // Keep the immediate reschedule on a full batch, so that POLL_BATCH bounds per-tick work
        // rather than capping throughput at one batch per poll interval.
        if (rows.length === POLL_BATCH) delay = 0;
        failures = 0;
        diagQuietUntil = 0;
      } catch (e) {
        const cls = classifyDbError(e);
        // Keep a lock-classed tick counted like every other failure — quiet only on stderr — so
        // that a loop failing 100% of its reads on contention cannot poll at full cadence forever:
        // WAL + busy_timeout make lock the one class not worth a line, not a tick that read
        // anything.
        failures++;
        if (cls !== 'lock') {
          const now = Date.now();
          if (now > diagQuietUntil) {
            diagQuietUntil = now + DIAG_INTERVAL_MS;
            process.stderr.write(
              `parley-sqlite: poll error on topic "${topic}" (#${failures}): ${errMessage(e)}\n`,
            );
          }
        }
        if (failures >= ESCALATE_AFTER) {
          if (cls === 'fatal') {
            process.stderr.write(
              `parley-sqlite: poll loop for topic "${topic}" stopped after ${failures} ` +
                `consecutive unrecoverable failures; live push is down for this topic\n`,
            );
            return; // do NOT reschedule
          }
          // Keep probing here, however long it takes: subscribe()'s promise has already
          // resolved, so stopping is permanent loss of live push for a topic whose DB was only
          // temporarily unreachable.
          delay = backoffMs(this.pollIntervalMs, failures);
        }
      }
      timer = setTimeout(tick, delay);
    };

    this.cancellers.push(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    tick();
  }
}

/**
 * Degraded poll delay after `failures` consecutive non-lock failures: exponential from the
 * configured interval, capped at {@link BACKOFF_CEILING_MS} or that interval, whichever is longer.
 * The cap is the README's promise that a topic whose store was briefly unreachable resumes live
 * push within 30 s, not within days — a promise that only means anything below the ceiling, since
 * an operator who configured a slower poll than 30 s already chose a longer dark window than the
 * cap could deliver. Backing off can only ever slow the loop down.
 */
export function backoffMs(pollIntervalMs: number, failures: number): number {
  const doublings = Math.min(failures - ESCALATE_AFTER + 1, 30);
  return Math.max(pollIntervalMs, Math.min(pollIntervalMs * 2 ** doublings, BACKOFF_CEILING_MS));
}
