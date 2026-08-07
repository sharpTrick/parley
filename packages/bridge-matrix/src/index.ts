import {
  asBackendMsgId, type BackendConfig, type BackendIdentity, type BackendMsgId,
  type BackendPlugin, type FetchRecentArgs, type FetchRecentResult,
  type Handle, type MessageHandler, type Topic,
} from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import {
  configRisks, DEFAULT_HOMESERVER_URL, DEFAULT_PASSWORD, DEFAULT_SERVER_NAME,
  type MatrixBackendConfig, syncDeadlineMs, validateConfig,
} from './config.js';
import { emptyWindowCursor, requireLimit } from './cursor.js';
import { reportLoopCrash, reportSyncFailure, syncRetryDelayMs } from './diagnostics.js';
import { liveKey, MatrixParking } from './park.js';
import { INCREMENTAL_TIMELINE_LIMIT, returnedTooFast, SYNC_IDLE_PACE_MS } from './timeline.js';
import {
  type Boundary, eventToMessage, type MessageEvent, nextBatchOf, positionBoundaryOf,
  positioningBatchOf, ROOM_START, syncFilterParam, type SyncResponse, TOPIC_KEY,
} from './wire.js';

export { sanitizeAlias } from './alias.js';
export { readRetryAfter } from './wire.js';
export {
  MAX_SYNC_TIMEOUT_MS, type MatrixBackendConfig, ROOM_PRESETS, type RoomPreset, syncDeadlineMs,
} from './config.js';

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
export class MatrixPlugin extends MatrixParking implements BackendPlugin {
  private txnCounter = 0;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as MatrixBackendConfig;
    // Keep the validation ahead of the stand-down, so that a refused config leaves a working
    // connection running instead of tearing it down on the way to a load error.
    validateConfig(cfg);
    this.generation++;
    // Keep the credential cleared BEFORE `baseUrl` moves, so that homeserver A's bearer token can
    // never reach homeserver B — neither on the login request nor on the seam calls that follow a
    // login which failed.
    this.standDown();
    this.baseUrl = (cfg.homeserver_url ?? DEFAULT_HOMESERVER_URL).replace(/\/+$/, '');
    this.serverName = cfg.server_name ?? DEFAULT_SERVER_NAME;
    this.user = cfg.user ?? 'parley';
    this.password = cfg.password ?? DEFAULT_PASSWORD;
    this.syncTimeoutMs = cfg.sync_timeout_ms ?? 25_000;
    this.roomPreset = cfg.room_preset ?? 'private_chat';
    this.invite = cfg.invite ?? [];
    this.sharedLocalpart = cfg.shared_room;
    this.stopped = false;

    for (const risk of configRisks(cfg)) console.warn(`[parley-matrix] SECURITY: ${risk}`);

    const res = await this.http('POST', '/_matrix/client/v3/login', {
      unauthenticated: true,
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
    this.standDown();
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
    const limit = requireLimit(args.limit, args.topic);
    // `blockMs` is declared on the seam with no bound, and BOTH parks below — the one waiting for a
    // peer to provision the room and the one waiting for an event in it — end only by comparing
    // against this deadline. Keep the finiteness arm, so that a budget which is neither `> 0` nor
    // `<= 0` cannot leave every one of those comparisons false: `Infinity` never lets a park stop,
    // and `NaN` also collapses its slice to a bare tick, turning the wait into a request storm.
    const asked = args.blockMs ?? 0;
    const budgetMs = Number.isFinite(asked) ? asked : 0;
    const deadline = Date.now() + budgetMs;
    // Park for the room only when the answer would otherwise be an EMPTY page: the seam blocks on an
    // empty window, not on provisioning, so a topic whose room already exists must not spend the
    // budget re-resolving it.
    const roomId =
      (await this.existingRoom(args.topic, generation)) ??
      (budgetMs > 0 ? await this.roomForRead(args.topic, deadline, generation) : undefined);
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
    let nextBatch = positioningBatchOf(positioned.next_batch);
    // Keep this boundary read from the SAME response as `nextBatch`, so that a `limited`-burst
    // {@link backfill} stops EXACTLY at the subscription position: a boundary read one round-trip
    // later swallows everything that landed in between, and one read earlier pages back past the
    // position into PRE-subscription history and leaks it as live events.
    let boundary: Boundary | undefined = positionBoundaryOf(positioned, roomId);
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
          let recovered: MessageEvent[] = [];
          if (
            timeline?.limited === true &&
            timeline.prev_batch !== undefined &&
            boundary !== undefined
          ) {
            try {
              recovered = await this.backfill(
                roomId,
                topic,
                timeline.prev_batch,
                boundary === ROOM_START ? undefined : boundary,
                new Set(events.map((e) => e.event_id)),
              );
            } catch {
              /* backfill is best-effort; anything missed stays reachable via fetchRecent catch-up */
            }
          }
          for (const e of [...recovered, ...events.filter((e) => this.belongs(e, topic))]) {
            boundary = e.event_id;
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
          // Keep the ladder on the INTERRUPTIBLE sleep, so that a `disconnect()` landing in a
          // backoff ends it at the abort: a plain timer of up to SYNC_RETRY_MAX_MS survives the
          // teardown per subscribed topic and pins the event loop for the rest of its delay.
          await this.interruptibleDelay(syncRetryDelayMs(consecutiveFailures));
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
      // Keep the returned value attached rather than awaited, so that an `async` handler — which the
      // seam's `=> void` return type does not forbid — can neither end the bridge process with an
      // unhandled rejection nor serialise this loop behind one that never settles.
      void Promise.resolve(handler(message)).catch(() => undefined);
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
