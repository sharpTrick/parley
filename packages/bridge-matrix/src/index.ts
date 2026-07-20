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
   * SECURITY (SEC-18): the `app.parley.topic` tag is UNTRUSTED, member-writable event content with
   * no server-enforced integrity — any member of the shared room can send a message whose tag names
   * an arbitrary topic (including the reserved presence topic, entering `computeRoster` under its own
   * homeserver-stamped sender). So in `shared_room` mode inbound data chooses which topic/allowlist
   * bucket a message lands in. This mode is for TEST FIXTURES / rate-limited deployments ONLY and
   * MUST NOT carry mutually-distrusting topics. Production leaves this UNSET: one physically separate
   * Matrix room per topic, where the tag is ignored (rooms are the isolation boundary).
   */
  shared_room?: string;
}

/** Custom event-content key tagging the logical Parley topic (shared-room isolation + provenance). */
const TOPIC_KEY = 'app.parley.topic';

/**
 * A pending native long-poll (`fetchRecent` with `blockMs`, issue #20) parked on a room. `topic`
 * is the logical topic it is caught up to (its exclusive `since` floor); `wake` fires EXACTLY once
 * — when a belonging live event lands (delivered by the running `subscribe` loop, or observed by a
 * dedicated bounded `/sync` when no loop runs), at the `blockMs` timeout, or on `disconnect()` —
 * and tears down its own timer, registration, and any dedicated `/sync` (no leaked timers/sockets).
 */
interface Waiter {
  topic: Topic;
  wake: () => void;
}

/** A minimal Matrix timeline event (the subset we read). */
interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content?: { body?: string; [key: string]: unknown };
}

const isMessageEvent = (e: MatrixEvent): boolean => e.type === 'm.room.message';

