import type { MessageHandler, Topic } from '@sharptrick/parley-core';
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

/**
 * Live state of one topic's poll loop. `degraded` means the loop is still probing on a backed-off
 * interval and will self-heal; `stopped` means it will never deliver again without a reconnect.
 */
export type SubscriptionState = 'live' | 'degraded' | 'stopped';

export interface SubscriptionHealth {
  topic: Topic;
  state: SubscriptionState;
  consecutiveFailures: number;
  lastError?: string;
}

/** One poll loop per subscribed topic, and the health an operator reads them through. */
export abstract class SqlitePoller extends SqliteRetention {
  protected readonly cancellers: Array<() => void> = [];
  protected readonly health: SubscriptionHealth[] = [];

  /**
   * Live path = a per-topic poll loop (DESIGN §9, polling-only). `SELECT WHERE id > :lastSeen ASC`
   * per tick, advancing `lastSeen`. `disconnect()` cancels the loop. The cursor guarantees nothing
   * is missed regardless of cadence.
   *
   * It starts where this topic's catch-up handed off, not at the current max rowid: core runs
   * catch-up to completion and arms `subscribe` later, so a start point sampled here would skip
   * everything a peer committed in between — below the sampled mark, above the read position
   * catch-up persisted, and therefore owned by neither path. Sampling is right only for a topic
   * catch-up never read — or one whose hand-off point aged out of {@link CATCHUP_LEDGER_MAX}: its
   * rows are history the live path has never owned.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const storeId = this.require(this.storeId);
    let lastSeen: number | bigint = this.caughtUpThrough.get(topic) ?? this.maxId(topic);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let diagQuietUntil = 0;
    const health: SubscriptionHealth = { topic, state: 'live', consecutiveFailures: 0 };
    this.health.push(health);

    const tick = (): void => {
      if (this.tornDown()) return;
      let delay = this.pollIntervalMs;
      try {
        const stmt = this.require(this.selectAfterStmt);
        const rows = stmt.all(topic, lastSeen, POLL_BATCH) as MessageRow[];
        for (const row of rows) {
          // Keep these re-checks around EVERY handler call, so that a handler which tears the
          // plugin down re-entrantly stops the loop at that row: the rest of the batch is already
          // in memory, and the bookkeeping below would report a torn-down loop as live.
          if (this.tornDown()) return;
          lastSeen = row.id;
          try {
            handler(rowToMessage(row, storeId));
          } catch {
            // Handler is best-effort (DESIGN §6); never let it break the poll loop.
          }
        }
        if (this.tornDown()) return;
        // Keep the immediate reschedule on a full batch, so that POLL_BATCH bounds per-tick work
        // rather than capping throughput at one batch per poll interval.
        if (rows.length === POLL_BATCH) delay = 0;
        failures = 0;
        diagQuietUntil = 0;
        health.state = 'live';
        health.consecutiveFailures = 0;
        health.lastError = undefined;
      } catch (e) {
        const cls = classifyDbError(e);
        // Keep a lock-classed tick counted like every other failure — quiet only on stderr — so
        // that a loop failing 100% of its reads on contention cannot report `live` forever: WAL +
        // busy_timeout make lock the one class not worth a line, not a tick that read anything.
        failures++;
        health.consecutiveFailures = failures;
        health.lastError = errMessage(e);
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
            health.state = 'stopped';
            process.stderr.write(
              `parley-sqlite: poll loop for topic "${topic}" stopped after ${failures} ` +
                `consecutive unrecoverable failures; live push is down for this topic\n`,
            );
            return; // do NOT reschedule
          }
          // Keep probing here, however long it takes: subscribe()'s promise has already
          // resolved and core has no other signal, so stopping is silent, permanent loss of
          // live push for a topic whose DB was only temporarily unreachable.
          health.state = 'degraded';
          delay = backoffMs(this.pollIntervalMs, failures);
        }
      }
      if (!this.stopped) timer = setTimeout(tick, delay);
    };

    this.cancellers.push(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    tick();
  }

  /**
   * Programmatic view of every poll loop this plugin has started — the path an operator or a
   * health check reads, since stderr is routinely discarded by an MCP stdio host.
   */
  subscriptionHealth(topic?: Topic): SubscriptionHealth[] {
    const all = this.health.map((h) => ({ ...h }));
    return topic === undefined ? all : all.filter((h) => h.topic === topic);
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
