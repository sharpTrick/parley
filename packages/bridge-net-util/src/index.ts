/**
 * `@sharptrick/parley-net-util` — shared network and timing helpers for the backends that wait or
 * speak HTTP. Deliberately NOT part of `bridge-core`: core stays a dependency-free seam, so the
 * plugins that need an HTTP retry loop share one here instead. Each plugin keeps its own
 * auth-header building, body encoding, and per-API `Retry-After` body field, and delegates the
 * loop and its bounds to this module.
 *
 * Lockstep-published: semantic-release publishes this alongside every other Parley package — never
 * hand-version it.
 */

import { fetchOnce } from './attempt.js';
import { HttpStatusError, LabelledError } from './errors.js';
import { errorBody } from './redact.js';
import { retryAfterFromHeader, usableHint } from './retry-after.js';
import { sleepUnlessStopped } from './timing.js';

export { HttpStatusError, statusOf } from './errors.js';
export { isLoopbackHost, plaintextRemoteOrigin } from './plaintext.js';
export { MAX_ERROR_BODY, sanitizeBody } from './redact.js';
export { retryAfterFromHeader } from './retry-after.js';
export { delay, STOP_POLL_MS } from './timing.js';

/** Wait applied when a 429 carries no usable hint. */
export const DEFAULT_BACKOFF_MS = 500;
/** Ceiling on a backoff we invented ourselves. A server-stated hint is honoured past it. */
export const MAX_BACKOFF_MS = 5_000;
/** Attempts a single call will make before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 8;
/** Wall-clock ceiling on a single call, kept under `catchup.block_max_ms` (DESIGN §11). */
export const DEFAULT_DEADLINE_MS = 30_000;
/**
 * Default ceiling on the bytes a single response may put in memory. The body of a response the
 * caller never sees is bounded far tighter than this — see {@link fetchWithRetry}.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Normalize a backoff a PLUGIN chose itself (a reconnect ladder, a poll interval) into
 * `[DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS]`. `Number(null)` and `Number('')` are both `0`, so an
 * unchecked parse reads as "retry now"; the floor turns that — and every other figure under it —
 * into a wait, so a ladder built on a misparsed hint cannot hot-spin.
 *
 * It does NOT bound a wait the server asked for, and {@link fetchWithRetry} deliberately does not
 * put it on a stated hint: see there.
 */
export function clampBackoff(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_BACKOFF_MS;
  return Math.min(Math.max(ms, DEFAULT_BACKOFF_MS), MAX_BACKOFF_MS);
}

