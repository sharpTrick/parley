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
/**
 * Default ceiling on the bytes a single response may put in memory. The body of a response the
 * caller never sees is bounded far tighter than this — see {@link fetchWithRetry}.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** How often a backoff re-reads `isStopped()`. Bounds how long a disconnect waits on a backoff. */
export const STOP_POLL_MS = 25;

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

/**
 * RFC 9110 `delay-seconds` is `1*DIGIT`, and a fraction is the de-facto extension Discord and Slack
 * send. Keep the spelling PINNED rather than deferring to `Number`, so that `0x1F4` cannot be read
 * as 500 seconds and `1e3` as 1000 — a misread that inflates a routine hint past the deadline and
 * ends the call.
 */
const DELAY_SECONDS = /^\d+(?:\.\d+)?$/;

/**
 * The three `HTTP-date` spellings RFC 9110 §5.6.7 defines: IMF-fixdate, obsolete RFC 850, asctime.
 * Keep this PINNED for the same reason `delay-seconds` is, so that `Date.parse`'s laxity cannot
 * invent a date out of something that is not one — `Headers.get` joins a gateway's `Retry-After`
 * and an origin's into `"3600, 5"`, which V8 reads as May of the year 3600 and which then dominates
 * the max below by twelve orders of magnitude, ending the call with a wait no deadline can cover.
 */
const HTTP_DATE_SPELLINGS = [
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
];

function httpDateMs(text: string): number | undefined {
  if (!HTTP_DATE_SPELLINGS.some((spelling) => spelling.test(text))) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

function oneRetryAfterValue(raw: string, from: number): number | undefined {
  const text = raw.trim();
  if (DELAY_SECONDS.test(text)) return Number(text) * 1000;
  const at = httpDateMs(text);
  return at === undefined ? undefined : at - from;
}

/**
 * When the server says "now". An HTTP-date `Retry-After` is a point on the SERVER's clock (RFC 9110
 * §10.2.3), so measuring it against ours turns a client clock a minute ahead into a negative wait —
 * i.e. no hint at all — and a client behind into a wait past the deadline. Keep the `Date` header as
 * the origin whenever the response offers one, so that the hint is skew-invariant.
 */
function serverNow(res: Response): number {
  return httpDateMs((res.headers.get('date') ?? '').trim()) ?? Date.now();
}

/**
 * Split a joined header back into its field-values. `Headers.get` joins a repeated header with
 * `", "`, and an HTTP-date carries a comma of its own between the day-name and the date — so a bare
 * split cuts a date in half. A fragment is re-attached to the one before it only when the JOIN is
 * itself a well-spelled HTTP-date, so that reassembly cannot swallow a usable field-value sitting
 * behind a three-letter unparseable one (`"abc, 10"` still states ten seconds).
 */
function fieldValues(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const previous = out.at(-1);
    const joined = previous === undefined ? undefined : `${previous},${part}`;
    if (joined !== undefined && httpDateMs(joined.trim()) !== undefined) out[out.length - 1] = joined;
    else out.push(part);
  }
  return out;
}

/**
 * Milliseconds from a `Retry-After` header, or undefined if unusable. RFC 9110 defines BOTH forms:
 * `delay-seconds` and an HTTP-date. Reading only the first makes a date-form header look absent and
 * falls back to {@link DEFAULT_BACKOFF_MS} — an order of magnitude sooner than the server asked.
 *
 * A gateway and an origin both setting the header make `Headers.get` return `"120, 120"`. Take the
 * LARGEST duration any field-value states, so that a multi-valued header cannot degrade to no hint
 * at all.
 */
export function retryAfterFromHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const from = serverNow(res);
  const candidates = fieldValues(raw)
    .map((part) => oneRetryAfterValue(part, from))
    .filter((ms): ms is number => ms !== undefined && ms > 0);
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/** A hint only counts as server-stated when it is a real, positive duration. */
const usableHint = (ms: number | undefined): number | undefined =>
  ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Longest path segment treated as ordinary routing vocabulary on length alone. A segment past it is
 * opaque enough to be a token — Discord's `/api/webhooks/<id>/<token>` carries one with no
 * punctuation at all — while a shorter one is a word like `api` or `v1`.
 */
const ROUTE_WORD_CHARS = 8;

/**
 * How a method name is spelled: `getUpdates`, `conversations`, `chat.postMessage`. Keep this
 * exemption, so that redaction cannot strike a segment out of the PROSE of an error body:
 * Telegram's own 409 reads "can't use getUpdates method while webhook is active", and an operator
 * shown "can't use <redacted> method" has been told less than nothing.
 */
const ROUTE_WORD = /^[A-Za-z.]+$/;

/**
 * Longest segment the exemption above covers. Keep a ceiling on it, so that a credential spelled
 * with no digit and no punctuation — a 32-character alphabetic webhook token, a dotted JWT — cannot
 * buy its way out of redaction by reading as a very long method name.
 */
