import {
  asBackendMsgId,
  asCursor,
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
  type Topic,
} from '@sharptrick/parley-core';
import { delay, fetchWithRetry, plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import { resolveConfig, type ZulipConfig } from './config.js';
import {
  blockedFetchPause, budgetedDeadlineMs, longPollDeadlineMs, loopBackoffMs, reportsLoopFailure,
} from './pacing.js';
import {
  asArray, type EventsResponse, MAX_MESSAGES_PER_FETCH, pageAnchor, type RealmMember,
  readRetryAfter, requireSendableBody, requireWireTopic, type ZulipMessage, zulipToMessage,
} from './wire.js';

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
   * the loop re-checks shutdown each interval. Un-acked events survive the abort. Default 25000,
   * clamped to the bounds the README's config table publishes; a non-positive or non-numeric value
   * is a `connect()` error.
   */
  events_timeout_ms?: number;
}

interface QueueState {
  queueId: string;
}

/**
 * What a narrowed history read is bound to: the connection GENERATION that issued it, plus the
 * caller's own abort and deadline where it has them. Every read carries a generation, so that a
 * paginated one cannot fetch its later pages from whatever server the plugin is connected to by
 * then — the pages would be one window in two id spaces.
 */
interface ReadOpts {
  generation: number;
  signal?: AbortSignal;
  deadline?: number;
}

interface TopicWaiters {
  readonly wakes: Set<() => void>;
  healthy: number;
}

/**
 * A single bounded wait for "a message may have landed on this topic", however it is obtained.
 * Keep `release` synchronous, so that no teardown a wake owns can run inside the caller's `blockMs`.
 */
interface Wake {
  readonly waited: Promise<void>;
  readonly release: () => void;
}

/** Milliseconds a best-effort teardown request may take before it is abandoned. */
const TEARDOWN_TIMEOUT_MS = 2000;

/**
 * Messages a single gap-fill history read asks for. Exported so a test's dead-window sizes stay
 * derived from it and cannot stop straddling a page boundary if it changes.
 */
export const GAP_FILL_PAGE = 500;

/**
 * Records the pre-subscribe watermark probe reads. Keep it a WINDOW rather than a single record, so
 * that an unusable newest record cannot hide the topic's real tail: the probe would then have to
 * navigate past it by that record's own bad id, land nowhere, and read an empty topic — arming a
 * gap-fill that replays the entire history through the live handler.
 */
export const TAIL_PROBE_PAGE = 100;

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
 * Topic isolation is only as strong as the server's message-move policy — see README, "The one
 * inexactness: topics are mutable".
 */
export class ZulipPlugin implements BackendPlugin {
  private cfg: ZulipConfig = resolveConfig({});
  private connected = false;
  private stopped = false;
  /**
   * Bumped by every `connect`/`disconnect`. A push loop captures it at subscribe time and stops
   * the moment it changes, so a loop parked in a backoff across a disconnect cannot be resurrected
   * by the next `connect()` and replay into a handler whose subscription is gone.
   */
  private generation = 0;
  /** Aborted by `disconnect`, so a loop's in-flight history read cannot outlive its subscription. */
  private teardown = new AbortController();
  /** Push loops still running, awaited by `disconnect` so no handler can fire after it resolves. */
  private readonly loopExits = new Set<Promise<void>>();
  /** In-flight event long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  /** Live queues (one per subscribe), so disconnect can best-effort delete them server-side. */
  private readonly queues = new Set<QueueState>();
  /**
   * Topics with a live `subscribe` loop → its wake callbacks for blocking `fetchRecent` calls
   * piggybacking on that loop's already-registered event queue. `healthy` counts only the loops on
   * the topic that can still deliver, so a blocked fetch can never park behind a subscription that
   * will not wake it; the loop fires the callbacks on a delivery so a blocked fetch re-queries
   * WITHOUT opening a second event queue for the topic. A loop can only end by the connection
   * ending, so it is `disconnect()` that empties this and releases whoever is parked here.
   */
  private readonly waiters = new Map<Topic, TopicWaiters>();
  /**
   * Wire topic → the one Parley topic that claimed it by WRITING there, so a case-fold collision
   * fails fast. Only `post` and `subscribe` claim: a read addresses history it did not create, and a
   * registry a read can write is a namespace any caller-supplied topic name can take hostage.
   */
  private readonly claimedWireTopics = new Map<string, Topic>();
  /**
   * Releases for every in-flight timed wait — blocking-fetch waits of both kinds and a push loop's
   * failure backoff — fired on `disconnect()` so each ends immediately with no leaked timer or
   * listener, the same teardown discipline as the event-poll controllers.
   */
  private readonly pendingAborts = new Set<() => void>();
  /**
   * Queue deletions detached from a caller's deadline, awaited by `disconnect()` so best-effort
   * cleanup still finishes without ever running inside a `fetchRecent`'s `blockMs`.
   */
  private readonly pendingDeletes = new Set<Promise<void>>();

