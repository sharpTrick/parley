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
 * How often a still-failing `/sync` may say so. The same interval bridge-sqlite's poll loop and
 * bridge-zulip's push loop report on, so an operator reading three backends' logs reads one shape.
 */
export const SYNC_DIAG_INTERVAL_MS = 60_000;

/**
 * A permanently broken live path is otherwise invisible to the operator, who sees only homeserver
 * load — and a report point that fires on powers of two of a COUNT reads as a throttle without
 * being one. {@link syncRetryDelayMs} is capped, so past the cap the interval between report
 * points grows linearly with the count forever: failure #1024 lands four hours in and #8192
 * thirty-four, so a path dead for three days says so at hour 34 and then goes quiet for another
 * day and a half. The count still names WHICH failure this is; the CLOCK decides when it is said.
 *
 * Stateful, and one per subscribe loop: the quiet window belongs to the path being reported on,
 * not to the module, so one dead topic cannot silence another.
 */
export const syncFailureReporter = (
  now: () => number = Date.now,
): ((topic: Topic, consecutiveFailures: number, err: unknown) => void) => {
  let quietUntil = -1;
  return (topic, consecutiveFailures, err) => {
    const at = now();
    if (at < quietUntil) return;
    quietUntil = at + SYNC_DIAG_INTERVAL_MS;
    // Drop the query string: a `/sync` URL carries the whole JSON room filter, which buries the
    // status and error body an operator actually needs under a screenful of percent-encoding.
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\?\S*?(?= →|$)/, '');
    console.error(
      `[parley-matrix] /sync failed for topic ${JSON.stringify(String(topic))} ` +
        `(${consecutiveFailures} consecutive; retrying in ${syncRetryDelayMs(consecutiveFailures)}ms): ${detail}`,
    );
  };
};

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
