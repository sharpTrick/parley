import type { Message, MessageHandler, Topic } from '@sharptrick/parley-core';
import { type RedisClient, serverRefusal } from './client.js';
import {
  errorText,
  reportLiveDeliveryDegraded,
  reportLiveDeliveryResumed,
  reportLiveDeliveryStopped,
} from './diagnostics.js';
import { type Entry, rowToMessage } from './entry.js';

/** First and largest wait between two failed reads. */
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 2000;
/**
 * Consecutive failed reads before the loop calls a fault it classified as transient SUSTAINED and
 * says so once. A fault that never in fact clears — a cluster redirect a non-cluster client cannot
 * follow, a replica stuck `LOADING` — otherwise leaves live delivery dead and completely silent.
 */
const DEGRADED_AFTER_FAILURES = 5;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hand one message to the handler, absorbing BOTH ways it can fail. Keep the throw arm, so that one
 * message a handler chokes on does not end live delivery for the topic behind a `subscribe()` that
 * already resolved — silently, since catch-up keeps working and nothing writes a line. Keep the
 * REJECTION arm too, so that an `async` handler — which the seam's `=> void` return type does not
 * forbid, and which core is free to pass — cannot take the whole bridge down with an unhandled
 * rejection on Node's default `--unhandled-rejections=throw`.
 */
function deliver(handler: MessageHandler, message: Message): void {
  try {
    void Promise.resolve(handler(message)).catch(() => undefined);
  } catch {
    /* the handler's failure is never the loop's */
  }
}

export interface ReadLoop {
  reader: RedisClient;
  topic: Topic;
  key: string;
  url: string;
  blockMs: number;
  /** The entry the first read starts strictly after. */
  from: string;
  /** False once a `disconnect()`/reconnect has superseded the connection this loop reads. */
  isCurrent: () => boolean;
  retire: () => Promise<void>;
}

/**
 * The live path: an `XREAD BLOCK` loop on a dedicated connection (DESIGN §9 — genuine events, not a
 * poll timer). A transient fault is retried on a bounded ladder; a refusal retires the reader; a
 * `disconnect()` tears that reader down, which breaks the blocking read.
 */
export async function runReadLoop(
  { reader, topic, key, url, blockMs, from, isCurrent, retire }: ReadLoop,
  handler: MessageHandler,
): Promise<void> {
  let lastId = from;
  let failures = 0;
  let degraded = false;
  while (isCurrent()) {
    let res: Array<{ name: string; messages: Entry[] }> | null;
    try {
      res = await reader.xRead({ key, id: lastId }, { BLOCK: blockMs, COUNT: 256 });
    } catch (err) {
      if (!isCurrent()) break; // torn down/superseded → exit, never spin-retry
      const respError = serverRefusal(err);
      if (respError !== undefined) {
        await retire();
        reportLiveDeliveryStopped(url, topic, respError);
        break;
      }
      failures++;
      if (failures === DEGRADED_AFTER_FAILURES) {
        degraded = true;
        reportLiveDeliveryDegraded(url, topic, failures, errorText(err));
      }
      await delay(Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS));
      continue;
    }
    if (!isCurrent()) break;
    if (degraded) reportLiveDeliveryResumed(url, topic, failures);
    degraded = false;
    failures = 0;
    if (res === null) continue; // BLOCK timed out with no new entries
    for (const stream of res) {
      for (const entry of stream.messages) {
        lastId = entry.id;
        deliver(handler, rowToMessage(topic, entry.id, entry.message));
      }
    }
  }
}
