/**
 * `@sharptrick/parley-net-util` — the one HTTP-with-429-retry skeleton shared by the HTTP chat
 * backends (Zulip, Matrix, Discord, Telegram, Slack). Deliberately NOT part of `bridge-core`:
 * core stays a dependency-free seam so the non-HTTP backends (SQLite/Redis/NATS/Postgres) consume
 * it without pulling any HTTP concerns. Each plugin keeps its own auth-header building, body
 * encoding, and per-API `Retry-After` parser (the wire formats genuinely differ) and delegates
 * only the loop/guard/cap/default/`stopped` semantics here.
 *
 * Lockstep-published: semantic-release publishes this alongside every other Parley package — never
 * hand-version it.
 */

/** `setTimeout` promise — the one copy that replaces the per-plugin `delay` duplicates. */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface FetchWithRetryOptions {
  /** Error-message prefix, e.g. `Slack chat.postMessage` or `Matrix GET /sync`. */
  label: string;
  /** True once the plugin has disconnected — stop retrying, throw instead of looping. */
  isStopped: () => boolean;
  /**
   * Per-backend Retry-After parser → milliseconds to wait. MUST enforce the unified contract:
   * prefer a `> 0`-guarded value (header and/or body), cap at 5000, default 500. Receives the
   * 429 `Response` (clone it before reading the body).
   */
  retryAfterOf: (res: Response) => Promise<number> | number;
  /** Non-2xx statuses the caller treats as expected (returned, not thrown). Default: none. */
  allowStatuses?: number[];
}

/**
 * Shared HTTP-with-429-retry loop. Builds nothing itself — the caller passes a fully-formed
 * `init` (auth headers + encoded body + optional `signal`). Retries 429 honoring the caller's
 * `retryAfterOf`, stops the moment `isStopped()` is true, returns the `Response` on ok /
 * allowStatuses, else throws `<label> → <status>: <text>`. Backend response *shapes* (Slack's
 * `ok:false`, XMPP IQ) are NOT unified here — interpret those in the caller.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions,
): Promise<Response> {
  for (;;) {
    const res = await fetch(url, init);
    if (res.status === 429) {
      if (opts.isStopped()) throw new Error(`${opts.label} → 429 (disconnected)`);
      await delay(await opts.retryAfterOf(res));
      continue;
    }
    if (res.ok || (opts.allowStatuses?.includes(res.status) ?? false)) return res;
    throw new Error(`${opts.label} → ${res.status}: ${await res.text()}`);
  }
}
