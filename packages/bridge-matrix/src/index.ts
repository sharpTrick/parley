import {
  asBackendMsgId, type BackendConfig, type BackendIdentity, type BackendMsgId,
  type BackendPlugin, type Cursor, type FetchRecentArgs, type FetchRecentResult,
  type Handle, type MessageHandler, type Topic,
} from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import {
  configRisks, DEFAULT_HOMESERVER_URL, DEFAULT_PASSWORD,
  type MatrixBackendConfig, syncDeadlineMs, validateConfig,
} from './config.js';
import { emptyWindowCursor } from './cursor.js';
import { reportLoopCrash, reportSyncFailure, syncRetryDelayMs } from './diagnostics.js';
import {
  INCREMENTAL_TIMELINE_LIMIT, MatrixTimeline, returnedTooFast, SYNC_IDLE_PACE_MS,
} from './timeline.js';
import {
  eventToMessage, type MessageEvent, nextBatchOf,
  syncFilterParam, type SyncResponse, timelineTipOf, TOPIC_KEY,
} from './wire.js';

export { sanitizeAlias } from './alias.js';
export { readRetryAfter } from './wire.js';
export {
  MAX_SYNC_TIMEOUT_MS, type MatrixBackendConfig, ROOM_PRESETS, type RoomPreset, syncDeadlineMs,
} from './config.js';

/**
 * A pending native long-poll parked on a room. `topic` is the logical topic it is caught up to (its
 * exclusive `since` floor); `wake` fires EXACTLY once — on a belonging live event, at the `blockMs`
 * timeout, or on `disconnect()` — and tears down its own timer, registration and dedicated `/sync`.
 */
interface Waiter {
  topic: Topic;
  wake: () => void;
}

/** Live-coverage key: a subscribe loop covers exactly the (room, topic) pair it delivers. */
const liveKey = (roomId: string, topic: Topic): string => `${roomId}\u0000${String(topic)}`;

/**
 * Matrix (Synapse) backend (DESIGN §6/§9), over the raw Client-Server HTTP API (no SDK; unencrypted
 * rooms). By default a topic maps to its own room via the canonical alias
 * `#parley_<topic>:<server_name>`. The Matrix `event_id` is globally unique and serves as BOTH
 * `backendMsgId` (dedup key) AND `cursor` (order key). "Strictly after a cursor" is resolved
 * server-side: `/context/<event_id>` → a forward pagination token → `/messages?dir=f`. Core never
 * compares cursor values — the homeserver's stream ordering is the single source of order.
 *
 * `shared_room` mode (see {@link MatrixBackendConfig.shared_room}) folds all topics into one room,
 * isolating them by an `app.parley.topic` content tag — the only practical way to run the suite
 * under Synapse's strict per-user room-creation rate limit without an appservice.
 */
export class MatrixPlugin extends MatrixTimeline implements BackendPlugin {
  private txnCounter = 0;
  /**
   * room_id → the {@link Waiter}s parked on it, populated only while a `fetchRecent({ blockMs })`
   * blocks. Independent of `subscribe` — a blocking fetch needs no active route.
   */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /**
   * (room_id, topic) pairs with a live `subscribe` `/sync` loop running AND already positioned. A
   * blocking `fetchRecent` hooks that loop's delivery (no second `/sync`) only when its OWN pair is
   * here. Keep both halves — the loop wakes waiters for the one topic it delivers, so a room-only
   * key would let `subscribe(A)` starve a waiter on topic B in `shared_room` mode, and registering
   * before the positioning sync resolves would let a message landing in that window reach neither.
   */
  private readonly liveTopics = new Set<string>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as MatrixBackendConfig;
    // Keep the validation ahead of the stand-down, so that a refused config leaves a working
    // connection running instead of tearing it down on the way to a load error.
    validateConfig(cfg);
    this.generation++;
    this.standDown();
    // Keep the credential cleared BEFORE `baseUrl` moves, so that homeserver A's bearer token can
    // never reach homeserver B — neither on the login request nor on the seam calls that follow a
    // login which failed.
    this.token = undefined;
    this.userId = undefined;
    this.baseUrl = (cfg.homeserver_url ?? DEFAULT_HOMESERVER_URL).replace(/\/+$/, '');
    this.serverName = cfg.server_name ?? 'parley.local';
    this.user = cfg.user ?? 'parley';
    this.password = cfg.password ?? DEFAULT_PASSWORD;
    this.syncTimeoutMs = cfg.sync_timeout_ms ?? 25_000;
    this.roomPreset = cfg.room_preset ?? 'private_chat';
    this.invite = cfg.invite ?? [];
    this.sharedLocalpart = cfg.shared_room;
    this.stopped = false;

    for (const risk of configRisks(cfg)) console.warn(`[parley-matrix] SECURITY: ${risk}`);

    this.loggingIn = true;
    try {
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
    } finally {
      this.loggingIn = false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.standDown();
    this.token = undefined;
    this.userId = undefined;
  }

