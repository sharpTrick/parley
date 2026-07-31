import type { Topic } from '@sharptrick/parley-core';

/** Ceiling on the subscribe loop's retry backoff — a dead homeserver still gets re-probed. */
const SYNC_RETRY_MAX_MS = 30_000;

/**
 * Exponential backoff for a failing `/sync`, so a PERMANENT failure (revoked token → 401, kicked
 * from the room → 403) degrades to a slow probe instead of hammering the homeserver forever.
 */
export const syncRetryDelayMs = (consecutiveFailures: number): number =>
  Math.min(200 * 2 ** (consecutiveFailures - 1), SYNC_RETRY_MAX_MS);

/**
 * A permanently broken live path is otherwise invisible to the operator, who sees only homeserver
 * load. Rate-limited to powers of two so a long outage cannot itself become the flood.
 */
export function reportSyncFailure(topic: Topic, consecutiveFailures: number, err: unknown): void {
  if ((consecutiveFailures & (consecutiveFailures - 1)) !== 0) return;
  // Drop the query string: a `/sync` URL carries the whole JSON room filter, which buries the
  // status and error body an operator actually needs under a screenful of percent-encoding.
  const detail = (err instanceof Error ? err.message : String(err)).replace(/\?\S*?(?= →|$)/, '');
  console.error(
    `[parley-matrix] /sync failed for topic ${JSON.stringify(String(topic))} ` +
      `(${consecutiveFailures} consecutive; retrying in ${syncRetryDelayMs(consecutiveFailures)}ms): ${detail}`,
  );
}

/**
 * A `/sync` loop ended on something its retry ladder did not contain: live delivery for this topic
 * is gone until the next `subscribe`, and only `fetchRecent` catch-up still reads it.
 */
export function reportLoopCrash(topic: Topic, err: unknown): void {
  console.error(
    `[parley-matrix] the /sync loop for topic ${JSON.stringify(String(topic))} ended on an ` +
      `unexpected error; live delivery for it has stopped: ` +
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
}