/** Real per-sync timeline cap for the incremental `/sync` filter and the backfill page size (BUG-09). */
const INCREMENTAL_TIMELINE_LIMIT = 100;
/** Bound on forward catch-up pagination so an all-foreign timeline terminates instead of spinning (BUG-03). */
const MAX_FORWARD_PAGES = 50;
/** Bound on backward `limited`-burst recovery pagination so it always terminates (BUG-09). */
const MAX_BACKFILL_PAGES = 50;

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
  /**
   * room_id → the native long-poll waiters parked on it (issue #20). Populated only while a
   * `fetchRecent({ blockMs })` blocks. Woken by the running `subscribe` loop's delivery when one
   * drives this room (see {@link liveRooms}); otherwise by a dedicated bounded `/sync`. Drained on
   * wake/timeout/disconnect. Independent of `subscribe` — a blocking fetch needs no active route.
   */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /**
   * room_ids with a live `subscribe` `/sync` loop running. A blocking `fetchRecent` hooks that
   * loop's delivery (no second `/sync`) when the room is here; when it is NOT, the blocking path
   * drives its OWN bounded `/sync` to observe the wake. Added in `subscribe`, cleared on disconnect.
   */
  private readonly liveRooms = new Set<string>();

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

    // SEC-06: refuse to connect *silently* with the repo-public default credential — an operator
    // who left `password` unset (or set it to the well-known value) gets one loud warning naming
    // the backend and the key to set, emitted before the login POST goes out.
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
    this.liveRooms.clear();
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
      return this.recentWindow(roomId, args.topic, limit);
    }

    const first = await this.fetchSince(roomId, args.topic, args.since, limit);

    // Native long-poll (issue #20): engage ONLY when asked (blockMs > 0) and the exclusive query
    // came back empty — otherwise this is the unchanged durable catch-up. Returning early/empty is
    // ALWAYS safe (core's generic wrapper polls the remaining budget), so this stays conservative.
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
   * canonical query on wake without duplicating the BUG-03/BUG-10 handling.
   */
  private async fetchSince(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
  ): Promise<FetchRecentResult> {
    // Exclusive `since`: locate the cursor event, then page forward from just after it.
    const since = String(sinceCursor);
    const ctxRes = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(since)}?limit=0`,
      { allowStatuses: [404] },
    );
    // BUG-10: a purged / retention-expired cursor (or a topic remapped to a different room by a
    // `shared_room`/`server_name` config change) no longer resolves and 404s on `/context`. Treat
    // it as an expired cursor and resume from the recent window instead of throwing — `buildBridge`
    // awaits `catchUpAll`, so a throw here bricks startup on EVERY restart until the read-state file
    // is hand-edited. Other backends already degrade gracefully from a trimmed/expired cursor.
    if (ctxRes.status === 404) {
      return this.recentWindow(roomId, topic, limit);
    }
    const ctx = (await ctxRes.json()) as { end?: string };
    if (ctx.end === undefined) {
      return { messages: [], nextCursor: sinceCursor };
    }

    // BUG-03: the forward `/messages` page is `limit`-bounded BEFORE topic/type filtering, so a
    // full page of foreign-topic (shared-room) or non-`m.room.message` events would pin
    // `nextCursor` at `since` — indistinguishable from "caught up" — and permanently mask later
    // on-topic messages (a catch-up livelock). Advance the cursor by RAW page position and drain
    // the foreign block: page forward until `limit` belonging messages are collected or the
    // timeline ends, tracking the last raw event id so the cursor always crosses a foreign block.
    const messages: Message[] = [];
    let from = ctx.end;
    let lastRawEventId: string | undefined;
    for (let page = 0; page < MAX_FORWARD_PAGES && messages.length < limit; page++) {
      const fwdRes = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?from=${encodeURIComponent(from)}&dir=f&limit=${limit}`,
      );
      const { chunk, end } = (await fwdRes.json()) as { chunk: MatrixEvent[]; end?: string };
      if (chunk.length === 0) break; // genuine end of timeline.
      lastRawEventId = chunk.at(-1)?.event_id ?? lastRawEventId;
      // The context `end` token is inconsistent at the boundary (it re-includes the `since` event
      // for a mid-stream event, but not for the tail). Make `since` strictly exclusive by dropping
      // everything up to AND INCLUDING the cursor event if it reappears in this page, THEN restrict
      // to this topic (shared-room mode interleaves other topics in the same room).
      let events = chunk.filter(isMessageEvent);
      const idx = events.findIndex((e) => e.event_id === since);
      if (idx >= 0) events = events.slice(idx + 1);
      events = events.filter((e) => this.belongs(e, topic));
      for (const e of events) messages.push(eventToMessage(topic, e));
      if (end === undefined) break; // no further forward pagination token.
      from = end;
    }
    const trimmed = messages.slice(0, limit);
    // nextCursor: the last belonging message's cursor if any were collected; else the raw page
    // position so the cursor crosses the foreign block; else `since` when the first page was empty
    // (nothing to advance past). Guarantees monotonic forward progress so `catchUpTopic` either
    // gets a full page and continues, or advances the persisted cursor past the foreign block.
    const nextCursor =
      trimmed.at(-1)?.cursor ??
      (lastRawEventId !== undefined ? asCursor(lastRawEventId) : sinceCursor);
    return { messages: trimmed, nextCursor };
  }

  /**
   * Native long-poll (issue #20): park until a belonging live event lands in `roomId`, `blockMs`
   * elapses, or `disconnect()` drains us — then re-run the canonical exclusive `/messages` query so
   * ids/cursor stay canonical (timeout → empty page + stable `nextCursor === since`). The waiter's
   * `wake` fires EXACTLY once and self-cleans (timer cleared, registration removed, any dedicated
   * `/sync` aborted); it never blocks past `blockMs`. When a `subscribe` loop already drives this
   * room we hook its delivery ({@link liveRooms}) rather than open a second `/sync`; otherwise we
   * drive a dedicated bounded `/sync` with its OWN since token (never the subscribe loop's, so it
   * cannot corrupt the live loop's position) to observe the wake.
   */
  private async blockingFetch(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    blockMs: number,
  ): Promise<FetchRecentResult> {
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
    // Register the waiter FIRST so it is live across everything below (no lost wakeups).
    timer = setTimeout(waiter.wake, blockMs);
    const set = this.waiters.get(roomId) ?? new Set<Waiter>();
    set.add(waiter);
    this.waiters.set(roomId, set);
    if (this.stopped) {
      waiter.wake();
      return { messages: [], nextCursor: sinceCursor };
    }

    // Arm the wake source. When a `subscribe` loop already drives this room we hook its delivery
    // ({@link wakeRoomWaiters}), no second `/sync`; otherwise drive a bounded `/sync` (its controller
    // is aborted by wake() on timeout/disconnect, so it never outlives the wait).
    if (!this.liveRooms.has(roomId)) {
      syncController = new AbortController();
      this.controllers.add(syncController);
      void this.driveBoundedSync(roomId, topic, blockMs, syncController, waiter.wake);
    }

    // Close the lost-wakeup window for BOTH paths: a belonging message may have landed between the
    // caller's first `fetchSince` and the wake source being armed (before this registration for the
    // live loop; before `driveBoundedSync`'s `timeout=0` positioning for the dedicated one). Re-check
    // ONCE now that the waiter is live across the snapshot; if it's there, wake/cancel and return it
    // promptly instead of idling out the budget.
    const recheck = await this.fetchSince(roomId, topic, sinceCursor, limit);
    if (recheck.messages.length > 0) {
      waiter.wake();
      return recheck;
    }

    await parked;
    if (this.stopped) return { messages: [], nextCursor: sinceCursor };
    return this.fetchSince(roomId, topic, sinceCursor, limit);
  }

  /**
   * Drive a dedicated, bounded `/sync` used ONLY while a blocking `fetchRecent` waits on a room that
   * no `subscribe` loop covers. It positions with a `timeout=0` sync (its OWN token — never shared
   * with the live loop), then long-polls forward until a belonging event appears (→ `wake()`), the
   * `blockMs` budget runs out, or it is aborted (disconnect/wake). Every `/sync` timeout is clamped
   * to the remaining budget so the total wait never exceeds `blockMs`. Best-effort: any error (an
   * abort included) just returns — the `blockMs` timer still resolves the wait.
   */
  private async driveBoundedSync(
    roomId: string,
    topic: Topic,
    blockMs: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const deadline = Date.now() + blockMs;
    const initParam = encodeURIComponent(JSON.stringify(this.syncFilter(roomId, 0)));
    const incParam = encodeURIComponent(
      JSON.stringify(this.syncFilter(roomId, INCREMENTAL_TIMELINE_LIMIT)),
    );
    try {
      const initial = await this.http(
        'GET',
        `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`,
        { signal: controller.signal },
      );
      let nextBatch = ((await initial.json()) as { next_batch: string }).next_batch;
      while (!this.stopped && !controller.signal.aborted) {
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
   * Most-recent `limit` messages for `topic`, returned ASCENDING (reverse the `dir=b` chunk). Used
   * for the default (`since`-less) window AND as the BUG-10 fallback when a persisted cursor has
   * expired — its most-recent-`limit`-ascending contract is identical in both cases.
   */
  private async recentWindow(
    roomId: string,
    topic: Topic,
    limit: number,
  ): Promise<FetchRecentResult> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
    );
    const { chunk } = (await res.json()) as { chunk: MatrixEvent[] };
    const events = chunk.filter((e) => this.belongs(e, topic)).reverse();
    const messages = events.map((e) => eventToMessage(topic, e));
    const nextCursor = messages.at(-1)?.cursor ?? asCursor('');
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
    // Mark this room as live-driven so a concurrent blocking `fetchRecent` ({@link blockingFetch})
    // hooks THIS loop's delivery (via {@link wakeRoomWaiters}) instead of opening a second `/sync`.
    this.liveRooms.add(roomId);
    // Two filters: the initial position uses `timeline.limit: 0` to skip history; the loop uses a
    // REAL timeline limit (BUG-09) so a burst that overflows the per-sync cap is reported via
    // `limited`/`prev_batch` (and recoverable) instead of being silently truncated.
    const initParam = encodeURIComponent(JSON.stringify(this.syncFilter(roomId, 0)));
    const incParam = encodeURIComponent(
      JSON.stringify(this.syncFilter(roomId, INCREMENTAL_TIMELINE_LIMIT)),
    );

    // Establish the resume position BEFORE returning, so a post immediately after subscribe()
    // resolves is guaranteed to land in a subsequent sync (positioning is awaited).
    const initial = await this.http('GET', `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`);
    let nextBatch = ((await initial.json()) as { next_batch: string }).next_batch;
    // Backward-recovery stop boundary (BUG-09): the event_id of the last event handed to the
    // handler. SEED it — right after positioning — with the current timeline tip so a `limited`
    // burst recovery can never page backward PAST the subscription position into PRE-subscription
    // history (which `subscribe` must skip) when no on-topic message has been delivered yet. Without
    // this seed, in `shared_room` mode `lastDelivered` stays `undefined` while other-topic traffic
    // flows, and the first `limited` sync would call `backfill(stopAfter=undefined)` with no lower
    // bound — walking up to MAX_BACKFILL_PAGES into old belonging messages that predate the cursor
    // and leaking them as spurious live `<channel>` events. The tip is read AFTER the timeout=0 sync
    // so the boundary never precedes B0; an empty room yields `undefined` (no history → safe). Once a
    // real message is delivered the boundary advances past the seed.
    let lastDelivered: string | undefined = await this.timelineTip(roomId);

    const loop = async (): Promise<void> => {
      while (!this.stopped) {
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
        } catch {
          if (this.stopped) break;
          await delay(200);
          continue;
        } finally {
          this.controllers.delete(controller);
        }
        if (this.stopped) break;
        nextBatch = json.next_batch ?? nextBatch;
        const timeline = json.rooms?.join?.[roomId]?.timeline;
        const events = timeline?.events ?? [];
        // BUG-09: the server truncated this sync's timeline to the filter cap; the omitted (older)
        // events are reachable only by paging `prev_batch` backwards. Recover and deliver them
        // ASCENDING before the new batch so no burst larger than the per-sync cap is silently
        // dropped (the "handler fires once per inbound message" seam contract).
        if (timeline?.limited === true && timeline.prev_batch !== undefined) {
          let recovered: MatrixEvent[] = [];
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
            this.deliver(topic, e, handler);
          }
        }
        let deliveredBelonging = false;
        for (const e of events) {
          if (!this.belongs(e, topic)) continue;
          lastDelivered = e.event_id;
          this.deliver(topic, e, handler);
          deliveredBelonging = true;
        }
        // Wake any native long-poll (issue #20) parked on this room: this live loop just observed a
        // belonging event strictly after the subscription position, so a blocked `fetchRecent` should
        // re-run its canonical query now instead of idling out its budget.
        if (deliveredBelonging) this.wakeRoomWaiters(roomId, topic);
      }
    };
    void loop();
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
   * timeline history. Read once at subscribe time to seed the `limited`-burst backward-recovery
   * boundary at the subscription position so `backfill` (BUG-09) never walks into pre-subscription
   * history. An empty room has no such history, so `undefined` there is safe.
   */
  private async timelineTip(roomId: string): Promise<string | undefined> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=1`,
    );
    const { chunk } = (await res.json()) as { chunk: MatrixEvent[] };
    return chunk.at(0)?.event_id;
  }

  /**
   * BUG-09 recovery: page the timeline BACKWARDS from a `limited` sync's `prev_batch` (`dir=b`,
   * newest→oldest), collecting belonging messages until we reach the last event already delivered
   * (`stopAfter`), the chunk empties, or the page bound trips; return them reversed to ASCENDING
   * order for in-order delivery. `skip` holds the ids already present in the current sync batch so
   * a token-boundary overlap can't double-deliver.
   */
  private async backfill(
    roomId: string,
    topic: Topic,
    prevBatch: string,
    stopAfter: string | undefined,
    skip: Set<string>,
  ): Promise<MatrixEvent[]> {
    const recovered: MatrixEvent[] = [];
    let from = prevBatch;
    for (let page = 0; page < MAX_BACKFILL_PAGES && !this.stopped; page++) {
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

  /** Deliver one event to a subscribe handler, swallowing handler throws (best-effort, DESIGN §6). */
  private deliver(topic: Topic, e: MatrixEvent, handler: MessageHandler): void {
    try {
      handler(eventToMessage(topic, e));
    } catch {
      /* handler is best-effort; never break the loop (DESIGN §6) */
    }
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  /**
   * True iff event `e` is an `m.room.message` belonging to `topic` (tag-gated in shared mode).
   *
   * SECURITY (SEC-18): in `shared_room` mode this gate reads the `app.parley.topic` tag straight off
   * an untrusted, member-writable event — Matrix enforces no integrity on custom content keys, so any
   * room member can forge the tag (including naming the reserved presence topic). This is why
   * `shared_room` is documented as test-only / non-production ({@link MatrixBackendConfig.shared_room}):
   * per-topic rooms (the default) are the real isolation boundary and ignore the tag entirely.
   */
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
  rooms?: {
    join?: Record<
      string,
      { timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string } }
    >;
  };
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
