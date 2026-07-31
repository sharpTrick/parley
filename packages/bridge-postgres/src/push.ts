import type { MessageHandler, Topic } from '@sharptrick/parley-core';
import { rowToMessage } from './read.js';
import { PluginState } from './state.js';

/** How many rows one drain query pulls at most before re-querying. */
const DRAIN_BATCH = 512;
/** First gap before a failed drain is retried; doubles per consecutive failure. */
const DRAIN_RETRY_BASE_MS = 50;
/**
 * Ceiling on the re-drain gap, so a database that stays down is re-probed forever but cheaply.
 * Keep the retry unbounded in COUNT, so that push converges the way catch-up does: NOTIFY is
 * edge-triggered, and a drain that gave up holds `lastSeen` behind a durably stored row.
 */
const DRAIN_RETRY_CEILING_MS = 30_000;

export interface TopicSubscription {
  topic: Topic;
  /**
   * Every handler subscribed to this NOTIFY channel; a repeat `subscribe(topic, …)` appends, so a
   * second subscribe doesn't silently replace the first. The channel is drained once per
   * notification and fanned out, so the `lastSeen`/coalescing bookkeeping stays shared per channel.
   */
  handlers: MessageHandler[];
  /** Highest seq already delivered (as text — BIGINT round-trips as a string). */
  lastSeen: string;
  /** In-flight guard: at most one drain loop per topic at a time. */
  draining: boolean;
  /** A notification arrived mid-drain — run the drain once more before going idle. */
  pending: boolean;
  /** Armed backoff re-drain after a failed drain read; cleared once one succeeds. */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Gap the next re-drain will use — doubles per consecutive failure, reset by a success. */
  retryDelayMs?: number;
}

/** Fan-out of a drained topic to its handlers, and the backoff that re-drains a failed read. */
export abstract class PostgresPush extends PluginState {
  /**
   * Drain everything after `lastSeen` for one topic, in ascending seq order. At most one drain
   * runs per topic (`draining` flag); a notification landing mid-drain sets `pending` so the
   * loop runs once more instead of racing a second drain past the first.
   */
  protected drain(sub: TopicSubscription): void {
    if (sub.draining) {
      sub.pending = true;
      return;
    }
    sub.draining = true;
    this.clearRedrain(sub);
    const epoch = this.epoch;
    void (async () => {
      try {
        do {
          sub.pending = false;
          for (;;) {
            if (this.stopped || epoch !== this.epoch) return;
            const rows = await this.readSince(sub.topic, sub.lastSeen, DRAIN_BATCH);
            // `pool.end()` waits for this read, so a teardown that began while it was in flight is
            // only observable HERE. Keep the re-check, so that a subscription `disconnect()` has
            // already dropped cannot deliver one last batch into a handler on its way out.
            if (this.stopped || epoch !== this.epoch) return;
            if (rows.length === 0) break;
            for (const row of rows) {
              sub.lastSeen = String(row.seq);
              const msg = rowToMessage(row);
              // Keep each handler in its own try/catch, so that one throwing handler cannot starve
              // the others on this channel (DESIGN §6).
              for (const handler of sub.handlers) {
                try {
                  handler(msg);
                } catch {}
              }
            }
          }
        } while (sub.pending && !this.stopped && epoch === this.epoch);
        sub.retryDelayMs = undefined;
      } catch {
        this.scheduleRedrain(sub, epoch);
      } finally {
        sub.draining = false;
      }
    })();
  }

  /**
   * Re-arm a failed drain on a doubling backoff. A NOTIFY is an EDGE: the drain that swallowed the
   * failure leaves `lastSeen` behind a durably stored row with nothing guaranteed to ring the
   * doorbell again. Keep the arming epoch-guarded, so that a drain read rejecting after
   * `disconnect()` cannot install a timer that outlives the lifecycle.
   */
  private scheduleRedrain(sub: TopicSubscription, epoch: number): void {
    if (this.stopped || epoch !== this.epoch || sub.retryTimer !== undefined) return;
    const delayMs = sub.retryDelayMs ?? DRAIN_RETRY_BASE_MS;
    sub.retryDelayMs = Math.min(delayMs * 2, DRAIN_RETRY_CEILING_MS);
    // Keep the unref, so a database that stays down cannot by itself pin the event loop — push is
    // best-effort over a durable cursor, not a reason to keep the process alive.
    sub.retryTimer = setTimeout(() => {
      sub.retryTimer = undefined;
      this.drain(sub);
    }, delayMs).unref();
  }

  protected clearRedrain(sub: TopicSubscription): void {
    clearTimeout(sub.retryTimer);
    sub.retryTimer = undefined;
  }
}
