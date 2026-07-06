import {
  asBackendMsgId,
  asCursor,
  asHandle,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  parseMentions,
  type Topic,
} from '@sharptrick/parley-core';
import { delay, fetchWithRetry } from '@sharptrick/parley-net-util';

/** Plugin-specific backend_config. */
export interface ZulipBackendConfig {
  /** Zulip server base URL. Default `http://127.0.0.1:9991` (docker-zulip dev default). */
  site_url?: string;
  /** Bot email for HTTP Basic auth. Default `parley-bot@localhost`. */
  email?: string;
  /** Bot API key for HTTP Basic auth. Default `parley-api-key`. */
  api_key?: string;
  /** The ONE Zulip stream (channel) carrying all Parley traffic. Default `parley`. */
  stream?: string;
  /**
   * Client-side cap (ms) on each `/api/v1/events` long-poll before it is aborted and reissued —
   * the loop re-checks shutdown each interval. Un-acked events survive the abort. Default 25000.
   */
  events_timeout_ms?: number;
}

/** The subset of a Zulip message object we read (wire format). */
interface ZulipMessage {
  id: number;
  content?: string;
  sender_email?: string;
  /** Unix seconds. */
  timestamp?: number;
}

/** One entry from `GET /api/v1/events`. Non-`message` types (heartbeat, …) only advance the ack. */
interface ZulipEvent {
  id: number;
  type: string;
  message?: ZulipMessage;
}

interface EventsResponse {
  result?: string;
  code?: string;
  events?: ZulipEvent[];
}

/** Per-subscription live state; `queueId` is mutable because a GC'd queue is re-registered. */
interface QueueState {
  queueId: string;
}

/**
 * Zulip backend (DESIGN §6/§9) — self-hosted, and the closest native fit of any backend: Zulip's
 * data model is literally streams-and-topics, so the mapping is one configured Zulip *stream*
 * carrying all Parley traffic, with each Parley topic → a Zulip *topic* inside that stream.
 * Spoken over the raw REST API with global `fetch` — no SDK.
 *
 * The Zulip message `id` is a globally monotonic integer, hence per-topic monotonic — it serves as
 * BOTH `backendMsgId` (dedup key) AND `cursor` (order key); the zero cursor is `'0'`.
 * `fetchRecent` = `GET /api/v1/messages` with an `anchor` (exclusive via `include_anchor=false`);
 * `subscribe` = a registered per-topic event queue driven by a `GET /api/v1/events` long-poll —
 * genuine push, not a poll timer. Zulip DOES deliver our own sends back to our own queue.
 *
 * ONE INEXACTNESS to know about: Zulip topics are MUTABLE namespaces — admins (and, by default
 * policy, members) can move or rename messages between topics after the fact. Message ids and
 * cursors survive a move, but topic *membership* can drift: a moved message silently leaves one
 * Parley topic's history and appears in another's. Ids/cursors stay valid; topic isolation is
 * only as strong as the server's move policy.
 */
export class ZulipPlugin implements BackendPlugin {
  private baseUrl = 'http://127.0.0.1:9991';
  private email = 'parley-bot@localhost';
  private apiKey = 'parley-api-key';
  private stream = 'parley';
  private eventsTimeoutMs = 25_000;
  private connected = false;
  private stopped = false;
  /** In-flight event long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  /** Live queues (one per subscribe), so disconnect can best-effort delete them server-side. */
  private readonly queues = new Set<QueueState>();

