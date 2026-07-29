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
/** Ceiling on a backoff we invented ourselves. A server-stated hint is honoured past it. */
export const MAX_BACKOFF_MS = 5_000;
/** Attempts a single call will make before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 8;
/** Wall-clock ceiling on a single call, kept under `catchup.block_max_ms` (DESIGN §11). */
export const DEFAULT_DEADLINE_MS = 30_000;
/** Longest untrusted response body embedded in a thrown message. */
export const MAX_ERROR_BODY = 2_048;
/** How often a backoff re-reads `isStopped()`. Bounds how long a disconnect waits on a backoff. */
export const STOP_POLL_MS = 25;

/**
 * Normalize a backoff we chose ourselves to `[DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS]`.
 *
 * `Number(null)` and `Number('')` are both `0`, so an absent `Retry-After` reads as "retry now" —
 * keep this clamp on the shared path, so that one plugin's parser bug cannot become a request
 * flood against the operator's own account. It does NOT bound a wait the server asked for: see
 * {@link fetchWithRetry}.
 */
export function clampBackoff(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * Milliseconds from a `Retry-After` header, or undefined if unusable. RFC 9110 defines BOTH forms:
 * `delay-seconds` and an HTTP-date. Reading only the first makes a date-form header look absent and
 * falls back to {@link DEFAULT_BACKOFF_MS} — an order of magnitude sooner than the server asked.
 */
export function retryAfterFromHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const ms = at - Date.now();
  return ms > 0 ? ms : undefined;
}

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Keep this on every path that embeds a transport error or a response body, so that a
 * credential-bearing URL (Telegram carries the bot token in the path) never reaches model context
 * or the operator's logs. The caller's `label` already identifies the call site without it.
 */
function redactUrls(text: string, url: string): string {
  return text.split(url).join('<url>').replace(URL_LIKE, '<url>');
}

