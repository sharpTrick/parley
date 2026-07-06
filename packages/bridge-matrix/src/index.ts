import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  safeName,
  type Topic,
} from '@sharptrick/parley-core';
import { delay, fetchWithRetry } from '@sharptrick/parley-net-util';

/** Plugin-specific backend_config. */
export interface MatrixBackendConfig {
  /** Homeserver base URL. Default `http://127.0.0.1:8008`. */
  homeserver_url?: string;
  /** Login user localpart. Default `parley`. */
  user?: string;
  /** Login password. Default `parleypass`. */
  password?: string;
  /** Homeserver `server_name` used to build room aliases. Default `parley.local`. */
  server_name?: string;
  /** Sync long-poll timeout (ms). The loop re-checks shutdown each interval. Default 25000. */
  sync_timeout_ms?: number;
  /**
   * OPTIONAL shared-room mode (test fixtures / rate-limited deployments). When set to an alias
   * localpart, EVERY topic maps to this one room instead of `#parley_<topic>`, and topics are
   * isolated by a `app.parley.topic` tag carried on each event (filtered on read and on the live
   * path). Synapse rate-limits *room creation* hard (~2-room burst, then ~1 room / 45s per user),
   * while message send/read/sync are unthrottled — so a one-room-per-topic suite is infeasible for
   * an unprivileged login. A production deployment runs the bridge as a rate-limit-exempt
   * appservice and leaves this UNSET to get a real Matrix room per topic. See README.
   */
  shared_room?: string;
}

/** Custom event-content key tagging the logical Parley topic (shared-room isolation + provenance). */
const TOPIC_KEY = 'app.parley.topic';

/** A minimal Matrix timeline event (the subset we read). */
interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content?: { body?: string; [key: string]: unknown };
}

const isMessageEvent = (e: MatrixEvent): boolean => e.type === 'm.room.message';

/**
 * Matrix (Synapse) backend (DESIGN §6/§9) — first external-network backend, over the raw
 * Client-Server HTTP API (no SDK; unencrypted rooms). By default a topic maps to its own room via
 * the canonical alias `#parley_<topic>:<server_name>`. The Matrix `event_id` is globally unique and
 * serves as BOTH `backendMsgId` (dedup key) AND `cursor` (order key). "Strictly after a cursor" is
 * resolved server-side: `/context/<event_id>` → a forward pagination token → `/messages?dir=f`. The
 * live path is a filtered `/sync` long-poll loop (timeline limit 0 skips history). Core never
 * compares cursor values — the homeserver's stream ordering is the single source of order.
 *
 * `shared_room` mode (see {@link MatrixBackendConfig.shared_room}) folds all topics into one room,
 * isolating them by an `app.parley.topic` content tag — the only practical way to run the suite
 * under Synapse's strict per-user room-creation rate limit without an appservice.
 */
