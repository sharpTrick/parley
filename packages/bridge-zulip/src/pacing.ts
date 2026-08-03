import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';

/** Backoff bounds for a failing push loop, and how often a persistent failure is reported. */
const LOOP_BACKOFF_MIN_MS = 200;
const LOOP_BACKOFF_MAX_MS = 5000;
const LOOP_FAILURES_BEFORE_REPORT = 3;
const LOOP_FAILURE_REPORT_INTERVAL = 20;

/**
 * Pace of a blocked `fetchRecent`'s retries while no live wake primitive is available, escalating
 * per failed attempt the way the push loop's backoff does. Keep the escalation, so that a server
 * answering every wake attempt at once — rejecting the queue, refusing to park — cannot turn one
 * caller's budget into hundreds of registrations against a backend already in trouble.
 */
const BLOCKED_FETCH_RETRY_MS = 400;
const BLOCKED_FETCH_RETRY_MAX_MS = 5000;

export const blockedFetchPause = (attempt: number): number =>
  Math.min(BLOCKED_FETCH_RETRY_MS * 2 ** attempt, BLOCKED_FETCH_RETRY_MAX_MS);

/** Escalating retry wait, so that a permanently dead push path is neither hot nor silent. */
export const loopBackoffMs = (consecutiveFailures: number): number =>
  Math.min(LOOP_BACKOFF_MIN_MS * 2 ** (consecutiveFailures - 1), LOOP_BACKOFF_MAX_MS);

/** Whether a run of failures this long is the one that goes to stderr. */
export const reportsLoopFailure = (consecutiveFailures: number): boolean =>
  consecutiveFailures === LOOP_FAILURES_BEFORE_REPORT ||
  consecutiveFailures % LOOP_FAILURE_REPORT_INTERVAL === 0;

/**
 * Wall-clock budget for a request the PUSH LOOP asks the server to park for. Keep the loop's
 * parking requests on this, so that the shared {@link DEFAULT_DEADLINE_MS} never severs a healthy
 * idle long-poll: an aborted-but-uncapped poll reads to the loop as a backend failure, and the whole
 * documented `events_timeout_ms` range above 30s would degrade into escalating backoff instead.
 */
export const longPollDeadlineMs = (blockMs: number): number =>
  Math.max(0, blockMs) + DEFAULT_DEADLINE_MS;

/** Wall-clock one request issued at the very end of a spent budget still gets to answer in. */
const REQUEST_ANSWER_MS = 500;

/**
 * Ceiling on a 429 backoff taken inside a caller's `blockMs`: what the caller has left, plus enough
 * for the last request of a spent budget to still be issued and answered. Keep the requests whose
 * own transport bound is an abort signal — the queue registration and the wake poll, both wrapped in
 * `deadlineAbort` — on this, so that a rate-limit hint reaching past that budget is refused outright:
 * the 429 backoff races only `isStopped()`, so no deadline signal can interrupt it and a routine
 * `Retry-After: 8` would otherwise spend eight seconds of a 300ms `fetchRecent`.
 */
export const budgetedDeadlineMs = (deadline: number): number =>
  Math.max(0, deadline - Date.now()) + REQUEST_ANSWER_MS;

/**
 * Wall-clock ONE history read gets to answer in. A caller's `blockMs` says how long it will wait for
 * a message to ARRIVE and says nothing about how long this server takes to answer a query, so it is
 * a floor under the read's transport deadline rather than the deadline itself — a
 * `fetchRecent(blockMs: 100)` against a Zulip whose `GET /api/v1/messages` takes 700ms must return
 * the empty page the seam requires at timeout, not reject at 600ms having never waited.
 *
 * Keep it SMALL: no abort signal bounds a history read (the mandatory first one has nothing to
 * abandon), so this is also the most a call can overrun the ceiling its caller set.
 */
export const REQUEST_DEADLINE_MS = 2000;

export const readDeadlineMs = (deadline: number): number =>
  Math.max(REQUEST_DEADLINE_MS, budgetedDeadlineMs(deadline));