  /**
   * A `connect()` over a live connection tears that one down FIRST, against the config it was made
   * with. Keep the teardown here and the validation ahead of it, so that no per-connection registry
   * — subscribe loops, event queues, blocking-fetch waiters — can address the new connection with
   * the old one's state, and a rejected config leaves the live connection running.
   */
  async connect(config: BackendConfig): Promise<void> {
    const cfg = resolveConfig(config);
    if (this.connected) await this.disconnect();
    this.cfg = cfg;
    this.claimedWireTopics.clear();
    this.generation++;
    this.teardown = new AbortController();
    this.stopped = false;
    this.connected = true;

    if (cfg.usesDefaultApiKey) {
      console.warn(
        '[parley-zulip] SECURITY: connecting with the built-in default API key ' +
          "('parley-api-key'). Set backend_config.api_key to a real secret; a network-reachable " +
          'Zulip bot provisioned with this key is world-readable/injectable.',
      );
    }
    const plaintext = plaintextRemoteOrigin(cfg.baseUrl);
    if (plaintext !== undefined) {
      console.warn(
        `[parley-zulip] SECURITY: site_url ${plaintext} is plaintext http:// to a non-loopback ` +
          'host, so the bot email and api_key travel the network as an unencrypted HTTP Basic ' +
          'header on every request. Use https://.',
      );
    }
  }

  /**
   * Tears down every subscription as well as the connection: the generation bump orphans each push
   * loop, the aborts end whatever it is parked in, and the loops are then awaited before teardown
   * returns. Keep the generation bump ahead of those awaits, so that a loop outliving its bounded
   * wait still cannot deliver into a subscription that is already gone.
   */
  async disconnect(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.claimedWireTopics.clear();
    this.teardown.abort();
    for (const abort of this.pendingAborts) abort();
    this.pendingAborts.clear();
    this.waiters.clear();
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    const exits = [...this.loopExits];
    this.loopExits.clear();
    await Promise.race([Promise.allSettled(exits), delay(TEARDOWN_TIMEOUT_MS)]);
    const queues = [...this.queues];
    this.queues.clear();
    await Promise.allSettled(queues.map((q) => this.deleteQueue(q.queueId)));
    await Promise.allSettled([...this.pendingDeletes]);
    this.connected = false;
  }

