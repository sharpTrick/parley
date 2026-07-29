import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type Cursor,
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
   *
   * SECURITY: the `app.parley.topic` tag is UNTRUSTED, member-writable event content with no
   * server-enforced integrity — any member of the shared room can send a message whose tag names an
   * arbitrary topic (including the reserved presence topic, entering `computeRoster` under its own
   * homeserver-stamped sender). So in `shared_room` mode inbound data chooses which topic/allowlist
   * bucket a message lands in. This mode is for TEST FIXTURES / rate-limited deployments ONLY and
   * MUST NOT carry mutually-distrusting topics. Production leaves this UNSET: one physically separate
   * Matrix room per topic, where the tag is ignored (rooms are the isolation boundary).
   */
  shared_room?: string;
  /**
   * `preset` for rooms this plugin CREATES. Default `private_chat` → `join_rule: invite`, so a
   * guessable alias (`#parley_<topic>:<server_name>`) does not let an uninvited account on the
   * homeserver (or, under federation, anywhere) read the topic's history or inject `<channel>`
   * events into a live agent session. Set `public_chat` only for a deliberately human-joinable
   * room; peers you want in an invite-only room go in {@link invite}.
   */
  room_preset?: 'private_chat' | 'trusted_private_chat' | 'public_chat';
  /** MXIDs invited to rooms this plugin creates (an invite-only room admits nobody else). */
  invite?: string[];
}

/** Custom event-content key tagging the logical Parley topic (shared-room isolation + provenance). */
const TOPIC_KEY = 'app.parley.topic';

/**
 * Cursor minted for a window that contained no belonging message: an opaque `/messages`
 * pagination token marking the position the window was read AT, so replaying it returns exactly
 * what has landed since. Never mint `''` here — an empty cursor 404s on `/context` and would be
 * decoded as an EXPIRED cursor, silently dropping everything older than the recent window.
 */
const STREAM_CURSOR_PREFIX = '@parley-stream:';

/**
 * A pending native long-poll (`fetchRecent` with `blockMs`) parked on a room. `topic` is the logical
 * topic it is caught up to (its exclusive `since` floor); `wake` fires EXACTLY once — when a
 * belonging live event lands (delivered by the running `subscribe` loop, or observed by a dedicated
 * bounded `/sync` when no loop runs), at the `blockMs` timeout, or on `disconnect()` — and tears
 * down its own timer, registration, and any dedicated `/sync`.
 */
interface Waiter {
  topic: Topic;
  wake: () => void;
}

/**
 * A Matrix timeline event as it arrives. Every field is member-controlled JSON on which the
 * homeserver enforces no schema. Keep these `unknown`, so that no value reaches `buildMessage`
 * without passing a guard — a throw here rejects `fetchRecent`, which bricks startup catch-up.
 */
interface MatrixEvent {
  type?: unknown;
  event_id?: unknown;
  sender?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
}

/** An `m.room.message` carrying the one field the seam cannot synthesize: a usable id. */
type MessageEvent = MatrixEvent & { event_id: string };

const isMessageEvent = (e: MatrixEvent): e is MessageEvent =>
  e.type === 'm.room.message' && typeof e.event_id === 'string';

const contentOf = (e: MatrixEvent): Record<string, unknown> =>
  typeof e.content === 'object' && e.content !== null ? (e.content as Record<string, unknown>) : {};

/** Real per-sync timeline cap for the incremental `/sync` filter and the backfill page size. */
const INCREMENTAL_TIMELINE_LIMIT = 100;
/** Bound on forward catch-up pagination so an all-foreign timeline terminates instead of spinning. */
const MAX_FORWARD_PAGES = 50;
/** Bound on backward `limited`-burst recovery pagination so it always terminates. */
const MAX_BACKFILL_PAGES = 50;
/**
 * Server-side `/messages` filter for the catch-up paths: reactions, edits, and membership churn
 * then cost no client page budget at all. Keep it OFF the `backfill`/`timelineTip` pair — those
 * match a boundary `event_id` that may itself be a state event, which a filtered page would hide.
 */