const METHOD_NAME_CHARS = 24;

const routingVocabulary = (part: string): boolean =>
  part.length <= METHOD_NAME_CHARS && ROUTE_WORD.test(part);

const carriesSecret = (part: string): boolean =>
  part.includes(':') || (part.length > ROUTE_WORD_CHARS && !routingVocabulary(part));

/**
 * Both sides of the percent-encoding boundary. `URL` hands userinfo back ENCODED (a password's own
 * `:` comes out as `%3A`) and query values back DECODED, so a component's getter is only one of the
 * two spellings a body or a transport error can echo. Keep both, so that a token cannot survive
 * redaction by being written the way the other half of the parser spells it.
 */
function spellings(part: string): string[] {
  const out = new Set([part, encodeURIComponent(part)]);
  // Keep the catch: a stray `%` in a URL makes `decodeURIComponent` throw, and this runs on the
  // path that is BUILDING an error message.
  try {
    out.add(decodeURIComponent(part));
  } catch {
    out.add(part);
  }
  return [...out];
}

/**
 * The parts of the request URL that are themselves a secret. Telegram's path is
 * `/bot<id>:<token>/<method>` and Discord's is `/api/webhooks/<id>/<token>`, and a transport or a
 * hostile body can echo the path alone — which no scheme-anchored sweep and no byte-identical
 * comparison against the full URL would catch.
 *
 * Every component a credential can hide in is enumerated, not just the path: userinfo and a query
 * value are the two other places an API key is conventionally carried, and a body echoing one of
 * them alone escapes both the exact split and the scheme sweep.
 *
 * A query value is filtered by the same {@link carriesSecret} predicate as a path segment, because
 * it carries the same two kinds of thing: `access_token=<opaque>` alongside Matrix's
 * `timeout=30000`, Zulip's `dont_block=false` and `anchor=newest`. Keep the filter, so that a
 * routine parameter is not struck out of the untrusted body everywhere it appears — including
 * inside longer words, which is what turns "you have 100 messages and no permission" into
 * "you have <redacted>0 messages and <redacted> permission". Userinfo takes no such exemption: it
 * is credential-by-construction, and a short password is still a password.
 */
function credentialParts(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const { pathname, username, password, searchParams } = parsed;
  const parts = [
    ...[pathname, ...pathname.split('/')].filter(carriesSecret),
    username,
    password,
    ...[...searchParams.values()].filter(carriesSecret),
  ];
  return [...new Set(parts.flatMap(spellings))].filter((part) => part.length > 1);
}

/**
 * Keep this on every path that embeds a transport error or a response body, so that a
 * credential-bearing URL (Telegram carries the bot token in the path) never reaches model context
 * or the operator's logs. The caller's `label` already identifies the call site without it.
 *
 * A bare `host/path` with no scheme is NOT recognized as a URL; only the credential-bearing parts
 * of it are removed. Keep any new credential shape out of the host and query, so that this holds.
 */
