import { buildMessage, type Cursor, type Message, type Topic } from '@sharptrick/parley-core';
import { keyOf, type ObservedStore, type StoredRecord } from './store.js';

/**
 * The observation sequence `since` names, or a loud failure. Keep the store identity in the
 * compare, so that a cursor from a store file this one did not inherit stays refusable: without it
 * the guard is only a high-water compare, which stops firing the moment a replacement store refills
 * past the held cursor, and catch-up then answers a permanently short page nothing can complete.
 *
 * `'0'` is accepted bare and unqualified: it sits below every sequence any store can stamp, so it
 * can only ever mean "from the beginning of what is retained".
 */
export function requireOwnCursor(
  store: ObservedStore,
  storePath: string,
  since: Cursor,
  topic: Topic,
): number {
  const raw = since as string;
  const named = `cursor '${raw}' for topic '${topic as string}'`;
  if (/^\d+$/.test(raw)) {
    if (Number(raw) === 0) return 0;
    // A bare non-zero sequence carries no store identity, so nothing can say WHICH store's
    // sequence space it names. Keep this off the foreign-cursor wording below, so that a
    // diagnostic an operator acts on cannot assert a provenance the cursor itself withholds.
    throw new Error(
      `TelegramPlugin: ${named} carries no store identity, ` +
        `so which observed-message store's observation sequence it names cannot be established ` +
        `(this one is '${storePath}', identity ${store.epoch()}). Serving it could answer out ` +
        `of an unrelated sequence space and leave the messages below it unreachable — clear the ` +
        `saved cursor to catch up from the start of what this store retains.`,
    );
  }
  const qualified = /^([0-9a-f]{16})\.(\d+)$/.exec(raw);
  if (qualified === null) {
    throw new Error(`TelegramPlugin: malformed cursor '${raw}' for topic '${topic as string}'`);
  }
  if (qualified[1] !== store.epoch()) {
    throw new Error(
      `TelegramPlugin: ${named} was issued by a different ` +
        `observed-message store (this one is '${storePath}', identity ${store.epoch()}). Its ` +
        `observation sequences are unrelated to that cursor's, so the messages it names are ` +
        `unreachable here — restore the store file that issued it, or clear the saved cursor.`,
    );
  }
  const seq = Number(qualified[2]);
  if (seq > store.highWater()) {
    throw new Error(
      `TelegramPlugin: ${named} is ` +
        `ahead of every message this store has observed (high-water ${store.highWater()}). The ` +
        `observed-message store at '${storePath}' has lost records it once held, so the ` +
        `messages it names are unreachable — restore that store file, or clear the saved cursor.`,
    );
  }
  return seq;
}

/**
 * The page size `fetchRecent` slices with: one normalization both its branches are driven from, and
 * a load-shaped failure for a number outside the domain that has.
 *
 * Keep the two branches on ONE normalized value, so that a limit cannot mean opposite things on
 * either side of `since`: `slice(-0)` is `slice(0)` — the whole retained window — so an
 * un-normalized non-positive limit inverts its own argument, and `NaN` inverts it the other way
 * (`slice(NaN)` is everything, `slice(0, NaN)` is nothing, i.e. a topic that looks permanently
 * drained). Refuse rather than substitute the default, so that a caller asking for a page size this
 * cannot answer hears about it instead of silently getting a different one.
 */
export function requireLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit)) {
    throw new Error(
      `TelegramPlugin: fetchRecent limit must be a finite number — got ${String(limit)}`,
    );
  }
  return Math.max(0, Math.floor(limit));
}

/** A stored record as a seam message, its cursor qualified by the store file that stamped it. */
export function recordToMessage(rec: StoredRecord, topic: Topic, epoch: string): Message {
  return buildMessage({
    topic,
    sender: rec.sender,
    content: rec.content,
    timestamp: rec.ts,
    id: keyOf(rec),
    cursor: `${epoch}.${rec.seq}`,
  });
}