  /**
   * Best-effort server-side queue cleanup — Zulip GCs idle queues after ~10 min anyway, so keep
   * the timeout, so that an unreachable-but-not-refusing server cannot stall shutdown past the
   * container's grace period.
   */
  private async deleteQueue(queueId: string): Promise<void> {
    await this.http('DELETE', '/api/v1/events', {
      query: { queue_id: queueId },
      signal: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  /**
   * Drop a queue the plugin has stopped using without making anyone wait for the round trip. Keep
   * it off every caller's path, so that a slow or black-holed server cannot spend a `fetchRecent`'s
   * `blockMs` — or a push loop's recovery latency — on cleanup.
   */
  private deleteQueueDetached(queueId: string): void {
    const done = this.deleteQueue(queueId);
    this.pendingDeletes.add(done);
    void done.finally(() => this.pendingDeletes.delete(done));
  }

  /**
   * An abort that fires at `deadline` or on `disconnect()`, whichever comes first, with the
   * bookkeeping teardown needs. `done()` releases the timer and the registrations.
   */
  private deadlineAbort(deadline: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    this.pendingAborts.add(abort);
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      done: (): void => {
        clearTimeout(timer);
        this.pendingAborts.delete(abort);
        this.controllers.delete(controller);
      },
    };
  }

  /**
   * `POST /api/v1/messages` (form-encoded — Zulip rejects JSON bodies) → the new message `id`.
   * `identity` is informational only: Zulip stamps the sender from the authenticated bot account
   * (see README "Multiple concurrent sessions"). `opts.inReplyTo` is ignored: Zulip threads by topic.
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const generation = this.generation;
    const body = requireSendableBody(content);
    const res = await this.http('POST', '/api/v1/messages', {
      form: { type: 'stream', to: this.cfg.stream, topic: this.claimWireTopic(topic), content: body },
    });
    const id = ((await res.json()) as { id?: number } | null)?.id;
    this.assertGeneration(generation);
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        `Zulip POST /api/v1/messages answered without a usable message id (got ${JSON.stringify(id)})`,
      );
    }
    return asBackendMsgId(String(id));
  }

  /**
   * `GET /api/v1/messages` narrowed to `<stream, topic>`. With `since`: `anchor=<since>` +
   * `include_anchor=false` + `num_after=<limit>` — the anchor itself is excluded, making `since`
   * strictly exclusive server-side. Without: `anchor=newest` + `num_before=<limit>` for the most
   * recent window. Zulip returns messages ascending by id — no client-side reordering needed.
   *
   * `blockMs` is a ceiling on the WHOLE call, not just on the wait: every request the call makes
   * carries the budget that is left, so none of them can spend it on a rate-limit hint.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const generation = this.generation;
    const limit = args.limit ?? 100;
    const blockMs = args.blockMs ?? 0;
    const deadline = blockMs > 0 ? Date.now() + blockMs : undefined;
    let { messages } = await this.readWindow(args.topic, args.since, limit, { generation, deadline });
    if (messages.length === 0 && args.since !== undefined && deadline !== undefined) {
      messages = await this.blockingFetch(args.topic, args.since, limit, deadline, generation);
    }
    const nextCursor = messages.at(-1)?.cursor ?? args.since ?? asCursor('0');
    return { messages, nextCursor };
  }

  /**
   * Wait until `deadline` for a message strictly after `since`, then re-run the normal exclusive
   * query and return it (possibly empty, with a cursor === `since`, which is correct at timeout).
   *
   * Each pass arms the best wake primitive currently available ({@link armWake}), re-checks history
   * with that primitive already live, then waits on it. Re-evaluating every pass is what keeps the
   * wait honest when the backend's state changes mid-flight: a `subscribe` loop that falls into
   * failure backoff, re-registration or exit stops being a usable wake source, and the next pass
   * degrades to a dedicated queue rather than parking out the caller's whole budget behind it.
   */
  private async blockingFetch(
    topic: Topic,
    since: Cursor,
    limit: number,
    deadline: number,
    generation: number,
  ): Promise<Message[]> {
    const read = async (): Promise<Message[]> =>
      (await this.readWindow(topic, since, limit, { generation, deadline })).messages;
    for (let attempt = 0; !this.stopped && Date.now() < deadline; attempt++) {
      const wake = await this.armWake(topic, deadline, blockedFetchPause(attempt), generation);
      try {
        const raced = this.stopped ? [] : await read();
        if (raced.length > 0) return raced;
        await wake.waited;
      } finally {
        wake.release();
      }
      if (this.stopped) return [];
      const got = await read();
      if (got.length > 0) return got;
    }
    return [];
  }

  /**
   * The best wake edge available for `topic` right now, already armed and bounded by `deadline`:
   * a live `subscribe` loop's queue when one is draining the topic (never open a second queue for
   * it), otherwise a short-lived dedicated queue of our own.
   *
   * Keep the piggyback registration on the synchronous path — before this function's first `await`
   * — so that a wake fired between the caller's history read and the registration cannot be lost.
   * Keep the disconnect check here rather than in each arm, so that neither can be reached after
   * teardown and neither has to re-check for it.
   */
  private async armWake(
    topic: Topic,
    deadline: number,
    pauseMs: number,
    generation: number,
  ): Promise<Wake> {
    if (this.stopped || this.generation !== generation) {
      return { waited: Promise.resolve(), release: () => undefined };
    }
    const live = this.waiters.get(topic);
    if (live !== undefined && live.healthy > 0) {
      return this.armSubscriptionWaiter(topic, deadline - Date.now());
    }
    return this.armDedicatedQueue(topic, deadline, pauseMs);
  }

  /**
   * Synchronously register a wake callback on the live `subscribe` loop for `topic`, resolving when
   * the loop signals a message, when it stops being able to signal one, at `blockMs`, or on
   * disconnect.
   */
  private armSubscriptionWaiter(topic: Topic, blockMs: number): Wake {
    const set = this.waiters.get(topic)?.wakes;
    let finish!: () => void;
    const waited = new Promise<void>((resolve) => {
      let done = false;
      finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set?.delete(finish);
        this.pendingAborts.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, blockMs));
      this.pendingAborts.add(finish);
      set?.add(finish);
    });
    return { waited, release: () => finish() };
  }