export interface FetchWithRetryOptions {
  /** Error-message prefix, e.g. `Slack chat.postMessage` or `Matrix GET /sync`. */
  label: string;
  /** True once the plugin has disconnected — stop retrying, throw instead of looping. */
  isStopped: () => boolean;
  /**
   * Per-backend `Retry-After` extraction → milliseconds, or undefined when the response carries no
   * usable hint. Only the body field differs between APIs; the header, the clamp and the default
   * are handled here. Receives the 429 `Response` (clone it before reading the body) — a body the
   * caller never sees, so it is bounded to a few KB rather than to `maxBodyBytes`.
   *
   * A source of an ADDITIONAL hint, never a ceiling: the standard `Retry-After` header is a FLOOR
   * this cannot lower. Do not clamp what you return here, so that a parser bug cannot retry sooner
   * than the vendor asked — that is what escalates a rate limit into a ban.
   */
  retryAfterOf?: (res: Response) => Promise<number | undefined> | number | undefined;
  /** Non-2xx statuses the caller treats as expected (returned, not thrown). Default: none. */
  allowStatuses?: number[];
  /** Attempts before giving up. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /**
   * Wall-clock budget for the whole call, INCLUDING the time a single request spends in flight.
   * A caller whose request legitimately blocks longer than {@link DEFAULT_DEADLINE_MS} (a
   * long-poll) must raise this, so that its own request is not aborted at the default.
   */
  deadlineMs?: number;
  /**
   * Ceiling on the bytes ONE response the caller will read may put in memory. Default
   * {@link MAX_RESPONSE_BYTES}; past it the call fails with `<label> → body: …` rather than handing
   * back a truncated body a `res.json()` would misparse. A response that can only become an error
   * message is bounded far tighter and never fails on size.
   */
  maxBodyBytes?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * The caller's own `Retry-After` parser, whose failure is not this call's failure. A hook that reads
 * the body — `res.clone().json()` against an HTML 429 page from a CDN — throws, and an unguarded
 * hook throws THAT out of the loop: unlabeled, unredacted, and carrying no status for a caller to
 * branch on. Keep the catch, so that a parser which cannot read the body means "no usable hint"
 * rather than an error outside the envelope; the header floor is computed independently of it.
 */
async function callerHint(
  parse: FetchWithRetryOptions['retryAfterOf'],
  res: Response,
): Promise<number | undefined> {
  try {
    return await parse?.(res);
  } catch {
    return undefined;
  }
}

/**
 * Shared HTTP-with-429-retry loop. Builds nothing itself — the caller passes a fully-formed `init`
 * (auth headers + encoded body + optional `signal`). Retries 429 within a bounded attempt and
 * wall-clock budget, abandons a backoff within {@link STOP_POLL_MS} of `isStopped()` turning true,
 * returns the `Response` on ok / allowStatuses, else throws `<label> → <status>: <body>`. A server
 * asking for a longer wait than this call's deadline ends the call rather than being retried sooner
 * than it asked. The returned `Response` is already buffered — bounded by `maxBodyBytes` — so
 * reading it cannot fail on the deadline. Backend response *shapes* (Slack's `ok:false`, XMPP IQ)
 * are NOT unified here — interpret those in the caller.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const attemptOpts = {
    label: opts.label,
    maxBytes: opts.maxBodyBytes ?? MAX_RESPONSE_BYTES,
    keeps: (res: Response): boolean =>
      res.ok || (opts.allowStatuses?.includes(res.status) ?? false),
  };

  let received: number | undefined;
  for (let attempt = 1; ; attempt++) {
    const budget = deadlineMs - (now() - started);
    if (budget <= 0) {
      throw new LabelledError(
        `${opts.label} → deadline: exceeded ${deadlineMs}ms before attempt ${attempt}`,
        received,
      );
    }

    const res = await fetchOnce(url, init, budget, attemptOpts);
    received = res.status;
    if (opts.allowStatuses?.includes(res.status) ?? false) return res;
    if (res.status !== 429) {
      if (res.ok) return res;
      throw new HttpStatusError(opts.label, res.status, await errorBody(res, url));
    }

    if (opts.isStopped()) throw new LabelledError(`${opts.label} → 429 (disconnected)`, 429);

    // Honour a server-stated wait IN FULL, so that we never retry sooner than the vendor asked —
    // that is what escalates a rate limit into a ban. The header is a FLOOR the caller's parser
    // cannot lower, and an unreasonable hint is refused by the deadline below, not shortened.
    const header = usableHint(retryAfterFromHeader(res));
    const parsed = usableHint(await callerHint(opts.retryAfterOf, res));
    const hinted = header === undefined ? parsed : Math.max(header, parsed ?? 0);
    const stated = hinted !== undefined;
    const wait = hinted ?? DEFAULT_BACKOFF_MS;
    const elapsed = now() - started;
    const overDeadline = elapsed + wait > deadlineMs;
    if (attempt >= maxAttempts || overDeadline) {
      throw new HttpStatusError(
        opts.label,
        429,
        stated && overDeadline
          ? `upstream asked for ${Math.round(wait)}ms, past this call's ${deadlineMs}ms deadline ` +
            `(${elapsed}ms elapsed). Raise deadlineMs to wait it out.`
          : `still rate limited after ${attempt} attempts (${elapsed}ms)`,
      );
    }

    const waitedItOut = await sleepUnlessStopped(wait, opts.isStopped);
    if (!waitedItOut || opts.isStopped()) {
      throw new LabelledError(`${opts.label} → 429 (disconnected)`, 429);
    }
  }
}
