import type { Topic } from '@sharptrick/parley-core';

/** Ceiling on the subscribe loop's retry backoff — a dead homeserver still gets re-probed. */
const SYNC_RETRY_MAX_MS = 30_000;

/**
 * Exponential backoff for a failing `/sync`, so a PERMANENT failure (revoked token → 401, removed
 * from the room → a 200 listing it under `rooms.leave`, homeserver fault → 5xx) degrades to a slow
 * probe instead of hammering the homeserver forever.
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

/**
 * A `/sync` that answers 200 while listing the subscribed room as one this account is no longer in
 * — the shape a kick or a ban actually takes, which no HTTP status ever reports. Raised INTO the
 * loop's own ladder rather than written straight to stderr, so it is throttled and backed off like
 * every other permanent failure instead of costing a line per long-poll.
 */
export const membershipLost = (roomId: string, membership: string): Error =>
  new Error(
    `/sync no longer lists ${roomId} as joined (membership: ${membership}): this account was ` +
      'removed from the room, so nothing more will be delivered live from it. Re-invite the ' +
      'account (an `m.room.member` of `ban` must be lifted first) and reconnect the bridge.',
  );