  /**
   * No usable subscription for this topic: register a short-lived narrowed event queue and issue
   * one `/api/v1/events` long-poll bounded by the remaining budget. When the queue or the poll is
   * unavailable — the whole reason a caller can end up here — the wait degrades to a bounded pause
   * so the caller's next history read still lands inside its budget instead of at the end of it.
   */
  private async armDedicatedQueue(topic: Topic, deadline: number, pauseMs: number): Promise<Wake> {
    let reg: { queue_id: string; last_event_id: number };
    // Bound the registration by the caller's deadline too: a slow or black-holed register is
    // otherwise a wait the caller never asked for, ahead of the wait it did.
    const bound = this.deadlineAbort(deadline);
    try {
      reg = await this.register(this.wireTopic(topic), bound.signal, budgetedDeadlineMs(deadline));
    } catch {
      return { waited: this.pause(deadline, pauseMs), release: () => undefined };
    } finally {
      bound.done();
    }
    const state: QueueState = { queueId: reg.queue_id };
    this.queues.add(state);
    return {
      waited: this.pollForWake(reg, deadline, pauseMs),
      release: () => {
        this.queues.delete(state);
        this.deleteQueueDetached(reg.queue_id);
      },
    };
  }

  /**
   * One `/api/v1/events` long-poll on a dedicated queue, resolving on the wake edge (a matching
   * message), at `deadline`, or on disconnect. The events themselves are discarded — the caller
   * re-reads history — so an outright failure only costs the caller a bounded pause.
   *
   * Keep the pace on EVERY answer that carries no message, not just on a non-2xx: a poll answered
   * at once with a heartbeat, with no events, or by a server ignoring `dont_block=false` is a wake
   * that never came, and each pass mints and drops a fresh event queue.
   */
  private async pollForWake(
    reg: { queue_id: string; last_event_id: number },
    deadline: number,
    pauseMs: number,
  ): Promise<void> {
    if (this.stopped || deadline - Date.now() <= 0) return;
    const bound = this.deadlineAbort(deadline);
    try {
      const res = await this.http('GET', '/api/v1/events', {
        query: {
          queue_id: reg.queue_id,
          last_event_id: String(reg.last_event_id),
          dont_block: 'false',
        },
        signal: bound.signal,
        allowStatuses: [400],
        deadlineMs: budgetedDeadlineMs(deadline),
      });
      const woke =
        res.ok &&
        asArray(((await res.json()) as EventsResponse | null)?.events).some(
          (e) => e?.type === 'message',
        );
      if (!woke) await this.pause(deadline, pauseMs);
    } catch {
      if (!bound.signal.aborted) await this.pause(deadline, pauseMs);
    } finally {
      bound.done();
    }
  }

  /** A pause that never outlives `deadline` or a disconnect. */
  private pause(deadline: number, ms: number): Promise<void> {
    return this.interruptibleDelay(Math.min(ms, deadline - Date.now()));
  }

