import { fetchWithRetry } from '@sharptrick/parley-net-util';
import { readRetryAfter, unwrapEnvelope } from './wire.js';

/** Wall-clock ceiling on one non-poll call, matching net-util's own per-call deadline. */
const REQUEST_BUDGET_MS = 30_000;

/**
 * One connection's worth of Bot API: the base URL, the token, the in-flight requests to abort on
 * teardown, and the memoized `getMe`. A `connect` builds a fresh one and a `disconnect`
 * {@link stop}s it, so an old generation's retries can never resume under a new connection.
 */
export class BotApi {
  /** In-flight long-polls, aborted on {@link stop} so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  private identity?: Promise<{ id: number; username?: string }>;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * Strip the bot token from a diagnostic. This API carries the credential in the URL PATH, so an
   * upstream that echoes the request line — a rejecting middlebox, a non-conforming local Bot API
   * server — puts it in a body; net-util redacts the status and transport paths, but a 2xx envelope
   * reaches neither. Keep EVERY message this plugin throws or reports going through here, so that a
   * new diagnostic cannot put the token into model context or the operator's logs.
   */
  redact(text: string): string {
    let out = text;
    for (const spelling of new Set([this.token, encodeURIComponent(this.token)])) {
      if (spelling.length > 1) out = out.split(spelling).join('<redacted>');
    }
    return out;
  }

  /**
   * Memoized `getMe` — one network call per connect. Only `connect` can populate this memo with a
   * rejection, and each connect builds a fresh client, so a failure never has to be evicted here.
   */
  getMe(): Promise<{ id: number; username?: string }> {
    const existing = this.identity;
    if (existing !== undefined) return existing;
    const pending = this.call('GET', '/getMe').then((result) => {
      const me = result as { id?: unknown; username?: unknown };
      if (typeof me.id !== 'number') {
        throw new Error('Telegram GET /getMe → result: bot identity carries no numeric id');
      }
      return { id: me.id, username: typeof me.username === 'string' ? me.username : undefined };
    });
    this.identity = pending;
    return pending;
  }

  /**
   * Single HTTP entry point (`<api_url>/bot<token><path>`) → the envelope's `result`. Retries on
   * 429 honoring Telegram's `parameters.retry_after` (SECONDS) until {@link stop}; throws any
   * other non-2xx as an `HttpStatusError` carrying the status the poll loop branches on.
   *
   * `budgetMs` is the ONE wall-clock ceiling on the call, passed to net-util as its deadline
   * rather than armed locally as well: a per-call budget the plugin computes and does not forward
   * is silently overridden by the shared 30s default, which aborts every healthy long poll past
   * `poll_timeout_s: 30`.
   */
  async call(
    method: string,
    path: string,
    opts?: { body?: unknown; budgetMs?: number; abortOnDisconnect?: boolean },
  ): Promise<unknown> {
    const url = `${this.baseUrl}/bot${this.token}${path}`;
    const headers: Record<string, string> = {};
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';
    const label = `Telegram ${method} ${path.split('?')[0] ?? path}`;
    const abortable = opts?.abortOnDisconnect === true;
    const controller = new AbortController();
    if (abortable) this.controllers.add(controller);
    try {
      const res = await fetchWithRetry(
        url,
        {
          method,
          headers,
          body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: abortable ? controller.signal : undefined,
        },
        {
          label,
          // Stop retrying once disconnected — don't keep hammering the API post-teardown.
          isStopped: () => this.stopped,
          retryAfterOf: readRetryAfter,
          deadlineMs: opts?.budgetMs ?? REQUEST_BUDGET_MS,
        },
      );
      return unwrapEnvelope(label, await res.text());
    } catch (err) {
      // Rewrite in place rather than rethrowing a new Error, so that HttpStatusError survives and
      // the poll loop's `statusOf` still reads the status it branches on.
      if (err instanceof Error) err.message = this.redact(err.message);
      throw err;
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** Abort every in-flight long-poll and refuse further retries. {@link redact} keeps working. */
  stop(): void {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.identity = undefined;
  }
}
