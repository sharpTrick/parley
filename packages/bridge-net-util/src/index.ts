/**
 * `@sharptrick/parley-net-util` — shared network and timing helpers for the backends that wait or
 * speak HTTP. Deliberately NOT part of `bridge-core`: core stays a dependency-free seam, so the
 * plugins that need an HTTP retry loop share one here instead. Each plugin keeps its own
 * auth-header building, body encoding, and per-API `Retry-After` body field, and delegates the
 * loop, the bounds and the backoff clamp to this module.
 *
 * Lockstep-published: semantic-release publishes this alongside every other Parley package — never
 * hand-version it.
 */

/** `setTimeout` promise — the one copy that replaces the per-plugin `delay` duplicates. */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait applied when a 429 carries no usable hint. */
export const DEFAULT_BACKOFF_MS = 500;
/** Ceiling on any single backoff, however large a value the server sent. */
export const MAX_BACKOFF_MS = 5_000;
/** Attempts a single call will make before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 8;
/** Wall-clock ceiling on a single call, kept under `catchup.block_max_ms` (DESIGN §11). */
export const DEFAULT_DEADLINE_MS = 30_000;
/** Longest untrusted response body embedded in a thrown message. */
export const MAX_ERROR_BODY = 2_048;

/**
 * Normalize a backoff to `[DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS]`.
 *
 * `Number(null)` and `Number('')` are both `0`, so an absent `Retry-After` reads as "retry now" —
 * keep this clamp on the shared path, so that one plugin's parser bug cannot become a request
 * flood against the operator's own account.
 */
export function clampBackoff(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/** Milliseconds from a `Retry-After` header (seconds per RFC 9110), or undefined if unusable. */
export function retryAfterFromHeader(res: Response): number | undefined {
  const raw = Number(res.headers.get('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined;
}

/**
 * Bound and neutralize an untrusted response body before it goes in an Error.
 *
 * A thrown message becomes an `isError` tool result, i.e. model context. Keep the truncation and
 * the control-character strip, so that a hostile backend cannot push megabytes — or instructions —
 * down a path the topic allowlist never sees.
 */
export function sanitizeBody(text: string): string {
  const flat = text.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return flat.length > MAX_ERROR_BODY ? `${flat.slice(0, MAX_ERROR_BODY)}… [truncated]` : flat;
}

export interface FetchWithRetryOptions {
  /** Error-message prefix, e.g. `Slack chat.postMessage` or `Matrix GET /sync`. */
  label: string;
  /** True once the plugin has disconnected — stop retrying, throw instead of looping. */
  isStopped: () => boolean;
  /**
   * Per-backend `Retry-After` extraction → milliseconds, or undefined when the response carries no
   * usable hint. Only the body field differs between APIs; the header, the clamp and the default
   * are handled here. Receives the 429 `Response` (clone it before reading the body).
   */
  retryAfterOf?: (res: Response) => Promise<number | undefined> | number | undefined;
  /** Non-2xx statuses the caller treats as expected (returned, not thrown). Default: none. */
  allowStatuses?: number[];
  /** Attempts before giving up. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Wall-clock budget for the whole call. Default {@link DEFAULT_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Shared HTTP-with-429-retry loop. Builds nothing itself — the caller passes a fully-formed `init`
 * (auth headers + encoded body + optional `signal`). Retries 429 within a bounded attempt and
 * wall-clock budget, stops the moment `isStopped()` is true, returns the `Response` on ok /
 * allowStatuses, else throws `<label> → <status>: <body>`. Backend response *shapes* (Slack's
 * `ok:false`, XMPP IQ) are NOT unified here — interpret those in the caller.
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

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) {
      if (res.ok || (opts.allowStatuses?.includes(res.status) ?? false)) return res;
      throw new Error(`${opts.label} → ${res.status}: ${sanitizeBody(await res.text())}`);
    }

    if (opts.isStopped()) throw new Error(`${opts.label} → 429 (disconnected)`);

    const hinted = (await opts.retryAfterOf?.(res)) ?? retryAfterFromHeader(res);
    const wait = clampBackoff(hinted);
    const elapsed = now() - started;
    if (attempt >= maxAttempts || elapsed + wait > deadlineMs) {
      throw new Error(
        `${opts.label} → 429: still rate limited after ${attempt} attempts (${elapsed}ms)`,
      );
    }

    await delay(wait);
    // Re-check after the wait too: a disconnect that lands during backoff must not spend another
    // request against a backend the plugin has already torn down.
    if (opts.isStopped()) throw new Error(`${opts.label} → 429 (disconnected)`);
  }
}
