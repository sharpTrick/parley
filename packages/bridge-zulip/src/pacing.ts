import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';

/** Backoff bounds for a failing push loop, and how often a persistent failure is reported. */
const LOOP_BACKOFF_MIN_MS = 200;
const LOOP_BACKOFF_MAX_MS = 5000;
const LOOP_FAILURES_BEFORE_REPORT = 3;
const LOOP_FAILURE_REPORT_INTERVAL = 20;

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
export const longPollDeadlineMs = (eventsTimeoutMs: number): number =>
  eventsTimeoutMs + DEFAULT_DEADLINE_MS;