function redactUrls(text: string, url: string): string {
  let out = text.split(url).join('<url>');
  for (const secret of credentialParts(url)) out = out.split(secret).join('<redacted>');
  return out.replace(URL_LIKE, '<url>');
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

/**
 * Every control (`Cc`: C0, C1, DEL) and every format character (`Cf`: bidi overrides, isolates,
 * BOM), plus the two line/paragraph separators, which are `Zl`/`Zp` and so outside both classes.
 * Keep this as the CLASSES rather than a hand-listed set, so that a family nobody thought of —
 * U+0085 NEL and U+009B CSI were both missing from the listed version — cannot forge line structure.
 */
const NEUTRALIZED = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A surrogate with no partner: `JSON.stringify` escapes it, but nothing downstream can decode it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Bound and flatten an untrusted response body before it goes in an Error.
 *
 * A thrown message becomes an `isError` tool result, i.e. model context. Keep the truncation and
 * the character strip, so that a hostile backend cannot push forged line structure or bidi
 * overrides down a path the topic allowlist never sees. This bounds the MESSAGE; what bounds the
 * MEMORY is the read itself ({@link MAX_RESPONSE_BYTES}), not this. It bounds and flattens ONLY —
 * the body's words still reach the model, so do not read this as neutralizing what they say.
 */
export function sanitizeBody(text: string): string {
  const flat = text.replace(NEUTRALIZED, ' ').replace(LONE_SURROGATE, '\uFFFD');
  if (flat.length <= MAX_ERROR_BODY) return flat;
  const cut = flat.slice(0, MAX_ERROR_BODY);
  // Cutting between a surrogate pair emits half an astral character into an MCP JSON result.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole}… [truncated]`;
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

/** Bytes of a doomed body worth pulling off the socket: enough that {@link MAX_ERROR_BODY} chars of
 * it survive `sanitizeBody` even when every character is four bytes of UTF-8. */
const DOOMED_BODY_BYTES = MAX_ERROR_BODY * 4;

/** Thrown by name so a caller can tell "the upstream flooded us" from an ordinary status failure. */
class BodyTooLargeError extends Error {}

/**
 * Read at most `maxBytes` of `res`, then cancel the stream. Keep the bound INSIDE the read, so that
 * a hostile or broken upstream cannot spend the process's memory on a body whose surplus is
 * discarded anyway: `res.text()` buffers whatever arrives before any cap can be applied to it.
 */
async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; overflowed: boolean }> {
  if (res.body === null) return { text: '', overflowed: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      size += value.byteLength;
      if (size > maxBytes) {
        overflowed = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), overflowed };
}

/**
 * Re-read a `Response` off the network into memory, bounded. Keep the whole body inside the
 * attempt's own budget, so that the caller's later `res.json()` cannot be aborted by a deadline
 * signal this module armed — an unlabeled `TimeoutError` reaching the caller escapes every
 * guarantee below.
 *
 * A response the caller will never be handed becomes at most {@link MAX_ERROR_BODY} characters of
 * error message, so it is read to {@link DOOMED_BODY_BYTES} and the rest dropped. One the caller
 * WILL parse cannot be silently truncated — a half body is a corrupt parse, not a smaller one — so
 * past `maxBytes` it fails instead.
 */
async function buffered(res: Response, maxBytes: number, doomed: boolean): Promise<Response> {
  const { text, overflowed } = await readBounded(res, doomed ? DOOMED_BODY_BYTES : maxBytes);
  if (overflowed && !doomed) {
    throw new BodyTooLargeError(`response body exceeded ${maxBytes} bytes`);
  }
  const body = text.length === 0 ? null : text;
  const { status, statusText, headers } = res;
  return new Response(body, { status, statusText, headers });
}

/**
 * Whether `err` IS the caller's own abort, rather than something that failed while the caller
 * happened to be aborting. Keep the test on the ERROR, so that a transport failure racing a
 * plugin's `disconnect()` still leaves through the labelled, redacted envelope: reading the
 * SIGNAL's state alone hands that caller a raw `request to <credential-bearing URL> failed`.
 */
function isCallerAbort(err: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  return err === (signal.reason as unknown) || (err instanceof Error && err.name === 'AbortError');
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
  opts: { label: string; maxBytes: number; keeps: (res: Response) => boolean },
): Promise<Response> {
  const { label } = opts;
  const deadline = AbortSignal.timeout(budgetMs);
  const caller = init.signal ?? undefined;
  const signal = caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
  try {
    const res = await fetch(url, { ...init, signal });
    return await buffered(res, opts.maxBytes, !opts.keeps(res));
  } catch (err) {
    if (caller !== undefined && isCallerAbort(err, caller)) throw caller.reason;
    if (deadline.aborted) throw new Error(`${label} → deadline: no response within ${budgetMs}ms`);
    if (err instanceof BodyTooLargeError) throw new Error(`${label} → body: ${err.message}`);
    throw new Error(`${label} → transport: ${sanitizeBody(redactUrls(errorText(err), url))}`);
  }
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
  let resolveWait!: (v: boolean) => void;
  const wait = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
  const cancels: (() => void)[] = [];
  const finish = (v: boolean): void => {
    for (const cancel of cancels) cancel();
    resolveWait(v);
  };

  // Take the resolve and arm the poll before the wait timer, so that a timer firing the instant it
  // is armed still finds a resolve to call and a poll to cancel. Reordering leaks the interval.
  const poll = setInterval(() => {
    if (isStopped()) finish(false);
  }, STOP_POLL_MS);
  cancels.push(() => clearInterval(poll));
  const waited = setTimeout(() => finish(true), ms);
  cancels.push(() => clearTimeout(waited));
  return wait;
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
      res.ok || res.status === 429 || (opts.allowStatuses?.includes(res.status) ?? false),
  };

  for (let attempt = 1; ; attempt++) {
    const budget = deadlineMs - (now() - started);
    if (budget <= 0) {
      throw new Error(
        `${opts.label} → deadline: exceeded ${deadlineMs}ms before attempt ${attempt}`,
      );
    }

    const res = await fetchOnce(url, init, budget, attemptOpts);
    if (opts.allowStatuses?.includes(res.status) ?? false) return res;
    if (res.status !== 429) {
      if (res.ok) return res;
      throw new HttpStatusError(opts.label, res.status, await errorBody(res, url));
    }

    if (opts.isStopped()) throw new Error(`${opts.label} → 429 (disconnected)`);

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
      throw new Error(`${opts.label} → 429 (disconnected)`);
    }
  }
}