  /**
   * End the current generation's background work and empty every registry describing it. Keep BOTH
   * lifecycle entry points on this, so that a bare `connect()` — a reconnect with no preceding
   * `disconnect()` — ends the previous generation's parks at once rather than one park slice later,
   * which at the documented `sync_timeout_ms` is 25 seconds of a caller's `blockMs` spent on a
   * generation that is already gone.
   */
  private standDown(): void {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.liveTopics.clear();
    this.rooms.clear();
    // Wake every blocked long-poll so its `fetchRecent` returns at once (each wake() clears its timer
    // and registration). Snapshot first — wake() mutates `waiters` — then clear so nothing outlives
    // the teardown; the in-flight `/sync` each drives (if any) was already aborted above.
    const pending = [...this.waiters.values()].flatMap((set) => [...set]);
    this.waiters.clear();
    for (const w of pending) w.wake();
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const roomId = await this.ensureRoom(topic);
    const txnId = `parley-${Date.now()}-${this.txnCounter++}-${Math.random().toString(36).slice(2, 10)}`;
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
    return asBackendMsgId(json.event_id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const generation = this.generation;
    const deadline = Date.now() + (args.blockMs ?? 0);
    // Park for the room only when the answer would otherwise be an EMPTY page: the seam blocks on an
    // empty window, not on provisioning, so a topic whose room already exists must not spend the
    // budget re-resolving it.
    const roomId =
      (await this.existingRoom(args.topic, generation)) ??
      ((args.blockMs ?? 0) > 0 ? await this.roomForRead(args.topic, deadline, generation) : undefined);
    const limit = args.limit ?? 100;
    // A topic nobody has posted to has no room yet, and a read never provisions one; the empty page
    // an absent room answers with carries a cursor that replays from the room's first visible event.
    if (roomId === undefined) {
      const nextCursor = emptyWindowCursor(undefined, args.since, this.isStale(generation));
      return { messages: [], nextCursor };
    }

    if (args.since === undefined) {
      return this.recentWindow(roomId, args.topic, limit, generation, undefined);
    }

    const first = await this.fetchSince(roomId, args.topic, args.since, limit, generation);

    // Engage the native long-poll ONLY when asked (blockMs > 0) and the exclusive query came back
    // empty — otherwise this is the plain durable catch-up.
    const blockMs = deadline - Date.now();
    if (blockMs <= 0 || first.messages.length > 0 || this.stopped) {
      return first;
    }
    // Wait on the live `/sync` primitive (the same one `subscribe` uses) up to the budget for a new
    // belonging event in the room, then re-run the canonical exclusive `/messages` query so the
    // returned ids/cursor stay canonical. A timeout leaves the empty page + `first`'s cursor.
    return this.blockingFetch(
      roomId,
      args.topic,
      args.since,
      limit,
      blockMs,
      first.nextCursor,
      generation,
    );
  }

  /**
   * Park until a belonging live event lands in `roomId`, `blockMs` elapses, or `disconnect()` drains
   * us — then re-run the exclusive `/messages` query so the ids and cursor stay canonical.
   *
   * Every empty exit reports `best` — the most advanced cursor the canonical query has produced,
   * seeded from the pre-block one. Keep it threaded rather than reporting `sinceCursor`, so that a
   * blocking call reports the position a non-blocking one would: a cursor pinned at `since` cannot
   * cross a page-sized block of foreign-topic traffic, and everything beyond the forward-page bound
   * is then unreachable for as long as the caller keeps passing `blockMs`.
   */
  private async blockingFetch(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    blockMs: number,
    bestCursor: Cursor,
    generation: number,
  ): Promise<FetchRecentResult> {
    const deadline = Date.now() + blockMs;
    let best = bestCursor;
    // Wait in a loop so a SPURIOUS wake does not end the call early. The dedicated `/sync` can
    // re-deliver an event at/before `sinceCursor`, waking the waiter even though the exclusive
    // re-query is still empty. On such an empty re-query with budget left we re-arm and keep
    // waiting, so the plugin holds the full `blockMs` like the other native backends.
    for (;;) {
      const remaining = deadline - Date.now();
      if (this.isStale(generation) || remaining <= 0) {
        return { messages: [], nextCursor: best };
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
      // Keep the park sliced rather than spanning the whole budget, so that a wake source that stops
      // observing — a subscribe loop in retry backoff, a loop stalled mid-backfill, a dedicated
      // `/sync` that failed to position — costs one slice of latency and not the entire blockMs.
      const slice = this.parkSlice(remaining);
      // Keep the registration ahead of everything below, so that a delivery cannot land while this
      // waiter is invisible.
      timer = setTimeout(waiter.wake, slice);
      const set = this.waiters.get(roomId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(roomId, set);

      // Keep every exit from here on inside the finally, so that a throw from `fetchSince` cannot
      // strand this waiter's timer, registration and dedicated `/sync` for the rest of `blockMs`.
      try {
        if (this.isStale(generation)) return { messages: [], nextCursor: best };

        if (!this.liveTopics.has(liveKey(roomId, topic))) {
          syncController = new AbortController();
          this.controllers.add(syncController);
          const positioned = this.driveBoundedSync(
            roomId,
            topic,
            slice,
            syncController,
            waiter.wake,
          );
          // Keep this await ahead of the re-query below, so that a message landing in the
          // positioning window is seen by the re-query when the sync's `next_batch` already skipped
          // it. `parked` bounds the wait by the deadline.
          await Promise.race([positioned, parked]);
        }

        if (this.isStale(generation)) return { messages: [], nextCursor: best };
        const recheck = await this.fetchSince(roomId, topic, sinceCursor, limit, generation);
        if (recheck.messages.length > 0) return recheck;
        best = recheck.nextCursor;

        await parked;
        if (this.isStale(generation)) return { messages: [], nextCursor: best };
        const after = await this.fetchSince(roomId, topic, sinceCursor, limit, generation);
        if (after.messages.length > 0) return after;
        best = after.nextCursor;
        // Empty ⇒ the deadline timer fired or the wake was spurious. Loop: the top re-checks the
        // deadline and returns the empty page once the budget is spent, else re-arms.
      } finally {
        waiter.wake();
      }
    }
  }

  /**
   * A filtered `/sync` long-poll loop (DESIGN §9 — genuine events, not a poll timer). The initial
   * sync yields a `next_batch` that SKIPS history; the loop then delivers every `m.room.message` for
   * this topic appended after it — INCLUDING our own sends — in timeline order.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const generation = this.generation;
    const roomId = await this.ensureRoom(topic);
    if (this.isStale(generation)) return;
    // The initial position asks for `timeline.limit: 1` — the newest event, never delivered, only
    // the boundary `backfill` stops at; the loop uses a REAL limit so a burst that overflows the
    // per-sync cap is reported via `limited`/`prev_batch` instead of being silently truncated.
    const initParam = syncFilterParam(roomId, 1);
    const incParam = syncFilterParam(roomId, INCREMENTAL_TIMELINE_LIMIT);

    // Establish the resume position BEFORE returning, so a post immediately after subscribe()
    // resolves is guaranteed to land in a subsequent sync (positioning is awaited).
    const initial = await this.http('GET', `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`, {
      deadlineMs: syncDeadlineMs(0),
    });
    const positioned = (await initial.json()) as SyncResponse;
    let nextBatch = positioned.next_batch ?? '';
    // Keep this boundary read from the SAME response as `nextBatch`, so that a `limited`-burst
    // {@link backfill} stops EXACTLY at the subscription position: a boundary read one round-trip
    // later swallows everything that landed in between, and one read earlier pages back past the
    // position into PRE-subscription history and leaks it as live events.
    let lastDelivered: string | undefined = timelineTipOf(positioned, roomId);
    // Keep this registration after positioning AND behind the staleness gate, so that a concurrent
    // blocking `fetchRecent` only ever hooks a wake source that is both able to observe its message
    // and still running — a key added by a loop that has already stood down is a permanent phantom.
    if (this.isStale(generation)) return;
    this.liveTopics.add(liveKey(roomId, topic));

    const loop = async (): Promise<void> => {
      let consecutiveFailures = 0;
      while (!this.isStale(generation)) {
        const started = Date.now();
        // Keep EVERY use of the parsed body inside this try, so that a malformed-but-parseable
        // `/sync` — a JSON `null`, a `timeline.events` that is not a list — is reported and backed
        // off like any other fault rather than escaping the loop as an unhandled rejection, which
        // under Node's default terminates the bridge process.
        try {
          let json: SyncResponse;
          const controller = new AbortController();
          this.controllers.add(controller);
          try {
            const res = await this.http(
              'GET',
              `/_matrix/client/v3/sync?filter=${incParam}&since=${encodeURIComponent(nextBatch)}&timeout=${this.syncTimeoutMs}`,
              { signal: controller.signal, deadlineMs: syncDeadlineMs(this.syncTimeoutMs) },
            );
            json = (await res.json()) as SyncResponse;
          } finally {
            this.controllers.delete(controller);
          }
          if (this.isStale(generation)) break;
          nextBatch = nextBatchOf(json.next_batch, nextBatch);
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
          // Keep the reset here rather than beside the response, so that a `/sync` the loop THROWS
          // on while reading — a malformed-but-parseable body — still counts as a consecutive
          // failure: reset early it stays pinned at 1, and a homeserver answering that shape forever
          // gets a stderr line and a re-request every 200ms with no throttle and no backoff.
          consecutiveFailures = 0;
        } catch (err) {
          if (this.isStale(generation)) break;
          consecutiveFailures++;
          reportSyncFailure(topic, consecutiveFailures, err);
          await delay(syncRetryDelayMs(consecutiveFailures));
          continue;
        }
        if (returnedTooFast(started, this.syncTimeoutMs)) await delay(SYNC_IDLE_PACE_MS);
      }
    };
    // Keep the catch on this fire-and-forget call, so that anything the ladder inside `loop` does
    // not already contain reaches the operator as a dead live path instead of an unhandled
    // rejection, which under Node's default takes the whole bridge down with it.
    void loop().catch((err: unknown) => reportLoopCrash(topic, err));
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
    const set = this.waiters.get(roomId);
    if (set === undefined) return;
    for (const waiter of [...set]) {
      if (waiter.topic === topic) waiter.wake();
    }
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }
}