const MESSAGES_ONLY_FILTER = encodeURIComponent(JSON.stringify({ types: ['m.room.message'] }));

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
  private roomPreset: 'private_chat' | 'trusted_private_chat' | 'public_chat' = 'private_chat';
  private invite: string[] = [];
  /** Set → shared-room mode: alias localpart every topic resolves to; else per-topic rooms. */
  private sharedLocalpart?: string;
  private token?: string;
  private userId?: string;
  private stopped = false;
  /**
   * Bumped by every {@link connect}. Background work captures it and stands down when it no longer
   * matches — keep it, so that a loop parked in a retry backoff across a `disconnect()` cannot be
   * resurrected by the next `connect()` clearing {@link stopped}, and run on against a stale token,
   * room and handler.
   */
  private generation = 0;
  private txnCounter = 0;
  /** room cache key → room_id, deduped so concurrent first-posts share one create/resolve. */
  private readonly rooms = new Map<string, Promise<string>>();
  /** In-flight sync long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  /**
   * room_id → the native long-poll waiters parked on it. Populated only while a
   * `fetchRecent({ blockMs })` blocks. Woken by the running `subscribe` loop's delivery when one
   * drives this topic (see {@link liveTopics}); otherwise by a dedicated bounded `/sync`. Drained on
   * wake/timeout/disconnect. Independent of `subscribe` — a blocking fetch needs no active route.
   */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /**
   * (room_id, topic) pairs with a live `subscribe` `/sync` loop running AND already positioned. A
   * blocking `fetchRecent` hooks that loop's delivery (no second `/sync`) only when its OWN pair is
   * here; otherwise it drives its own bounded `/sync`. Keep both halves — the loop wakes waiters for
   * the one topic it delivers, so a room-only key would let `subscribe(A)` starve a waiter on topic
   * B in `shared_room` mode, and registering before the positioning sync resolves would let a
   * message that lands in that window reach neither the loop nor the waiter.
   */
  private readonly liveTopics = new Set<string>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as MatrixBackendConfig;
    this.baseUrl = (cfg.homeserver_url ?? 'http://127.0.0.1:8008').replace(/\/+$/, '');
    this.serverName = cfg.server_name ?? 'parley.local';
    this.user = cfg.user ?? 'parley';
    this.password = cfg.password ?? 'parleypass';
    this.syncTimeoutMs = cfg.sync_timeout_ms ?? 25_000;
    this.roomPreset = cfg.room_preset ?? 'private_chat';
    this.invite = cfg.invite ?? [];
    this.sharedLocalpart = cfg.shared_room;
    this.stopped = false;
    this.generation++;
    this.rooms.clear();

    if (cfg.password === undefined || this.password === 'parleypass') {
      console.warn(
        '[parley-matrix] SECURITY: connecting with the built-in default password ' +
          "('parleypass'). Set backend_config.password to a real secret; a network-reachable " +
          'homeserver provisioned with this password is world-readable/injectable.',
      );
    }

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
    this.liveTopics.clear();
    // Wake every blocked long-poll so its `fetchRecent` returns at once (each wake() clears its timer
    // and registration). Snapshot first — wake() mutates `waiters` — then clear so nothing outlives
    // the disconnect; the in-flight `/sync` each drives (if any) was already aborted above.
    const pending = [...this.waiters.values()].flatMap((set) => [...set]);
    this.waiters.clear();
    for (const w of pending) w.wake();
    this.token = undefined;
    this.userId = undefined;
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const roomId = await this.ensureRoom(topic);
    const txnId = `parley-${Date.now()}-${this.txnCounter++}-${rand()}`;
    const relation =
      opts?.inReplyTo === undefined
        ? {}
        : { 'm.relates_to': { 'm.in_reply_to': { event_id: String(opts.inReplyTo) } } };
    const res = await this.http(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      { body: { msgtype: 'm.text', body: content, [TOPIC_KEY]: topic, ...relation } },
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
      return this.recentWindow(roomId, args.topic, limit);
    }

    const first = await this.fetchSince(roomId, args.topic, args.since, limit);

    // Engage the native long-poll ONLY when asked (blockMs > 0) and the exclusive query came back
    // empty — otherwise this is the plain durable catch-up.
    const blockMs = args.blockMs ?? 0;
    if (blockMs <= 0 || first.messages.length > 0 || this.stopped) {
      return first;
    }
    // Wait on the live `/sync` primitive (the same one `subscribe` uses) up to the budget for a new
    // belonging event in the room, then re-run the canonical exclusive `/messages` query so the
    // returned ids/cursor stay canonical. A timeout leaves the empty page + stable cursor `first`.
    return this.blockingFetch(roomId, args.topic, args.since, limit, blockMs);
  }

  /**
   * The exclusive-`since` catch-up: locate the cursor event and page forward from just after it,
   * returning only belonging messages strictly after `since` plus a monotonic, replayable
   * `nextCursor`. Factored out of {@link fetchRecent} so the native long-poll can re-run the EXACT
   * canonical query on wake.
   */
  private async fetchSince(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
  ): Promise<FetchRecentResult> {
    const since = String(sinceCursor);
    if (since.startsWith(STREAM_CURSOR_PREFIX)) {
      const token = since.slice(STREAM_CURSOR_PREFIX.length);
      return this.drainForward(roomId, topic, token || undefined, undefined, limit, sinceCursor);
    }
    // Keep the `''` branch: read-state files written before {@link STREAM_CURSOR_PREFIX} existed
    // carry that sentinel, and routing it to `/context` 404s → the expired-cursor fallback would
    // silently skip every message older than the recent window on the first post-upgrade catch-up.
    if (since === '') {
      return this.drainForward(roomId, topic, undefined, undefined, limit, sinceCursor);
    }
    // Exclusive `since`: locate the cursor event, then page forward from just after it.
    const ctxRes = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(since)}?limit=0`,
      { allowStatuses: [404] },
    );
    // Keep this fallback rather than throwing on an unresolvable cursor, so that a purged /
    // retention-expired event (or a topic remapped to another room by a `shared_room`/`server_name`
    // change) does not brick startup: `buildBridge` awaits `catchUpAll`, so a throw here fails
    // EVERY restart until the read-state file is hand-edited.
    if (ctxRes.status === 404) {
      return this.recentWindow(roomId, topic, limit);
    }
    const ctx = (await ctxRes.json()) as { end?: string };
    if (ctx.end === undefined) {
      return { messages: [], nextCursor: sinceCursor };
    }
    return this.drainForward(roomId, topic, ctx.end, since, limit, sinceCursor);
  }

  /**
   * Page the timeline FORWARD from `start` (undefined = the first visible event in the room),
   * collecting up to `limit` messages belonging to `topic`. `sinceEventId`, when given, is made
   * strictly exclusive.
   */
  private async drainForward(
    roomId: string,
    topic: Topic,
    start: string | undefined,
    sinceEventId: string | undefined,
    limit: number,
    sinceCursor: Cursor,
  ): Promise<FetchRecentResult> {
    const messages: Message[] = [];
    let from = start;
    // Keep tracking the last RAW event id across pages, so that {@link cursorPastForeignBlock} can
    // advance past a full page of foreign-topic or non-message events: `/messages` bounds a page
    // BEFORE filtering, so pinning `nextCursor` at `since` would be indistinguishable from "caught
    // up" and would mask every later on-topic message forever.
    let lastRawEventId: string | undefined;
    for (let page = 0; page < MAX_FORWARD_PAGES && messages.length < limit; page++) {
      const fromParam = from === undefined ? '' : `from=${encodeURIComponent(from)}&`;
      const fwdRes = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${fromParam}dir=f&limit=${limit}&filter=${MESSAGES_ONLY_FILTER}`,
      );
      const { chunk, end } = (await fwdRes.json()) as { chunk: MatrixEvent[]; end?: string };
      if (chunk.length === 0) break; // genuine end of timeline.
      const rawTail = chunk.at(-1)?.event_id;
      if (typeof rawTail === 'string') lastRawEventId = rawTail;
      // The context `end` token is inconsistent at the boundary (it re-includes the `since` event
      // for a mid-stream event, but not for the tail). Make `since` strictly exclusive by dropping
      // everything up to AND INCLUDING the cursor event if it reappears in this page, THEN restrict
      // to this topic (shared-room mode interleaves other topics in the same room).
      let events = chunk.filter(isMessageEvent);
      const idx =
        sinceEventId === undefined ? -1 : events.findIndex((e) => e.event_id === sinceEventId);
      if (idx >= 0) events = events.slice(idx + 1);
      events = events.filter((e) => this.belongs(e, topic));
      for (const e of events) messages.push(eventToMessage(topic, e));
      if (end === undefined) break; // no further forward pagination token.
      from = end;
    }
    const trimmed = messages.slice(0, limit);
    return {
      messages: trimmed,
      nextCursor: cursorPastForeignBlock(trimmed, lastRawEventId, sinceCursor),
    };
  }

  /**
   * Native long-poll: park until a belonging live event lands in `roomId`, `blockMs` elapses, or
   * `disconnect()` drains us — then re-run the canonical exclusive `/messages` query so ids/cursor
   * stay canonical (timeout → empty page + stable `nextCursor === since`). The waiter's `wake` fires
   * EXACTLY once and self-cleans (timer cleared, registration removed, any dedicated `/sync`
   * aborted); it never blocks past `blockMs`. When a `subscribe` loop already drives this topic we
   * hook its delivery ({@link liveTopics}) rather than open a second `/sync`; otherwise we drive a
   * dedicated bounded `/sync` with its OWN since token (never the subscribe loop's, so it cannot
   * corrupt the live loop's position) to observe the wake.
   */
  private async blockingFetch(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    blockMs: number,
  ): Promise<FetchRecentResult> {
    const generation = this.generation;
    const deadline = Date.now() + blockMs;
    // Wait in a loop so a SPURIOUS wake does not end the call early. The dedicated `/sync` can
    // re-deliver an event at/before `sinceCursor`, waking the waiter even though the exclusive
    // re-query is still empty. On such an empty re-query with budget left we re-arm and keep
    // waiting, so the plugin holds the full `blockMs` like the other native backends.
    for (;;) {
      const remaining = deadline - Date.now();
      if (this.isStale(generation) || remaining <= 0) {
        return { messages: [], nextCursor: sinceCursor };
      }

      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let syncController: AbortController | undefined;
      let resolveParked!: () => void;
      const parked = new Promise<void>((resolve) => {
        resolveParked = resolve;
      });
      const waiter: Waiter = {
        topic,
        wake: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const set = this.waiters.get(roomId);
          if (set !== undefined) {
            set.delete(waiter);
            if (set.size === 0) this.waiters.delete(roomId);
          }
          if (syncController !== undefined) {
            this.controllers.delete(syncController);
            syncController.abort();
          }
          resolveParked();
        },
      };
      // Keep the registration ahead of everything below, so that a delivery cannot land while this
      // waiter is invisible. The timer is bounded by the REMAINING budget so re-arming after a
      // spurious wake never overruns blockMs.
      timer = setTimeout(waiter.wake, remaining);
      const set = this.waiters.get(roomId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(roomId, set);

      // Keep every exit from here on inside the finally, so that a throw from `fetchSince` cannot
      // strand this waiter's timer, registration and dedicated `/sync` for the rest of `blockMs`.
      try {
        if (this.isStale(generation)) return { messages: [], nextCursor: sinceCursor };

        if (!this.liveTopics.has(liveKey(roomId, topic))) {
          syncController = new AbortController();
          this.controllers.add(syncController);
          const positioned = this.driveBoundedSync(
            roomId,
            topic,
            remaining,
            syncController,
            waiter.wake,
          );
          // Keep this await ahead of the re-query below, so that a message landing in the
          // positioning window is seen by the re-query when the sync's `next_batch` already skipped
          // it. `parked` bounds the wait by the deadline.
          await Promise.race([positioned, parked]);
        }

        const recheck = await this.fetchSince(roomId, topic, sinceCursor, limit);
        if (recheck.messages.length > 0) return recheck;

        await parked;
        if (this.isStale(generation)) return { messages: [], nextCursor: sinceCursor };
        const after = await this.fetchSince(roomId, topic, sinceCursor, limit);
        if (after.messages.length > 0) return after;
        // Empty ⇒ the deadline timer fired or the wake was spurious. Loop: the top re-checks the
        // deadline and returns the empty page once the budget is spent, else re-arms.
      } finally {
        waiter.wake();
      }
    }
  }

  /**
   * Position a dedicated, bounded `/sync` used ONLY while a blocking `fetchRecent` waits on a room
   * that no `subscribe` loop covers. Resolves once the `timeout=0` positioning sync's `next_batch`
   * is in hand (its OWN token — never shared with the live loop), leaving {@link pollBoundedSync}
   * running behind it. Best-effort: a positioning failure just returns — the `blockMs` timer still
   * resolves the wait.
   */
  private async driveBoundedSync(
    roomId: string,
    topic: Topic,
    blockMs: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const generation = this.generation;
    const deadline = Date.now() + blockMs;
    const initParam = encodeURIComponent(JSON.stringify(this.syncFilter(roomId, 0)));
    let nextBatch: string;
    try {
      const initial = await this.http(
        'GET',
        `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`,
        { signal: controller.signal },
      );
      nextBatch = ((await initial.json()) as { next_batch: string }).next_batch;
    } catch {
      return;
    }
    void this.pollBoundedSync(roomId, topic, deadline, nextBatch, generation, controller, wake);
  }

  /**
   * Long-poll a positioned dedicated `/sync` forward until a belonging event appears (→ `wake()`),
   * the `blockMs` budget runs out, or it is aborted (disconnect/wake). Every `/sync` timeout is
   * clamped to the remaining budget so the total wait never exceeds `blockMs`. Best-effort: any
   * error (an abort included) just returns — the `blockMs` timer still resolves the wait.
   */
  private async pollBoundedSync(
    roomId: string,
    topic: Topic,
    deadline: number,
    positionedAt: string,
    generation: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const incParam = encodeURIComponent(
      JSON.stringify(this.syncFilter(roomId, INCREMENTAL_TIMELINE_LIMIT)),
    );
    let nextBatch = positionedAt;
    try {
      while (!this.isStale(generation) && !controller.signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const timeout = Math.min(remaining, this.syncTimeoutMs);
        const started = Date.now();
        const res = await this.http(
          'GET',
          `/_matrix/client/v3/sync?filter=${incParam}&since=${encodeURIComponent(nextBatch)}&timeout=${timeout}`,
          { signal: controller.signal },
        );
        const json = (await res.json()) as SyncResponse;
        nextBatch = json.next_batch ?? nextBatch;
        const events = json.rooms?.join?.[roomId]?.timeline?.events ?? [];
        if (events.some((e) => this.belongs(e, topic))) {
          wake();
          return;
        }
        // A conforming homeserver blocks server-side for ~`timeout` when idle. If the sync returned
        // far sooner with nothing belonging (a non-blocking/degenerate server), pace the loop so we
        // don't hot-spin the remaining budget — still bounded by `deadline`.
        if (Date.now() - started < timeout / 2) await delay(Math.min(remaining, 25));
      }
    } catch {
      /* aborted (disconnect/wake) or transient — the blockMs timer still resolves the wait */
    }
  }

  /**
   * Most-recent `limit` messages for `topic`, returned ASCENDING. Used for the default
   * (`since`-less) window AND as the fallback when a persisted cursor has expired — its
   * most-recent-`limit`-ascending contract is identical in both cases.
   *
   * Pages BACKWARDS until `limit` BELONGING messages are collected: a `dir=b` page is bounded
   * before topic/type filtering, so a single raw page would report a topic sitting behind `limit`
   * foreign-topic, reaction, or membership events as empty — indistinguishable from a topic that
   * was never written to.
   */
  private async recentWindow(
    roomId: string,
    topic: Topic,
    limit: number,
  ): Promise<FetchRecentResult> {
    const collected: MessageEvent[] = [];
    let from: string | undefined;
    let tailToken: string | undefined;
    for (let page = 0; page < MAX_BACKFILL_PAGES && collected.length < limit; page++) {
      const fromParam = from === undefined ? '' : `from=${encodeURIComponent(from)}&`;
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${fromParam}dir=b&limit=${limit}&filter=${MESSAGES_ONLY_FILTER}`,
      );
      const { chunk, start, end } = (await res.json()) as {
        chunk: MatrixEvent[];
        start?: string;
        end?: string;
      };
      tailToken ??= start;
      if (chunk.length === 0) break;
      for (const e of chunk) if (this.belongs(e, topic)) collected.push(e);
      if (end === undefined) break;
      from = end;
    }
    const messages = collected
      .slice(0, limit)
      .reverse()
      .map((e) => eventToMessage(topic, e));
    // An empty window mints the position it was READ AT, not `''`: replaying a stream token returns
    // exactly what landed after this call, whereas `''` 404s on `/context` and is decoded as an
    // expired cursor — which resumes from the recent window and drops everything before it.
    const nextCursor =
      messages.at(-1)?.cursor ?? asCursor(`${STREAM_CURSOR_PREFIX}${tailToken ?? ''}`);
    return { messages, nextCursor };
  }

  /**
   * Live path = a filtered `/sync` long-poll loop (DESIGN §9 — genuine events, not a poll timer).
   * The initial sync (timeline limit 0) yields a `next_batch` that SKIPS history; the loop then
   * delivers every `m.room.message` for this topic appended after it — INCLUDING our own sends —
   * in timeline order. `disconnect()` aborts the in-flight long-poll and stops the loop.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const generation = this.generation;
    const roomId = await this.ensureRoom(topic);
    // Two filters: the initial position uses `timeline.limit: 0` to skip history; the loop uses a
    // REAL timeline limit so a burst that overflows the per-sync cap is reported via
    // `limited`/`prev_batch` (and recoverable) instead of being silently truncated.
    const initParam = encodeURIComponent(JSON.stringify(this.syncFilter(roomId, 0)));
    const incParam = encodeURIComponent(
      JSON.stringify(this.syncFilter(roomId, INCREMENTAL_TIMELINE_LIMIT)),
    );

    // Establish the resume position BEFORE returning, so a post immediately after subscribe()
    // resolves is guaranteed to land in a subsequent sync (positioning is awaited).
    const initial = await this.http('GET', `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`);
    let nextBatch = ((await initial.json()) as { next_batch: string }).next_batch;
    // Keep this seed of the backward-recovery boundary, and keep it read AFTER the positioning sync,
    // so that a `limited`-burst {@link backfill} cannot page past the subscription position into
    // PRE-subscription history and leak it as live events — in `shared_room` mode `lastDelivered`
    // would otherwise stay `undefined` through any amount of other-topic traffic.
    let lastDelivered: string | undefined = await this.timelineTip(roomId);
    // Keep this registration after positioning, so that a concurrent blocking `fetchRecent` on this
    // (room, topic) only hooks a wake source that will really observe its message.
    this.liveTopics.add(liveKey(roomId, topic));

    const loop = async (): Promise<void> => {
      let consecutiveFailures = 0;
      while (!this.isStale(generation)) {
        const controller = new AbortController();
        this.controllers.add(controller);
        let json: SyncResponse;
        try {
          const res = await this.http(
            'GET',
            `/_matrix/client/v3/sync?filter=${incParam}&since=${encodeURIComponent(nextBatch)}&timeout=${this.syncTimeoutMs}`,
            { signal: controller.signal },
          );
          json = (await res.json()) as SyncResponse;
        } catch (err) {
          if (this.isStale(generation)) break;
          consecutiveFailures++;
          reportSyncFailure(topic, consecutiveFailures, err);
          await delay(syncRetryDelayMs(consecutiveFailures));
          continue;
        } finally {
          this.controllers.delete(controller);
        }
        if (this.isStale(generation)) break;
        consecutiveFailures = 0;
        nextBatch = json.next_batch ?? nextBatch;
        const timeline = json.rooms?.join?.[roomId]?.timeline;
        const events = timeline?.events ?? [];
        // The server truncated this sync's timeline to the filter cap; the omitted (older) events
        // are reachable only by paging `prev_batch` backwards. Recover and deliver them ASCENDING
        // before the new batch so no burst larger than the per-sync cap is silently dropped (the
        // "handler fires once per inbound message" seam contract).
        if (timeline?.limited === true && timeline.prev_batch !== undefined) {
          let recovered: MessageEvent[] = [];
          try {
            recovered = await this.backfill(
              roomId,
              topic,
              timeline.prev_batch,
              lastDelivered,
              new Set(events.map((e) => e.event_id)),
            );
          } catch {
            /* backfill is best-effort; anything missed stays reachable via fetchRecent catch-up */
          }
          for (const e of recovered) {
            lastDelivered = e.event_id;
            this.deliver(roomId, topic, e, handler);
          }
        }
        for (const e of events) {
          if (!this.belongs(e, topic)) continue;
          lastDelivered = e.event_id;
          this.deliver(roomId, topic, e, handler);
        }
      }
    };
    void loop();
  }

  /** True once work started under `generation` must stand down: we disconnected, or reconnected. */
  private isStale(generation: number): boolean {
    return this.stopped || this.generation !== generation;
  }

  /** Wake every native long-poll waiter parked on `roomId` for `topic` (idempotent per waiter). */
  private wakeRoomWaiters(roomId: string, topic: Topic): void {
    const set = this.waiters.get(roomId);
    if (set === undefined) return;
    for (const waiter of [...set]) {
      if (waiter.topic === topic) waiter.wake();
    }
  }

  /** Build the `/sync` room filter with a given timeline limit (0 = skip history for positioning). */
  private syncFilter(roomId: string, timelineLimit: number) {
    return {
      room: {
        rooms: [roomId],
        timeline: { limit: timelineLimit },
        ephemeral: { limit: 0 },
        account_data: { limit: 0 },
        state: { limit: 0, lazy_load_members: true },
      },
      presence: { limit: 0 },
      account_data: { limit: 0 },
    };
  }

  /**
   * The `event_id` of the most-recent event in `roomId` (ANY type — a state event is a valid
   * boundary since `backfill` matches by id, not by topic/type), or `undefined` for a room with no
   * timeline history.
   */
  private async timelineTip(roomId: string): Promise<string | undefined> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=1`,
    );
    const { chunk } = (await res.json()) as { chunk: MatrixEvent[] };
    const tip = chunk.at(0)?.event_id;
    return typeof tip === 'string' ? tip : undefined;
  }

  /**
   * Page the timeline BACKWARDS from a `limited` sync's `prev_batch` (`dir=b`, newest→oldest),
   * collecting belonging messages until we reach the last event already delivered (`stopAfter`), the
   * chunk empties, or the page bound trips; return them reversed to ASCENDING order for in-order
   * delivery. `skip` holds the ids already present in the current sync batch so a token-boundary
   * overlap can't double-deliver.
   */
  private async backfill(
    roomId: string,
    topic: Topic,
    prevBatch: string,
    stopAfter: string | undefined,
    skip: Set<unknown>,
  ): Promise<MessageEvent[]> {
    const recovered: MessageEvent[] = [];
    let from = prevBatch;
    const generation = this.generation;
    for (let page = 0; page < MAX_BACKFILL_PAGES && !this.isStale(generation); page++) {
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?from=${encodeURIComponent(from)}&dir=b&limit=${INCREMENTAL_TIMELINE_LIMIT}`,
      );
      const { chunk, end } = (await res.json()) as { chunk: MatrixEvent[]; end?: string };
      if (chunk.length === 0) break;
      let reachedBoundary = false;
      for (const e of chunk) {
        if (stopAfter !== undefined && e.event_id === stopAfter) {
          reachedBoundary = true;
          break;
        }
        if (skip.has(e.event_id)) continue; // already in this sync's batch — don't double-deliver.
        if (this.belongs(e, topic)) recovered.push(e);
      }
      if (reachedBoundary || end === undefined) break;
      from = end;
    }
    return recovered.reverse();
  }

  /**
   * Hand one event to a subscribe handler and wake the long-polls parked on its room. Keep waking
   * here rather than at the call sites, so that a delivery path added later cannot forget to.
   */
  private deliver(roomId: string, topic: Topic, e: MessageEvent, handler: MessageHandler): void {
    const message = eventToMessage(topic, e);
    try {
      handler(message);
    } catch {
      /* handler is best-effort; never break the loop (DESIGN §6) */
    }
    this.wakeRoomWaiters(roomId, topic);
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  /**
   * True iff event `e` is an `m.room.message` belonging to `topic` (tag-gated in shared mode, where
   * the tag is forgeable — see the security note on {@link MatrixBackendConfig.shared_room}).
   */
  private belongs(e: MatrixEvent, topic: Topic): e is MessageEvent {
    if (!isMessageEvent(e)) return false;
    if (this.sharedLocalpart === undefined) return true; // per-topic room: every message is ours
    return contentOf(e)[TOPIC_KEY] === topic;
  }

  /** Resolve (or create) the room for `topic`, memoized so concurrent first-posts don't double-create. */
  private ensureRoom(topic: Topic): Promise<string> {
    // In shared mode all topics collapse onto one room → one cache key, one resolve.
    const localpart =
      this.sharedLocalpart ?? `parley_${safeName(topic, sanitizeAlias)}`;
    // Keep this an escape, never a literal NUL byte, so that the file stays text to file(1) and
    // greppable by ripgrep.
    const key = this.sharedLocalpart !== undefined ? '\u0000shared' : (topic as string);
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
    // SEC: `visibility: 'private'` only hides the room from the directory — the JOIN RULE is what
    // keeps an uninvited account off a guessable alias, and that comes from `preset` alone.
    const res = await this.http('POST', '/_matrix/client/v3/createRoom', {
      body: {
        room_alias_name: localpart,
        preset: this.roomPreset,
        visibility: 'private',
        ...(this.invite.length > 0 ? { invite: this.invite } : {}),
      },
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
    const generation = this.generation;
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
        isStopped: () => this.isStale(generation),
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
      },
    );
  }
}

interface SyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      { timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string } }
    >;
  };
}

/**
 * Normalize an untrusted timeline event into a {@link Message}. Every field a room member controls
 * is coerced rather than trusted: a non-string `body` reaches core's mention parser, and a
 * non-numeric `origin_server_ts` reaches `Date#toISOString`, either of which throws — and a throw
 * out of `fetchRecent` bricks startup catch-up on every subsequent restart.
 */
function eventToMessage(topic: Topic, e: MessageEvent): Message {
  const body = contentOf(e).body;
  return buildMessage({
    topic,
    sender: typeof e.sender === 'string' ? e.sender : '',
    content: typeof body === 'string' ? body : '',
    timestamp: isoTimestamp(e.origin_server_ts),
    id: e.event_id,
  });
}

/** Largest offset `Date` can represent; past it `toISOString()` throws a RangeError. */
const MAX_TIMESTAMP_MS = 8.64e15;

const isoTimestamp = (ts: unknown): string =>
  new Date(
    typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts) <= MAX_TIMESTAMP_MS ? ts : 0,
  ).toISOString();

/**
 * The cursor a forward page must report: the last belonging message's, else the raw page position
 * so a block of foreign-topic or non-message events is crossed rather than replayed forever, else
 * the input `since` when the page was empty and there was nothing to advance past.
 */
const cursorPastForeignBlock = (
  collected: Message[],
  lastRawEventId: string | undefined,
  sinceCursor: Cursor,
): Cursor =>
  collected.at(-1)?.cursor ??
  (lastRawEventId !== undefined ? asCursor(lastRawEventId) : sinceCursor);

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

/** Live-coverage key: a subscribe loop covers exactly the (room, topic) pair it delivers. */
const liveKey = (roomId: string, topic: Topic): string => `${roomId}\u0000${String(topic)}`;

/** Ceiling on the subscribe loop's retry backoff — a dead homeserver still gets re-probed. */
const SYNC_RETRY_MAX_MS = 30_000;

/**
 * Exponential backoff for a failing `/sync`, so a PERMANENT failure (revoked token → 401, kicked
 * from the room → 403) degrades to a slow probe instead of hammering the homeserver forever.
 */
const syncRetryDelayMs = (consecutiveFailures: number): number =>
  Math.min(200 * 2 ** (consecutiveFailures - 1), SYNC_RETRY_MAX_MS);

/**
 * Announce a failing subscribe loop on stderr — otherwise a permanently broken live path is
 * invisible to the operator, who sees only homeserver load. Rate-limited to powers of two so a
 * long outage cannot itself become the flood.
 */
function reportSyncFailure(topic: Topic, consecutiveFailures: number, err: unknown): void {
  if ((consecutiveFailures & (consecutiveFailures - 1)) !== 0) return;
  // Drop the query string: a `/sync` URL carries the whole JSON room filter, which buries the
  // status and error body an operator actually needs under a screenful of percent-encoding.
  const detail = (err instanceof Error ? err.message : String(err)).replace(/\?\S*?(?= →|$)/, '');
  console.error(
    `[parley-matrix] /sync failed for topic ${JSON.stringify(String(topic))} ` +
      `(${consecutiveFailures} consecutive; retrying in ${syncRetryDelayMs(consecutiveFailures)}ms): ${detail}`,
  );
}

// Matrix alias localparts allow a restricted character set; map anything else to `_`.
const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