export class MatrixPlugin implements BackendPlugin {
  private baseUrl = 'http://127.0.0.1:8008';
  private serverName = 'parley.local';
  private user = 'parley';
  private password = 'parleypass';
  private syncTimeoutMs = 25_000;
  /** Set → shared-room mode: alias localpart every topic resolves to; else per-topic rooms. */
  private sharedLocalpart?: string;
  private token?: string;
  private userId?: string;
  private stopped = false;
  private txnCounter = 0;
  /** room cache key → room_id, deduped so concurrent first-posts share one create/resolve. */
  private readonly rooms = new Map<string, Promise<string>>();
  /** In-flight sync long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as MatrixBackendConfig;
    this.baseUrl = (cfg.homeserver_url ?? 'http://127.0.0.1:8008').replace(/\/+$/, '');
    this.serverName = cfg.server_name ?? 'parley.local';
    this.user = cfg.user ?? 'parley';
    this.password = cfg.password ?? 'parleypass';
    this.syncTimeoutMs = cfg.sync_timeout_ms ?? 25_000;
    this.sharedLocalpart = cfg.shared_room;
    this.stopped = false;
    this.rooms.clear();

    const res = await this.http('POST', '/_matrix/client/v3/login', {
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: this.user },
        password: this.password,
      },
    });
    const json = (await res.json()) as { access_token: string; user_id: string };
    this.token = json.access_token;
    this.userId = json.user_id;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.token = undefined;
    this.userId = undefined;
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const roomId = await this.ensureRoom(topic);
    const txnId = `parley-${Date.now()}-${this.txnCounter++}-${rand()}`;
    const res = await this.http(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      { body: { msgtype: 'm.text', body: content, [TOPIC_KEY]: topic } },
    );
    const json = (await res.json()) as { event_id: string };
    // identity is the logical sender; on Matrix the homeserver stamps `sender` as our user_id.
    void identity;
    return asBackendMsgId(json.event_id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const roomId = await this.ensureRoom(args.topic);
    const limit = args.limit ?? 100;

    if (args.since === undefined) {
      // Default window: most-recent `limit`, returned ASCENDING (reverse the dir=b chunk).
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
      );
      const { chunk } = (await res.json()) as { chunk: MatrixEvent[] };
      const events = chunk.filter((e) => this.belongs(e, args.topic)).reverse();
      const messages = events.map((e) => eventToMessage(args.topic, e));
      const nextCursor = messages.at(-1)?.cursor ?? asCursor('');
      return { messages, nextCursor };
    }

    // Exclusive `since`: locate the cursor event, then page forward from just after it.
    const since = String(args.since);
    const ctxRes = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(since)}?limit=0`,
    );
    const ctx = (await ctxRes.json()) as { end?: string };
    if (ctx.end === undefined) {
      return { messages: [], nextCursor: args.since };
    }
    const fwdRes = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?from=${encodeURIComponent(ctx.end)}&dir=f&limit=${limit}`,
    );
    const { chunk } = (await fwdRes.json()) as { chunk: MatrixEvent[] };
    // The context `end` token is inconsistent at the boundary (it re-includes the `since` event
    // for a mid-stream event, but not for the tail). Make `since` strictly exclusive by dropping
    // everything up to AND INCLUDING the cursor event if it reappears in the forward page, THEN
    // restrict to this topic (shared-room mode interleaves other topics in the same room).
    let events = chunk.filter(isMessageEvent);
    const idx = events.findIndex((e) => e.event_id === since);
    if (idx >= 0) events = events.slice(idx + 1);
    events = events.filter((e) => this.belongs(e, args.topic));
    const messages = events.map((e) => eventToMessage(args.topic, e));
    const nextCursor = messages.at(-1)?.cursor ?? args.since;
    return { messages, nextCursor };
  }

  /**
   * Live path = a filtered `/sync` long-poll loop (DESIGN §9 — genuine events, not a poll timer).
   * The initial sync (timeline limit 0) yields a `next_batch` that SKIPS history; the loop then
   * delivers every `m.room.message` for this topic appended after it — INCLUDING our own sends —
   * in timeline order. `disconnect()` aborts the in-flight long-poll and stops the loop.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const roomId = await this.ensureRoom(topic);
    const filter = JSON.stringify({
      room: {
        rooms: [roomId],
        timeline: { limit: 0 },
        ephemeral: { limit: 0 },
        account_data: { limit: 0 },
        state: { limit: 0, lazy_load_members: true },
      },
      presence: { limit: 0 },
      account_data: { limit: 0 },
    });
    const fparam = encodeURIComponent(filter);

    // Establish the resume position BEFORE returning, so a post immediately after subscribe()
    // resolves is guaranteed to land in a subsequent sync (positioning is awaited).
    const initial = await this.http('GET', `/_matrix/client/v3/sync?filter=${fparam}&timeout=0`);
    let nextBatch = ((await initial.json()) as { next_batch: string }).next_batch;

    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        const controller = new AbortController();
        this.controllers.add(controller);
        let json: SyncResponse;
        try {
          const res = await this.http(
            'GET',
            `/_matrix/client/v3/sync?filter=${fparam}&since=${encodeURIComponent(nextBatch)}&timeout=${this.syncTimeoutMs}`,
            { signal: controller.signal },
          );
          json = (await res.json()) as SyncResponse;
        } catch {
          if (this.stopped) break;
          await delay(200);
          continue;
        } finally {
          this.controllers.delete(controller);
        }
        if (this.stopped) break;
        nextBatch = json.next_batch ?? nextBatch;
        const events = json.rooms?.join?.[roomId]?.timeline?.events ?? [];
        for (const e of events) {
          if (!this.belongs(e, topic)) continue;
          try {
            handler(eventToMessage(topic, e));
          } catch {
            /* handler is best-effort; never break the loop (DESIGN §6) */
          }
        }
      }
    };
    void loop();
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  /** True iff event `e` is an `m.room.message` belonging to `topic` (tag-gated in shared mode). */
  private belongs(e: MatrixEvent, topic: Topic): boolean {
    if (!isMessageEvent(e)) return false;
    if (this.sharedLocalpart === undefined) return true; // per-topic room: every message is ours
    return e.content?.[TOPIC_KEY] === topic;
  }

  /** Resolve (or create) the room for `topic`, memoized so concurrent first-posts don't double-create. */
  private ensureRoom(topic: Topic): Promise<string> {
    // In shared mode all topics collapse onto one room → one cache key, one resolve.
    const localpart =
      this.sharedLocalpart ?? `parley_${safeName(topic, sanitizeAlias)}`;
    const key = this.sharedLocalpart !== undefined ? ' shared' : (topic as string);
    const existing = this.rooms.get(key);
    if (existing !== undefined) return existing;
    const pending = this.resolveOrCreateRoom(localpart).catch((err) => {
      // Don't poison the cache on transient failure — let the next call retry.
      this.rooms.delete(key);
      throw err;
    });
    this.rooms.set(key, pending);
    return pending;
  }

  private async resolveOrCreateRoom(localpart: string): Promise<string> {
    const alias = `#${localpart}:${this.serverName}`;
    const existing = await this.lookupAlias(alias);
    if (existing !== undefined) {
      await this.joinRoom(existing);
      return existing;
    }
    // Create. If we lost the race (another instance created it first), resolve the alias instead.
    const res = await this.http('POST', '/_matrix/client/v3/createRoom', {
      body: { room_alias_name: localpart, preset: 'public_chat', visibility: 'private' },
      allowStatuses: [400, 409],
    });
    if (res.ok) {
      const json = (await res.json()) as { room_id: string };
      return json.room_id;
    }
    // M_ROOM_IN_USE (or alias taken) → resolve the now-existing alias.
    const raced = await this.lookupAlias(alias);
    if (raced !== undefined) {
      await this.joinRoom(raced);
      return raced;
    }
    const body = await res.text();
    throw new Error(`createRoom failed (${res.status}) and alias unresolved: ${body}`);
  }

  private async lookupAlias(alias: string): Promise<string | undefined> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { allowStatuses: [404] },
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as { room_id: string };
    return json.room_id;
  }

  private async joinRoom(roomId: string): Promise<void> {
    // Idempotent: returns 200 with the room_id even when already joined.
    await this.http('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
      body: {},
      allowStatuses: [403],
    });
  }

  /**
   * Single HTTP entry point. Adds auth, JSON encodes, and transparently retries on 429
   * (`M_LIMIT_EXCEEDED`) honoring `retry_after_ms`. Retries stop the moment we disconnect, so an
   * aborted test never leaves a loop hammering the homeserver. Throws on unexpected non-2xx unless
   * the caller marks the status as expected via `allowStatuses`.
   */
  private async http(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      signal?: AbortSignal;
      allowStatuses?: number[];
    },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts?.signal,
      },
      {
        label: `Matrix ${method} ${path}`,
        // Stop retrying once disconnected — don't compete for the rate-limit budget post-teardown.
        isStopped: () => this.stopped,
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
      },
    );
  }
}

interface SyncResponse {
  next_batch?: string;
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> };
}

function eventToMessage(topic: Topic, e: MatrixEvent): Message {
  return buildMessage({
    topic,
    sender: e.sender,
    content: e.content?.body ?? '',
    timestamp: new Date(e.origin_server_ts).toISOString(),
    id: e.event_id,
  });
}

/**
 * Matrix 429s carry `retry_after_ms` (MS) in the JSON body; Synapse ALSO sends the standard
 * `Retry-After` header (SECONDS). Prefer the header, then the body — both `> 0`-guarded so a
 * `0`/negative value falls to the default rather than `delay(0)` — capped at 5s.
 */
async function readRetryAfter(res: Response): Promise<number> {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5000);
  try {
    const json = (await res.clone().json()) as { retry_after_ms?: number };
    const ms = json.retry_after_ms;
    if (typeof ms === 'number' && ms > 0) return Math.min(ms, 5000);
  } catch {
    /* fall through to default backoff */
  }
  return 500;
}

const rand = (): string => Math.random().toString(36).slice(2, 10);

// Matrix alias localparts allow a restricted character set; map anything else to `_`.
const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