  /** `delay` that also ends on `disconnect()`, so that teardown never waits out a backoff. */
  private async interruptibleDelay(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.pendingAborts.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.pendingAborts.add(done);
      if (this.stopped) done();
    });
  }

  /** Release every blocking `fetchRecent` piggybacking on `topic`'s live subscribe loop(s). */
  private wake(topic: Topic): void {
    const live = this.waiters.get(topic);
    if (live !== undefined) for (const wake of [...live.wakes]) wake();
  }

  /**
   * Live path = a registered per-topic event queue + `GET /api/v1/events` long-poll loop
   * (DESIGN §9 — genuine events, not a poll timer). `POST /api/v1/register` narrowed to
   * `<stream, topic>` is the queue's birth: only messages sent after registration enter it, and it
   * is awaited before subscribe resolves, so a post immediately after subscribe() is guaranteed
   * to be queued. Zulip delivers our own sends to our own queue, matching the seam's echo
   * expectation.
   *
   * The delivery watermark is probed BEFORE register and the handshake window is then closed by an
   * armed gap-fill, so every message newer than the probe is delivered EXACTLY once. A probe that
   * cannot establish a tail at all ({@link probeTail}) arms no gap-fill: with no watermark to replay
   * FROM, the only honest window is the queue's own.
   *
   * Queue GC: Zulip garbage-collects queues after ~10 min idle and then answers
   * `BAD_EVENT_QUEUE_ID`; recovery re-registers and arms the same gap-fill, which `lastDeliveredId`
   * dedupes against the events the fresh queue then delivers.
   *
   * The loop is bound to the connection GENERATION it was born in: `disconnect()` bumps it, so a
   * loop parked anywhere — a long-poll, a backoff, a gap-fill — stops rather than resuming against
   * the next `connect()` and replaying into a torn-down subscription's handler.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const generation = this.generation;
    const signal = this.teardown.signal;
    const alive = (): boolean => !this.stopped && this.generation === generation;
    const wire = this.claimWireTopic(topic);
    let lastDeliveredId = await this.probeTail(topic, generation);
    const reg = await this.register(wire);
    const state: QueueState = { queueId: reg.queue_id };
    if (!alive()) {
      await this.deleteQueue(reg.queue_id);
      return;
    }
    this.queues.add(state);
    // Advertise the topic as piggyback-able only now that every await is behind us and the loop is
    // about to run — a waiter set with no live loop behind it parks a blocking fetchRecent.
    const entry = this.waiters.get(topic) ?? { wakes: new Set<() => void>(), healthy: 0 };
    entry.healthy++;
    this.waiters.set(topic, entry);

    let lastEventId = reg.last_event_id;
    // Armed from the pre-register watermark so the register handshake window is replayed, and
    // re-armed by a queue GC; the top of the loop drains it, retrying until the read succeeds so a
    // transient failure can't leave a permanent push hole.
    let needsGapFillFrom: number | undefined = lastDeliveredId;
    let consecutiveFailures = 0;
    let degraded = false;
    /** Whether `state.queueId` has ever answered an events poll — the only proof push works. */
    let queueProven = false;
    /**
     * Whether the next poll asks the server to PARK. Cleared by a cap so the poll after one asks for
     * whatever is queued right now: our own cap aborts a healthy idle park and a black-holed one
     * without a byte either way, and a non-blocking poll — which a live server must answer at once —
     * is the only thing that tells them apart.
     */
    let parking = true;
    const deliver = (m: Message): void => {
      if (!alive()) return;
      try {
        handler(m);
      } catch {
        /* handler is best-effort; never break the loop (DESIGN §6) */
      }
    };
    /** Stop advertising the topic as piggyback-able and release whoever is already parked on it. */
    const degrade = (): void => {
      if (degraded) return;
      degraded = true;
      entry.healthy--;
      this.wake(topic);
    };
    /** Advertise the topic as piggyback-able again — the loop can deliver, by whatever route. */
    const promote = (): void => {
      if (!degraded) return;
      degraded = false;
      entry.healthy++;
    };
    const backoff = async (reason: string): Promise<void> => {
      degrade();
      consecutiveFailures++;
      if (reportsLoopFailure(consecutiveFailures)) {
        console.error(
          `[parley-zulip] push loop for topic ${JSON.stringify(topic)} has failed ` +
            `${consecutiveFailures}× in a row (${reason}); still retrying, backing off`,
        );
      }
      await this.interruptibleDelay(loopBackoffMs(consecutiveFailures));
    };

    /** One pass of the push loop; `false` ends it. */
    const advance = async (): Promise<boolean> => {
      // Drain a pending gap-fill BEFORE polling the fresh queue — retry the gap (not the events
      // poll) until it clears, advancing `lastDeliveredId`/`needsGapFillFrom` per delivered page
      // so a mid-pagination throw keeps its progress and a retry resumes past delivered pages.
      if (needsGapFillFrom !== undefined) {
        try {
          lastDeliveredId = await this.gapFill(
            topic,
            needsGapFillFrom,
            deliver,
            (id) => {
              lastDeliveredId = id;
              needsGapFillFrom = id;
              this.wake(topic); // gap-fill is also a delivery — release blocked fetchers
            },
            { generation, signal },
          );
          needsGapFillFrom = undefined; // gap closed — resume normal polling
          promote();
        } catch {
          if (!alive()) return false;
          await backoff('gap-fill history read failed');
        }
        return true; // re-check liveness / re-attempt before polling the fresh queue
      }
      const controller = new AbortController();
      this.controllers.add(controller);
      // Client-side long-poll cap so the loop re-checks shutdown; un-acked events survive.
      let capped = false;
      const timer = setTimeout(() => {
        capped = true;
        controller.abort();
      }, this.cfg.eventsTimeoutMs);
      const parked = parking;
      let json: EventsResponse;
      try {
        const res = await this.http('GET', '/api/v1/events', {
          query: {
            queue_id: state.queueId,
            last_event_id: String(lastEventId),
            dont_block: parked ? 'false' : 'true',
          },
          signal: controller.signal,
          allowStatuses: [400],
          deadlineMs: longPollDeadlineMs(this.cfg.eventsTimeoutMs),
        });
        json = ((await res.json()) as EventsResponse | null) ?? {};
      } catch {
        if (!alive()) return false;
        // Keep the cap of a PARKED poll off the failure path, so that the healthy idle cap is never
        // escalated into backoff on every long-poll cycle. A poll that asked for what is already
        // queued has no such excuse: capping THAT one is a server producing no bytes at all.
        if (capped && parked) parking = false;
        else {
          await backoff(
            capped
              ? 'an events poll asking for the queue as it stands produced no response'
              : 'events long-poll failed',
          );
        }
        return true;
      } finally {
        clearTimeout(timer);
        this.controllers.delete(controller);
      }
      parking = true;
      if (!alive()) return false;
      if (json.result === 'error') {
        if (json.code === 'BAD_EVENT_QUEUE_ID') {
          // Re-register the queue, then ARM the pending gap — the top of the loop drains it.
          try {
            const superseded = state.queueId;
            const fresh = await this.register(wire, signal);
            this.deleteQueueDetached(superseded);
            state.queueId = fresh.queue_id;
            lastEventId = fresh.last_event_id;
            needsGapFillFrom = lastDeliveredId;
            // A queue rejected before it ever answered a poll is a FAILING recovery, not a
            // completed one: pace it, so that a server rejecting every queue it mints cannot be
            // flooded with fresh registrations by its own error.
            if (queueProven) promote();
            else await backoff('a freshly registered event queue was rejected as stale');
            queueProven = false;
          } catch {
            if (!alive()) return false;
            await backoff('re-register after queue GC failed');
          }
        } else {
          await backoff(`events poll returned ${json.code ?? 'an error'}`);
        }
        return true;
      }
      queueProven = true;
      let sawMessage = false;
      let acked = false;
      for (const ev of asArray(json.events)) {
        if (typeof ev?.id === 'number' && ev.id > lastEventId) {
          lastEventId = ev.id; // ack heartbeats too
          acked = true;
        }
        if (ev?.type !== 'message') continue;
        const m = zulipToMessage(topic, ev.message);
        if (m === undefined) continue;
        sawMessage = true; // a message landed on this topic — release any blocked fetchers
        const id = Number(m.backendMsgId);
        if (lastDeliveredId !== undefined && id <= lastDeliveredId) continue; // gap-filled — dedup
        lastDeliveredId = id;
        deliver(m);
      }
      // Wake piggybacking blocking-fetch waiters; they re-query and return whatever is newly past
      // their `since`. A spurious wake only ends a wait early, which core covers by re-polling.
      if (sawMessage) this.wake(topic);
      // Grade the answer on whether it MOVED the queue, not on whether it carried bytes: a parked
      // poll the ack cannot advance past is re-issued unchanged forever. Keep it paced, so that a
      // server ignoring `dont_block=false` — or answering with no events, stale ids, or ids that
      // are not numbers at all — cannot turn the loop into a request flood that grades itself
      // healthy. A live queue's own heartbeat carries a fresh id, so an idle queue stays off this.
      if (parked && !acked) {
        await backoff('an events poll that asked to park answered without advancing the queue');
        return true;
      }
      // Keep the failure-escalation reset here and NOT in `promote`, so that a recovery step that
      // always succeeds — a gap-fill read, a re-register — cannot cancel the backoff protecting the
      // server from a cycle that fails at the step after it.
      consecutiveFailures = 0;
      promote();
      return true;
    };

    const loop = async (): Promise<void> => {
      while (alive()) {
        // Keep the catch around the WHOLE pass, so that no throw a server's payload can provoke —
        // outside the awaits that guard themselves — ends push for this topic or escapes as an
        // unhandled rejection that takes the MCP process with it.
        try {
          if (!(await advance())) break;
        } catch (err) {
          if (!alive()) break;
          await backoff(`an unexpected push-loop failure: ${String(err)}`);
        }
      }
    };
    // Keep this catch even with nothing left to report, so that a throw from the loop's own failure
    // reporting cannot reach Node as an uncaught exception and take the MCP stdio server down.
    const running = loop().catch(() => undefined);
    this.loopExits.add(running);
    void running.finally(() => this.loopExits.delete(running));
  }

  /**
   * Real account lookup (DESIGN §4): `GET /api/v1/users` → `backendRef` = the Zulip `user_id`.
   * `email` is unique per realm; `full_name` is a self-service, NON-unique display name and is only
   * consulted when no active member carries the handle as an email. Both branches resolve only on
   * exactly ONE active match: a tie or a deactivated-only match degrades to the string convention
   * rather than letting whoever the server happens to list first answer for the handle, and any
   * error degrades the same way.
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    const generation = this.generation;
    let members: RealmMember[] = [];
    try {
      const res = await this.http('GET', '/api/v1/users');
      members = asArray(((await res.json()) as { members?: RealmMember[] } | null)?.members);
    } catch {
      /* lookup is best-effort; fall through to the string convention */
    }
    this.assertGeneration(generation);
    const active = members.filter((u) => u?.is_active !== false);
    const byEmail = active.filter((u) => u?.email === handle);
    if (byEmail.length === 1) return { handle, backendRef: String(byEmail[0]!.user_id) };
    if (byEmail.length === 0) {
      const byName = active.filter((u) => u?.full_name === handle);
      if (byName.length === 1) return { handle, backendRef: String(byName[0]!.user_id) };
    }
    return { handle, backendRef: handle };
  }

  /**
   * {@link requireWireTopic}, plus the collision two Parley topics differing only in case would
   * otherwise share: Zulip matches topics case-insensitively, so the second one to claim a wire
   * name would silently be reading and writing the first one's history.
   */
  private wireTopic(topic: Topic): string {
    const wire = requireWireTopic(topic);
    const claimed = this.claimedWireTopics.get(wire);
    if (claimed !== undefined && claimed !== topic) {
      throw new Error(
        `Zulip topic collision: Parley topics ${JSON.stringify(claimed)} and ` +
          `${JSON.stringify(topic)} both map to Zulip topic ${JSON.stringify(wire)} — Zulip ` +
          'matches topics case-insensitively, so they would share one history. Rename one.',
      );
    }
    return wire;
  }

  /**
   * The Zulip topic a WRITE addresses: `post`'s send and `subscribe`'s queue are the durable state a
   * case-fold collision would merge, so they are the only paths that claim the wire name. Keep reads
   * out of here, so that reading a case variant of a configured topic cannot make every later write
   * to that topic fail for the life of the process.
   */
  private claimWireTopic(topic: Topic): string {
    const wire = this.wireTopic(topic);
    this.claimedWireTopics.set(wire, topic);
    return wire;
  }

  /**
   * The id the live path may treat as already delivered: the newest USABLE message on `topic`, `0`
   * when the server showed no record at all, and `undefined` when it showed only records carrying
   * no usable id — a tail that cannot be established, and so one nothing may be replayed from.
   */
  private async probeTail(topic: Topic, generation: number): Promise<number | undefined> {
    const { messages, sawRecords } = await this.readWindow(topic, undefined, TAIL_PROBE_PAGE, {
      generation,
    });
    const newest = messages.at(-1);
    if (newest !== undefined) return Number(newest.backendMsgId);
    return sawRecords ? undefined : 0;
  }

  /**
   * The one narrowed read, used by fetchRecent, the tail probe AND the gap-fill after a queue GC.
   * Paginates so the seam's `limit` stays honest: Zulip rejects `num_before + num_after > 5000`
   * outright, so a larger caller limit is served as successive pages rather than propagated as a
   * 400. `sawRecords` reports whether the server showed any record AT ALL — which an empty message
   * list cannot tell you, because every record it showed may have been unusable.
   */
  private async readWindow(
    topic: Topic,
    since: Cursor | undefined,
    limit: number,
    opts: ReadOpts,
  ): Promise<{ messages: Message[]; sawRecords: boolean }> {
    const signal = opts.signal;
    const deadlineMs = opts.deadline === undefined ? undefined : budgetedDeadlineMs(opts.deadline);
    const narrow = JSON.stringify([
      { operator: 'stream', operand: this.cfg.stream },
      { operator: 'topic', operand: this.wireTopic(topic) },
    ]);
    const out: Message[] = [];
    let sawRecords = false;
    let remaining = Math.max(0, limit);
    let anchor = since === undefined ? 'newest' : String(since);
    let includeAnchor = since === undefined;
    while (remaining > 0) {
      const page = Math.min(remaining, MAX_MESSAGES_PER_FETCH);
      const query: Record<string, string> = {
        narrow,
        anchor,
        include_anchor: String(includeAnchor),
        num_before: since === undefined ? String(page) : '0',
        num_after: since === undefined ? '0' : String(page),
        apply_markdown: 'false', // raw content, not rendered HTML
      };
      const res = await this.http('GET', '/api/v1/messages', { query, signal, deadlineMs });
      const raw = asArray(((await res.json()) as { messages?: ZulipMessage[] } | null)?.messages);
      this.assertGeneration(opts.generation);
      sawRecords ||= raw.length > 0;
      const got = raw.flatMap((m) => zulipToMessage(topic, m) ?? []); // Zulip returns ascending by id
      if (got.length < raw.length) {
        console.warn(
          `[parley-zulip] dropped ${raw.length - got.length} of ${raw.length} records read from ` +
            `topic ${JSON.stringify(topic)}: no usable message id, so neither the dedup key nor ` +
            'the cursor can be derived',
        );
      }
      // Keep the unshift: pages from the newest anchor walk BACKWARDS, so appending would
      // return the window in descending page order.
      if (since === undefined) out.unshift(...got);
      else out.push(...got);
      remaining -= got.length;
      // Keep BOTH the termination and the next anchor on the RAW page, so that dropping records —
      // even every record of a page — cannot be mistaken for the end of history and silently
      // truncate the window a caller asked for.
      if (raw.length < page) break;
      const next = pageAnchor(since === undefined ? raw[0] : raw.at(-1), anchor, since === undefined);
      if (next === undefined) break;
      anchor = next;
      includeAnchor = false;
    }
    return { messages: out, sawRecords };
  }

  /** Register a `<stream, topic>`-narrowed message event queue; its birth is the topic's tail. */
  private async register(
    wireTopic: string,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<{ queue_id: string; last_event_id: number }> {
    const res = await this.http('POST', '/api/v1/register', {
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
   * Replay everything after `sinceId` through `handler`; returns the new last delivered id.
   * `onProgress` is invoked with the last delivered id after EACH page lands, so a caller retrying
   * a throwing gap-fill can resume past already-delivered pages instead of re-delivering them (the
   * history read at the top of the loop may throw on any non-2xx/network blip — the caller retries).
   */
  private async gapFill(
    topic: Topic,
    sinceId: number,
    deliver: MessageHandler,
    onProgress: (id: number) => void,
    opts: ReadOpts,
  ): Promise<number> {
    const page = GAP_FILL_PAGE;
    let cursor = asCursor(String(sinceId));
    for (;;) {
      // May throw (non-2xx / network blip / teardown) → the caller retries from `onProgress`.
      const { messages } = await this.readWindow(topic, cursor, page, opts);
      for (const m of messages) deliver(m);
      const last = messages.at(-1);
      if (last === undefined) return Number(cursor);
      cursor = last.cursor; // advance so a retry resumes past this delivered page
      onProgress(Number(cursor)); // report per-page progress — durable across a later throw
      if (messages.length < page) return Number(cursor);
    }
  }

  private require(): void {
    if (!this.connected) throw new Error('ZulipPlugin not connected — call connect() first');
  }

  /**
   * Refuse to carry on against a connection the caller did not address. Keep every seam call on this
   * after the awaits it makes, so that one parked in a request across a `disconnect()`/`connect()`
   * cannot resume on the NEXT connection — a cursor minted in one server's id space would then be
   * answered out of another server's history, and the caller would store the wrong space's id.
   */
  private assertGeneration(generation: number): void {
    if (this.generation === generation) return;
    throw new Error(
      'Zulip connection was replaced while this call was in flight, so it can no longer be ' +
        'answered from the connection it addressed. Reissue it.',
    );
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
      deadlineMs?: number;
    },
  ): Promise<Response> {
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
        isStopped: () => this.stopped,
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
        deadlineMs: opts?.deadlineMs,
      },
    );
  }
}