/** Node's `fetch` puts the real reason in `cause`, not in `message`. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    const text = cur instanceof Error ? cur.message : String(cur);
    if (text.length > 0 && !parts.includes(text)) parts.push(text);
    cur = cur instanceof Error ? (cur.cause as unknown) : undefined;
  }
  return parts.length > 0 ? parts.join(': ') : 'unknown transport failure';
}

/** C0/DEL, plus the separators and bidi overrides a body can use to forge lines or reverse text. */
const NEUTRALIZED = /[\u0000-\u001F\u007F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Bound and flatten an untrusted response body before it goes in an Error.
 *
 * A thrown message becomes an `isError` tool result, i.e. model context. Keep the truncation and
 * the character strip, so that a hostile backend cannot push megabytes, forged line structure or
 * bidi overrides down a path the topic allowlist never sees. It bounds and flattens ONLY — the
 * body's words still reach the model, so do not read this as neutralizing what they say.
 */
export function sanitizeBody(text: string): string {
  const flat = text.replace(NEUTRALIZED, ' ');
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
  /**
   * Wall-clock budget for the whole call, INCLUDING the time a single request spends in flight.
   * A caller whose request legitimately blocks longer than {@link DEFAULT_DEADLINE_MS} (a
   * long-poll) must raise this, so that its own request is not aborted at the default.
   */
  deadlineMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * The non-2xx a caller did not allow, carrying the status as a FIELD.
 *
 * `message` keeps the `<label> → <status>: <body>` shape five backends' tests read, but a caller
 * that branches on the status (Telegram's fatal `getUpdates` statuses) must use {@link statusOf}:
 * recovering it by regex over prose makes any reword a silent behaviour change.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly label: string;
  readonly body: string;

  constructor(label: string, status: number, body: string) {
    super(`${label} → ${status}: ${body}`);
    this.name = 'HttpStatusError';
    this.label = label;
    this.status = status;
    this.body = body;
  }
}

/**
 * HTTP status behind a {@link fetchWithRetry} rejection, or undefined when it was not a status
 * failure. Matched by `name`, not `instanceof`, so a plugin resolving a second copy of this package
 * is still graded honestly.
 */
export function statusOf(err: unknown): number | undefined {
  if (err instanceof Error && err.name === 'HttpStatusError') {
    const { status } = err as HttpStatusError;
    return Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

/** Statuses whose `Response` may not carry a body at all (the constructor throws if one is given). */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Re-read a `Response` off the network into memory. Keep the whole body inside the attempt's own
 * budget, so that the caller's later `res.json()` cannot be aborted by a deadline signal this
 * module armed — an unlabeled `TimeoutError` reaching the caller escapes every guarantee below.
 */
async function buffered(res: Response): Promise<Response> {
  const text = await res.text();
  const body = text.length === 0 || NULL_BODY_STATUS.has(res.status) ? null : text;
  const { status, statusText, headers } = res;
  return new Response(body, { status, statusText, headers });
}

/**
 * One attempt, bounded by `budgetMs`. Without this an unanswered request outlives every bound the
 * options declare — `isStopped` is never consulted while a request is in flight, so a stalled API
 * pins the MCP tool call open for undici's own default and `disconnect()` cannot unblock it.
 */
async function fetchOnce(
  url: string,
  init: RequestInit,
  budgetMs: number,
  label: string,
): Promise<Response> {
  const deadline = AbortSignal.timeout(budgetMs);
  const signal =
    init.signal === undefined || init.signal === null
      ? deadline
      : AbortSignal.any([init.signal, deadline]);
  try {
    return await buffered(await fetch(url, { ...init, signal }));
  } catch (err) {
    if (init.signal?.aborted === true) throw err;
    if (deadline.aborted) throw new Error(`${label} → deadline: no response within ${budgetMs}ms`);
    throw new Error(`${label} → transport: ${sanitizeBody(redactUrls(errorText(err), url))}`);
  }
}

/** Never let reading the failing body replace `<label> → <status>: …` with a raw transport error. */
async function errorBody(res: Response, url: string): Promise<string> {
  try {
    return sanitizeBody(redactUrls(await res.text(), url));
  } catch (err) {
    return `<unreadable body: ${sanitizeBody(redactUrls(errorText(err), url))}>`;
  }
}

/**
 * Sleep `ms`, resolving false as soon as `isStopped()` polls true. Keep the wait racing against
 * that poll rather than only checking around it, so that a disconnect landing mid-backoff is not
 * held for the server's stated wait — which is deliberately unbounded, so a routine
 * `Retry-After: 25` would otherwise stall `disconnect()` for 25 seconds and pin the event loop.
 */
async function sleepUnlessStopped(ms: number, isStopped: () => boolean): Promise<boolean> {
  if (isStopped()) return false;
  let settled: boolean | undefined;
  let resolveWait: ((v: boolean) => void) | undefined;
  const cancels: (() => void)[] = [];
  const finish = (v: boolean): void => {
    if (settled !== undefined) return;
    settled = v;
    for (const cancel of cancels) cancel();
    resolveWait?.(v);
  };

  const waited = setTimeout(() => finish(true), ms);
  cancels.push(() => clearTimeout(waited));
  if (settled !== undefined) {
    clearTimeout(waited);
    return settled;
  }
  const poll = setInterval(() => {
    if (isStopped()) finish(false);
  }, STOP_POLL_MS);
  cancels.push(() => clearInterval(poll));
  return new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
}

/**
 * Shared HTTP-with-429-retry loop. Builds nothing itself — the caller passes a fully-formed `init`
 * (auth headers + encoded body + optional `signal`). Retries 429 within a bounded attempt and
 * wall-clock budget, abandons a backoff within {@link STOP_POLL_MS} of `isStopped()` turning true,
 * returns the `Response` on ok / allowStatuses, else throws `<label> → <status>: <body>`. A server
 * asking for a longer wait than this call's deadline ends the call rather than being retried sooner
 * than it asked. The returned `Response` is already buffered, so reading it cannot fail on the
 * deadline. Backend response *shapes* (Slack's `ok:false`, XMPP IQ) are NOT unified here —
 * interpret those in the caller.
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
    const budget = deadlineMs - (now() - started);
    if (budget <= 0) {
      throw new Error(
        `${opts.label} → deadline: exceeded ${deadlineMs}ms before attempt ${attempt}`,
      );
    }

    const res = await fetchOnce(url, init, budget, opts.label);
    if (opts.allowStatuses?.includes(res.status) ?? false) return res;
    if (res.status !== 429) {
      if (res.ok) return res;
      throw new HttpStatusError(opts.label, res.status, await errorBody(res, url));
    }

    if (opts.isStopped()) throw new Error(`${opts.label} → 429 (disconnected)`);

    const hinted = (await opts.retryAfterOf?.(res)) ?? retryAfterFromHeader(res);
    // Honour a server-stated wait IN FULL, so that we never retry sooner than the vendor asked —
    // that is what escalates a rate limit into a ban. Only a wait we invented is clamped; an
    // unreasonable hint is refused by the deadline below, which is the real governor.
    const stated = hinted !== undefined && Number.isFinite(hinted) && hinted > 0;
    const wait = stated ? (hinted as number) : clampBackoff(hinted);
    const elapsed = now() - started;
    const overDeadline = elapsed + wait > deadlineMs;
    if (attempt >= maxAttempts || overDeadline) {
      throw new Error(
        stated && overDeadline
          ? `${opts.label} → 429: upstream asked for ${Math.round(wait)}ms, past this call's ` +
            `${deadlineMs}ms deadline (${elapsed}ms elapsed). Raise deadlineMs to wait it out.`
          : `${opts.label} → 429: still rate limited after ${attempt} attempts (${elapsed}ms)`,
      );
    }

    const waitedItOut = await sleepUnlessStopped(wait, opts.isStopped);
    if (!waitedItOut || opts.isStopped()) {
      throw new Error(`${opts.label} → 429 (disconnected)`);
    }
  }
}