  /**
   * Zulip auth is per-request HTTP Basic (`email:api_key`) — there is no session or token to
   * establish, so `connect` only captures config. A bad URL/key surfaces on the first call.
   */
  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as ZulipBackendConfig;
    this.baseUrl = (cfg.site_url ?? 'http://127.0.0.1:9991').replace(/\/+$/, '');
    this.email = cfg.email ?? 'parley-bot@localhost';
    this.apiKey = cfg.api_key ?? 'parley-api-key';
    this.stream = cfg.stream ?? 'parley';
    this.eventsTimeoutMs = cfg.events_timeout_ms ?? 25_000;
    this.stopped = false;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    // Best-effort server-side cleanup — Zulip GCs idle queues after ~10 min anyway.
    for (const q of this.queues) {
      await this.http('DELETE', '/api/v1/events', { query: { queue_id: q.queueId } }).catch(
        () => undefined,
      );
    }
    this.queues.clear();
    this.connected = false;
  }

  /**
   * `POST /api/v1/messages` (form-encoded — Zulip rejects JSON bodies) → the new message `id`.
   * `identity` is informational only: Zulip stamps the sender from the authenticated bot account
   * (see README "Multiple concurrent sessions"). `opts.inReplyTo` is ignored — Zulip has no
   * per-message reply parent; it threads BY topic, and the topic is already the addressing unit.
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const res = await this.http('POST', '/api/v1/messages', {
      form: { type: 'stream', to: this.stream, topic, content },
    });
    const json = (await res.json()) as { id: number };
    // identity is the logical sender; Zulip stamps `sender_email` from the authenticated bot.
    void identity;
    return asBackendMsgId(String(json.id));
  }

  /**
   * `GET /api/v1/messages` narrowed to `<stream, topic>`. With `since`: `anchor=<since>` +
   * `include_anchor=false` + `num_after=<limit>` — the anchor itself is excluded, making `since`
   * strictly exclusive server-side. Without: `anchor=newest` + `num_before=<limit>` for the most
   * recent window. Zulip returns messages ascending by id — no client-side reordering needed.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const limit = args.limit ?? 100;
    const messages = await this.fetchMessages(args.topic, args.since, limit);
    const nextCursor = messages.at(-1)?.cursor ?? args.since ?? asCursor('0');
    return { messages, nextCursor };
  }

  /**
   * Live path = a registered per-topic event queue + `GET /api/v1/events` long-poll loop
   * (DESIGN §9 — genuine events, not a poll timer). `POST /api/v1/register` narrowed to
   * `<stream, topic>` IS the tail: only messages sent after registration enter the queue, and it
   * is awaited before subscribe resolves, so a post immediately after subscribe() is guaranteed
   * to be queued. Zulip delivers our own sends to our own queue, matching the seam's echo
   * expectation.
   *
   * Queue GC: Zulip garbage-collects queues after ~10 min idle; the server then answers
   * `BAD_EVENT_QUEUE_ID`. Recovery: re-register (new tail), then GAP-FILL — replay every message
   * with id > the last delivered id through the catch-up path — so the dead-queue window is not
   * lost, then resume the loop on the new queue. `lastDeliveredId` also dedupes the overlap when
   * a gap-filled message's event later arrives on the fresh queue.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const reg = await this.register(topic);
    const state: QueueState = { queueId: reg.queue_id };
    this.queues.add(state);
    let lastEventId = reg.last_event_id;
    // Gap-fill baseline: the current tail id (0 for an empty topic). Probed AFTER register so a
    // message landing in between is never lost — worst case it is delivered once via the queue.
    const tail = await this.fetchMessages(topic, undefined, 1);
    let lastDeliveredId = Number(tail.at(-1)?.backendMsgId ?? '0');

    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        const controller = new AbortController();
        this.controllers.add(controller);
        // Client-side long-poll cap so the loop re-checks shutdown; un-acked events survive.
        const timer = setTimeout(() => controller.abort(), this.eventsTimeoutMs);
        let json: EventsResponse;
        try {
          const res = await this.http('GET', '/api/v1/events', {
            query: {
              queue_id: state.queueId,
              last_event_id: String(lastEventId),
              dont_block: 'false',
            },
            signal: controller.signal,
            allowStatuses: [400],
          });
          json = (await res.json()) as EventsResponse;
        } catch {
          if (this.stopped) break;
          await delay(200);
          continue;
        } finally {
          clearTimeout(timer);
          this.controllers.delete(controller);
        }
        if (this.stopped) break;
        if (json.result === 'error') {
          if (json.code === 'BAD_EVENT_QUEUE_ID') {
            try {
              const fresh = await this.register(topic);
              state.queueId = fresh.queue_id;
              lastEventId = fresh.last_event_id;
              lastDeliveredId = await this.gapFill(topic, lastDeliveredId, handler);
            } catch {
              if (this.stopped) break;
              await delay(200);
            }
          } else {
            await delay(200);
          }
          continue;
        }
        for (const ev of json.events ?? []) {
          if (ev.id > lastEventId) lastEventId = ev.id; // ack everything, incl. heartbeats
          if (ev.type !== 'message' || ev.message === undefined) continue;
          if (ev.message.id <= lastDeliveredId) continue; // already gap-filled — dedup
          lastDeliveredId = ev.message.id;
          try {
            handler(zulipToMessage(topic, ev.message));
          } catch {
            /* handler is best-effort; never break the loop (DESIGN §6) */
          }
        }
      }
    };
    void loop();
  }

  /**
   * Real account lookup (DESIGN §4): `GET /api/v1/users`, matched on `email` or `full_name` →
   * `backendRef` = the Zulip `user_id`. Miss (or any error) degrades to the string convention.
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    try {
      const res = await this.http('GET', '/api/v1/users');
      const { members } = (await res.json()) as {
        members: Array<{ user_id: number; email: string; full_name: string }>;
      };
      const user = members.find((u) => u.email === handle || u.full_name === handle);
      if (user !== undefined) return { handle, backendRef: String(user.user_id) };
    } catch {
      /* lookup is best-effort; fall through to the string convention */
    }
    return { handle, backendRef: handle };
  }

  /** Shared narrowed read used by fetchRecent AND the gap-fill after a queue GC. */
  private async fetchMessages(topic: Topic, since: Cursor | undefined, limit: number): Promise<Message[]> {
    const narrow = JSON.stringify([
      { operator: 'stream', operand: this.stream },
      { operator: 'topic', operand: topic },
    ]);
    const query: Record<string, string> =
      since === undefined
        ? { narrow, anchor: 'newest', include_anchor: 'true', num_before: String(limit), num_after: '0' }
        : { narrow, anchor: String(since), include_anchor: 'false', num_before: '0', num_after: String(limit) };
    query.apply_markdown = 'false'; // raw content, not rendered HTML
    const res = await this.http('GET', '/api/v1/messages', { query });
    const { messages } = (await res.json()) as { messages: ZulipMessage[] };
    return messages.map((m) => zulipToMessage(topic, m)); // Zulip returns ascending by id
  }

  /** Register a `<stream, topic>`-narrowed message event queue; its birth is the topic's tail. */
  private async register(topic: Topic): Promise<{ queue_id: string; last_event_id: number }> {
    const res = await this.http('POST', '/api/v1/register', {
      form: {
        event_types: JSON.stringify(['message']),
        narrow: JSON.stringify([
          ['stream', this.stream],
          ['topic', topic],
        ]),
        apply_markdown: 'false',
      },
    });
    return (await res.json()) as { queue_id: string; last_event_id: number };
  }

  /** Replay everything after `sinceId` through `handler`; returns the new last delivered id. */
  private async gapFill(topic: Topic, sinceId: number, handler: MessageHandler): Promise<number> {
    const page = 500;
    let cursor = asCursor(String(sinceId));
    for (;;) {
      const messages = await this.fetchMessages(topic, cursor, page);
      for (const m of messages) {
        try {
          handler(m);
        } catch {
          /* handler is best-effort; never break the loop (DESIGN §6) */
        }
      }
      const last = messages.at(-1);
      if (last === undefined) return Number(cursor);
      cursor = last.cursor;
      if (messages.length < page) return Number(cursor);
    }
  }

  private require(): void {
    if (!this.connected) {
      throw new Error('ZulipPlugin not connected — call connect() first');
    }
  }

  /**
   * Single HTTP entry point. Adds HTTP Basic auth (`email:api_key`), encodes bodies as
   * `application/x-www-form-urlencoded` (Zulip REJECTS JSON bodies), and transparently retries on
   * 429 honoring `Retry-After` (header, or the `retry-after` JSON field — Zulip sends both,
   * in seconds). Retries stop the moment we disconnect, so an aborted test never leaves a loop
   * hammering the server. Throws on unexpected non-2xx unless the caller marks the status as
   * expected via `allowStatuses`.
   */
  private async http(
    method: string,
    path: string,
    opts?: {
      form?: Record<string, string>;
      query?: Record<string, string>;
      signal?: AbortSignal;
      allowStatuses?: number[];
    },
  ): Promise<Response> {
    const qs = opts?.query !== undefined ? `?${new URLSearchParams(opts.query)}` : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiKey}`).toString('base64')}`,
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
        isStopped: () => this.stopped,
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
      },
    );
  }
}

function zulipToMessage(topic: Topic, m: ZulipMessage): Message {
  const content = m.content ?? '';
  return {
    topic,
    senderHandle: asHandle(m.sender_email ?? ''),
    content,
    timestamp: new Date((m.timestamp ?? 0) * 1000).toISOString(),
    backendMsgId: asBackendMsgId(String(m.id)),
    cursor: asCursor(String(m.id)),
    mentions: parseMentions(content),
  };
}

/** Zulip 429s carry `Retry-After` (header) and `retry-after` (JSON body), both in SECONDS. */
async function readRetryAfter(res: Response): Promise<number> {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5000);
  try {
    const json = (await res.clone().json()) as { 'retry-after'?: number };
    const field = json['retry-after'];
    if (typeof field === 'number' && field > 0) return Math.min(field * 1000, 5000);
  } catch {
    /* fall through to default backoff */
  }
  return 500;
}
