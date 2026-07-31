import { fetchWithRetry } from '@sharptrick/parley-net-util';
import type { ZulipConfig } from './config.js';
import { readRetryAfter } from './wire.js';

/** Milliseconds a best-effort teardown request may take before it is abandoned. */
export const TEARDOWN_TIMEOUT_MS = 2000;

export interface RequestOpts {
  form?: Record<string, string>;
  query?: Record<string, string>;
  signal?: AbortSignal;
  allowStatuses?: number[];
  deadlineMs?: number;
}

/**
 * Every request the plugin makes, bound to the config of ONE connection. Adds HTTP Basic auth
 * (`email:api_key`), encodes bodies as `application/x-www-form-urlencoded` (Zulip REJECTS JSON
 * bodies), and transparently retries on 429 honoring `Retry-After` (header, or the `retry-after`
 * JSON field — Zulip sends both, in seconds). Retries stop the moment we disconnect, so an aborted
 * test never leaves a loop hammering the server. Throws on unexpected non-2xx unless the caller
 * marks the status as expected via `allowStatuses`.
 */
export class ZulipHttp {
  constructor(private readonly cfg: ZulipConfig, private readonly isStopped: () => boolean) {}

  request(method: string, path: string, opts?: RequestOpts): Promise<Response> {
    const qs = opts?.query !== undefined ? `?${new URLSearchParams(opts.query)}` : '';
    const url = `${this.cfg.baseUrl}${path}${qs}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiKey}`).toString('base64')}`,
    };
    if (opts?.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    return fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts?.form !== undefined ? new URLSearchParams(opts.form).toString() : undefined,
        signal: opts?.signal,
      },
      {
        label: `Zulip ${method} ${path}`,
        // Stop retrying once disconnected — don't compete for the rate-limit budget post-teardown.
        isStopped: this.isStopped,
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
        deadlineMs: opts?.deadlineMs,
      },
    );
  }

  /** Register a `<stream, topic>`-narrowed message event queue; its birth is the topic's tail. */
  async register(
    wireTopic: string, signal?: AbortSignal, deadlineMs?: number,
  ): Promise<{ queue_id: string; last_event_id: number }> {
    const res = await this.request('POST', '/api/v1/register', {
      signal,
      deadlineMs,
      form: {
        event_types: JSON.stringify(['message']),
        narrow: JSON.stringify([
          ['stream', this.cfg.stream],
          ['topic', wireTopic],
        ]),
        apply_markdown: 'false',
      },
    });
    const reg = (await res.json()) as { queue_id?: unknown; last_event_id?: unknown } | null;
    const queueId = reg?.queue_id;
    const lastEventId = reg?.last_event_id;
    if (typeof queueId !== 'string' || queueId === '' || typeof lastEventId !== 'number') {
      throw new Error(
        'Zulip POST /api/v1/register answered without a usable queue_id/last_event_id ' +
          `(got ${JSON.stringify({ queue_id: queueId, last_event_id: lastEventId })})`,
      );
    }
    return { queue_id: queueId, last_event_id: lastEventId };
  }

  /**
   * `park` asks the server to hold the request open until something lands. Keep `400` expected, so
   * that a GC'd queue — which Zulip reports that way — reaches the caller as a body to read rather
   * than as a transport throw it cannot tell from a dead server.
   */
  poll(
    queueId: string, lastEventId: number, park: boolean,
    opts: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<Response> {
    return this.request('GET', '/api/v1/events', {
      query: {
        queue_id: queueId,
        last_event_id: String(lastEventId),
        dont_block: park ? 'false' : 'true',
      },
      signal: opts.signal,
      allowStatuses: [400],
      deadlineMs: opts.deadlineMs,
    });
  }

  /**
   * Best-effort server-side queue cleanup — Zulip GCs idle queues after ~10 min anyway, so keep
   * the timeout, so that an unreachable-but-not-refusing server cannot stall shutdown past the
   * container's grace period.
   */
  async deleteQueue(queueId: string): Promise<void> {
    await this.request('DELETE', '/api/v1/events', {
      query: { queue_id: queueId },
      signal: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS),
    }).catch(() => undefined);
  }
}
