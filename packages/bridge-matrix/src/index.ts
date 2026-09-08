import {
  asBackendMsgId, type BackendConfig, type BackendIdentity, type BackendMsgId,
  assertBlockMsUnsupported,
  type BackendPlugin, type FetchRecentArgs, type FetchRecentResult,
  type Handle, type MessageHandler, safeDeliver, type Topic,
} from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import {
  configRisks, DEFAULT_HOMESERVER_URL, DEFAULT_PASSWORD, DEFAULT_SERVER_NAME,
  type MatrixBackendConfig, syncDeadlineMs, validateConfig,
} from './config.js';
import { emptyWindowCursor, requireLimit } from './cursor.js';
import {
  membershipLost, reportLoopCrash, syncFailureReporter, syncRetryDelayMs,
} from './diagnostics.js';
import {
  INCREMENTAL_TIMELINE_LIMIT, MatrixTimeline, returnedTooFast, SYNC_IDLE_PACE_MS,
} from './timeline.js';
import {
  adoptedString, eventToMessage, membershipLossOf, type MessageEvent, nextBatchOf, positioningBatchOf,
  syncFilterParam, type SyncResponse, TOPIC_KEY,
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
export class MatrixPlugin extends MatrixTimeline implements BackendPlugin {
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

    const path = '/_matrix/client/v3/login';
    const res = await this.http('POST', path, {
      unauthenticated: true,
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: this.user },
        password: this.password,
      },
    });
    const json = (await res.json()) as Record<string, unknown> | null;
    // Keep the credential adopted only through the guard, so that a 200 carrying none leaves this
    // `connect()` REJECTED rather than resolved: the `standDown()` above has already cleared the
    // token, and a resolved connect with no token is a plugin whose every later seam call fails
    // blaming a disconnect that never happened.
    const call = `POST ${path} to ${this.baseUrl}`;
    this.token = adoptedString(json?.access_token, 'access_token', call);
    this.userId = typeof json?.user_id === 'string' ? json.user_id : undefined;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.standDown();
  }

  async post(
    topic: Topic,
    _identity: Handle,
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
    const json = (await res.json()) as Record<string, unknown> | null;
    return asBackendMsgId(
      adoptedString(json?.event_id, 'event_id', `PUT .../rooms/${roomId}/send/m.room.message`),
    );
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    assertBlockMsUnsupported('parley-matrix', args.blockMs);
    const generation = this.generation;
    const limit = requireLimit(args.limit, args.topic);
    const roomId = await this.existingRoom(args.topic, generation);
    // A topic nobody has posted to has no room yet, and a read never provisions one; the empty page
    // an absent room answers with carries a cursor that replays from the room's first visible event.
    if (roomId === undefined) {
      const nextCursor = emptyWindowCursor(undefined, args.since, this.isStale(generation));
      return { messages: [], nextCursor };
    }

    if (args.since === undefined) {
      return this.recentWindow(roomId, args.topic, limit, generation, undefined);
    }
    return this.fetchSince(roomId, args.topic, args.since, limit, generation);
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
    // The initial position asks for `timeline.limit: 1`: nothing it carries is ever delivered, so
    // the smallest legal snapshot is the cheapest way to reach a `next_batch`.
    const initParam = syncFilterParam(roomId, 1);
    const incParam = syncFilterParam(roomId, INCREMENTAL_TIMELINE_LIMIT);

    // Establish the resume position BEFORE returning, so a post immediately after subscribe()
    // resolves is guaranteed to land in a subsequent sync (positioning is awaited).
    const initial = await this.http('GET', `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`, {
      deadlineMs: syncDeadlineMs(0),
    });
    const positioned = (await initial.json()) as SyncResponse;
    let nextBatch = positioningBatchOf(positioned.next_batch);
    if (this.isStale(generation)) return;

    const loop = async (): Promise<void> => {
      let consecutiveFailures = 0;
      const reportSyncFailure = syncFailureReporter();
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
          const lost = membershipLossOf(json, roomId);
          // Keep this ahead of the token advance, so that a removal the homeserver reports in ONE
          // delta is re-read on every retry: past it the room is simply absent from every later
          // `/sync`, which is indistinguishable from an idle one, and the ladder below would report
          // once and then poll a dead topic in silence at full rate forever.
          if (lost !== undefined) throw membershipLost(roomId, lost);
          const events = json.rooms?.join?.[roomId]?.timeline?.events ?? [];
          const mine = events.filter((e) => this.belongs(e, topic));
          // Keep the token advance AHEAD of every delivery, so that a `/sync` this loop cannot
          // resume past is thrown on before its events reach a handler rather than after: past that
          // point the retry re-reads the same delta, and a second delivery is one the contract
          // forbids outright.
          nextBatch = nextBatchOf(json.next_batch, nextBatch, events.length);
          // A burst wider than the per-sync cap arrives TRUNCATED, and the events the homeserver
          // dropped from it are left to catch-up: push is a SUBSET of the post-subscribe tail
          // (DESIGN §6). What this loop still owes is that every event it DOES carry goes out once,
          // in timeline order, and that none of it predates the subscription.
          for (const e of mine) this.deliver(topic, e, handler);
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

  /** Hand one event to a subscribe handler. */
  private deliver(topic: Topic, e: MessageEvent, handler: MessageHandler): void {
    safeDeliver(handler, eventToMessage(topic, e));
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }
}
