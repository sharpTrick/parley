import { AckPolicy, ConsumerEvents, DeliverPolicy } from 'nats';
import type { ConsumerConfig, ConsumerMessages, JetStreamManager } from 'nats';

const INACTIVE_NS = 30_000_000_000; // 30s ephemeral-consumer cleanup
export const DRAIN_TIMEOUT_MS = 2000;
const FETCH_EXPIRY_MS = 2000;
const FETCH_EXPIRY_CEILING_MS = 30_000;
const FETCH_IDLE_MS = 200; // close a pull this long without a message rather than wait out `expires`
const LINK_PATIENCE_FACTOR = 3;

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long ONE pull waits, scaled by what its own setup round trips just cost. Keep the scaling: a
 * constant idle close is armed before the first message can arrive (nats.js `fetch()` resolves as
 * soon as the pull is queued locally), so on any link slower than the constant it closes the pull
 * having read nothing and catch-up returns an empty page with a cursor that never advances.
 */
export const pullPatience = (setupMs: number): { expires: number; idleMs: number } => {
  const scaled = setupMs * LINK_PATIENCE_FACTOR;
  const expires = Math.min(Math.max(FETCH_EXPIRY_MS, scaled), FETCH_EXPIRY_CEILING_MS);
  return { expires, idleMs: Math.min(Math.max(FETCH_IDLE_MS, scaled), expires) };
};

/** The consumer every read and the live loop opens: one subject, from one sequence, unacked. */
export const fromSequence = (subject: string, startSeq: number): Partial<ConsumerConfig> => ({
  filter_subject: subject,
  deliver_policy: DeliverPolicy.StartSequence,
  opt_start_seq: startSeq,
  ack_policy: AckPolicy.None,
  inactive_threshold: INACTIVE_NS,
});

/** Anything the teardown registry can shut down: a live pull, a consume() iterator, a shim. */
export interface Closeable {
  close: () => unknown;
}

/**
 * One ephemeral consumer, deleted exactly once by whichever racer reaches it first: the call that
 * created it, or a `disconnect()` that landed inside its creation round trip. Keep {@link reap}
 * waiting on the in-flight `consumers.add`, so that a teardown arriving before the server has named
 * the consumer still deletes it — a name that arrives after teardown has dropped the link has
 * nothing left to delete it, and the orphan lingers for `inactive_threshold`.
 */
export class EphemeralConsumer {
  name?: string;
  private adding: Promise<unknown> = Promise.resolve();
  private reaped = false;

  constructor(
    private readonly jsm: JetStreamManager,
    private readonly stream: string,
  ) {}

  /**
   * Keep the request and the record of it in ONE synchronous step: a teardown can only interleave at
   * an await, so nothing can observe a consumer being created with no reaper watching for its name.
   */
  add(config: Partial<ConsumerConfig>): Promise<string> {
    const added = this.jsm.consumers.add(this.stream, config).then((ci) => {
      this.name = ci.name;
      return ci.name;
    });
    this.adding = added.catch(() => undefined);
    return added;
  }

  async reap(): Promise<void> {
    await Promise.race([this.adding, delay(DRAIN_TIMEOUT_MS)]);
    if (this.reaped || this.name === undefined) return;
    this.reaped = true;
    await this.jsm.consumers.delete(this.stream, this.name).catch(() => undefined);
  }
}

/**
 * Settles when the server says this consumer is gone, having closed `iter` — which is what ends the
 * message loop reading it. A plain named ephemeral consumer is GC'd after `INACTIVE_NS` of client
 * absence and `consume()` does not self-heal, so without this watcher the loop waits on a consumer
 * that no longer exists.
 */
export async function closeOnConsumerLoss(iter: ConsumerMessages): Promise<void> {
  try {
    for await (const s of await iter.status()) {
      if (
        s.type === ConsumerEvents.ConsumerDeleted ||
        s.type === ConsumerEvents.ConsumerNotFound ||
        s.type === ConsumerEvents.StreamNotFound
      ) {
        await iter.close();
        break;
      }
    }
  } catch {
    /* status iterator closed */
  }
}

/** JetStream's answer when a sequence holds nothing, as opposed to a read that could not be made. */
export function isMessageMissing(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === '404') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /no message found|message not found|404/i.test(msg);
}

/** A stream that vanished out-of-band: JetStream 404s the manager and 503s the publish. */
export function isStreamMissing(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === '503') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /stream not found|no responders|503/i.test(msg);
}
