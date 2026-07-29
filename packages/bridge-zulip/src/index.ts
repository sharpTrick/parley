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
  type Topic,
} from '@sharptrick/parley-core';
import { delay, fetchWithRetry, retryAfterFromHeader } from '@sharptrick/parley-net-util';

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
   * clamped to [{@link MIN_EVENTS_TIMEOUT_MS}, {@link MAX_EVENTS_TIMEOUT_MS}]; a non-positive or
   * non-numeric value is a `connect()` error.
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
 * Wake callbacks for blocking `fetchRecent` calls piggybacking on a topic's live `subscribe`
 * loop(s); `loops` counts the loops currently draining the topic and `healthy` counts those whose
 * event queue is actually live — a loop in failure backoff wakes nobody, so it does not count.
 */
interface TopicWaiters {
  readonly wakes: Set<() => void>;
  loops: number;
  healthy: number;
}

/** A single bounded wait for "a message may have landed on this topic", however it is obtained. */
interface Wake {
  readonly waited: Promise<void>;
  readonly release: () => void | Promise<void>;
}

/** `zerver/views/message_fetch.py`: `num_before + num_after > 5000` is a 400. */
const MAX_MESSAGES_PER_FETCH = 5000;

/** `zerver/lib/message.py` `MAX_TOPIC_NAME_LENGTH`: longer subjects are truncated on send. */
const MAX_TOPIC_NAME_LENGTH = 60;

/** Milliseconds a best-effort teardown request may take before it is abandoned. */
const TEARDOWN_TIMEOUT_MS = 2000;

/** Backoff bounds for a failing push loop, and how often a persistent failure is reported. */
const LOOP_BACKOFF_MIN_MS = 200;
const LOOP_BACKOFF_MAX_MS = 5000;
const LOOP_FAILURES_BEFORE_REPORT = 3;
const LOOP_FAILURE_REPORT_INTERVAL = 20;

/**
 * Bounds on the effective long-poll cap. Keep the floor, so that no `events_timeout_ms` a config
 * can carry turns the push loop into an unthrottled request flood against the operator's server.
 */
const MIN_EVENTS_TIMEOUT_MS = 250;
const MAX_EVENTS_TIMEOUT_MS = 600_000;
const DEFAULT_EVENTS_TIMEOUT_MS = 25_000;

/** Pace of a blocked `fetchRecent`'s retries while no live wake primitive is available. */
const BLOCKED_FETCH_RETRY_MS = 400;

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
 * TOPIC NAMESPACE: Zulip matches topics case-INsensitively (`subject__iexact` on reads, a
 * lower-cased compare on event-queue narrows) and truncates subjects to 60 characters on send, so
 * a Parley topic is mapped onto the wire by {@link ZulipPlugin.wireTopic}: case-folded (making
 * Parley's namespace 1:1 with Zulip's) and rejected outright when it cannot survive the round trip
 * — two Parley topics differing only in case, or a name over 60 characters, would otherwise share
 * or silently rewrite a history.
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
  private eventsTimeoutMs = DEFAULT_EVENTS_TIMEOUT_MS;
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
   * piggybacking on that loop's already-registered event queue. A topic key exists ONLY while at
   * least one loop is actually draining it, and its `healthy` count only while a loop can still
   * deliver, so a blocked fetch can never park behind a subscription that will not wake it; the
   * loop fires the callbacks on a delivery so a blocked fetch re-queries WITHOUT opening a second
   * event queue for the topic.
   */
  private readonly waiters = new Map<Topic, TopicWaiters>();
  /** Wire topic → the one Parley topic that claimed it, so a case-fold collision fails fast. */
  private readonly claimedWireTopics = new Map<string, Topic>();
  /**
   * Releases for every in-flight timed wait — blocking-fetch waits of both kinds and a push loop's
   * failure backoff — fired on `disconnect()` so each ends immediately with no leaked timer or
   * listener, the same teardown discipline as the event-poll controllers.
   */
  private readonly pendingAborts = new Set<() => void>();

  /**
   * Zulip auth is per-request HTTP Basic (`email:api_key`) — there is no session or token to
   * establish, so `connect` only validates and captures config. Every value that could otherwise
   * fail late (an unusable `site_url`, an empty `stream`) or fail silently (an `events_timeout_ms`
   * that makes the push loop hot) is rejected here, naming the offending key.
   */
  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as ZulipBackendConfig;
    this.baseUrl = requireHttpUrl(orDefault(cfg.site_url, 'http://127.0.0.1:9991'));
    this.email = requireNonEmpty('email', orDefault(cfg.email, 'parley-bot@localhost'));
    this.apiKey = requireNonEmpty('api_key', orDefault(cfg.api_key, 'parley-api-key'));
    this.stream = requireNonEmpty('stream', orDefault(cfg.stream, 'parley'));
    this.eventsTimeoutMs = requireEventsTimeout(cfg.events_timeout_ms);
    this.claimedWireTopics.clear();
    this.generation++;
    this.teardown = new AbortController();
    this.stopped = false;
    this.connected = true;

    if (cfg.api_key === undefined || this.apiKey === 'parley-api-key') {
      console.warn(
        '[parley-zulip] SECURITY: connecting with the built-in default API key ' +
          "('parley-api-key'). Set backend_config.api_key to a real secret; a network-reachable " +
          'Zulip bot provisioned with this key is world-readable/injectable.',
      );
    }
    if (isPlaintextRemote(this.baseUrl)) {
      console.warn(
        `[parley-zulip] SECURITY: site_url ${this.baseUrl} is plaintext http:// to a non-loopback ` +
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
   * `POST /api/v1/messages` (form-encoded — Zulip rejects JSON bodies) → the new message `id`.
   * `identity` is informational only: Zulip stamps the sender from the authenticated bot account
   * (see README "Multiple concurrent sessions"). `opts.inReplyTo` is ignored — Zulip has no
   * per-message reply parent; it threads BY topic, and the topic is already the addressing unit.
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const res = await this.http('POST', '/api/v1/messages', {
      form: { type: 'stream', to: this.stream, topic: this.wireTopic(topic), content },
    });
    const json = (await res.json()) as { id: number };
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
    let messages = await this.fetchMessages(args.topic, args.since, limit);
    // Native long-poll: only when the exclusive `since` query came back EMPTY and the caller asked
    // to block. With no `since` there is no cursor to advance past, so we never block (matches the
    // seam's "default recent window returns at once"). Returning early/empty stays safe — core's
    // generic wrapper polls the remaining budget — so this only ever SHORTENS the wait.
    if (messages.length === 0 && args.since !== undefined && (args.blockMs ?? 0) > 0) {
      messages = await this.blockingFetch(args.topic, args.since, limit, args.blockMs as number);
    }
    const nextCursor = messages.at(-1)?.cursor ?? args.since ?? asCursor('0');
    return { messages, nextCursor };
  }

  /**
   * Wait up to `blockMs` for a message strictly after `since`, then re-run the normal exclusive
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
    blockMs: number,
  ): Promise<Message[]> {
    const deadline = Date.now() + blockMs;
    while (!this.stopped && Date.now() < deadline) {
      const wake = await this.armWake(topic, deadline);
      try {
        const raced = this.stopped ? [] : await this.fetchMessages(topic, since, limit);
        if (raced.length > 0) return raced;
        await wake.waited;
      } finally {
        await wake.release();
      }
      if (this.stopped) return [];
      const got = await this.fetchMessages(topic, since, limit);
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
   */
  private async armWake(topic: Topic, deadline: number): Promise<Wake> {
    const live = this.waiters.get(topic);
    if (live !== undefined && live.healthy > 0) {
      return this.armSubscriptionWaiter(topic, deadline - Date.now());
    }
    return this.armDedicatedQueue(topic, deadline);
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
      if (this.stopped) finish(); // disconnect may have raced the registration
    });
    return { waited, release: () => finish() };
  }

  /**
   * No usable subscription for this topic: register a short-lived narrowed event queue and issue
   * one `/api/v1/events` long-poll bounded by the remaining budget. When the queue or the poll is
   * unavailable — the whole reason a caller can end up here — the wait degrades to a bounded pause
   * so the caller's next history read still lands inside its budget instead of at the end of it.
   */
  private async armDedicatedQueue(topic: Topic, deadline: number): Promise<Wake> {
    const noop = { release: () => undefined };
    if (this.stopped) return { waited: Promise.resolve(), ...noop };
    let reg: { queue_id: string; last_event_id: number };
    try {
      reg = await this.register(topic);
    } catch {
      return { waited: this.pause(deadline), ...noop };
    }
    const state: QueueState = { queueId: reg.queue_id };
    this.queues.add(state);
    return {
      waited: this.pollForWake(reg, deadline),
      release: async () => {
        this.queues.delete(state);
        await this.deleteQueue(reg.queue_id);
      },
    };
  }

  /**
   * One `/api/v1/events` long-poll on a dedicated queue, resolving on the wake edge (a matching
   * message), at `deadline`, or on disconnect. The events themselves are discarded — the caller
   * re-reads history — so an outright failure only costs the caller a bounded pause.
   */
  private async pollForWake(
    reg: { queue_id: string; last_event_id: number },
    deadline: number,
  ): Promise<void> {
    const remaining = deadline - Date.now();
    if (this.stopped || remaining <= 0) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, remaining);
    this.pendingAborts.add(abort);
    try {
      const res = await this.http('GET', '/api/v1/events', {
        query: {
          queue_id: reg.queue_id,
          last_event_id: String(reg.last_event_id),
          dont_block: 'false',
        },
        signal: controller.signal,
        allowStatuses: [400],
      });
      // Keep the pace on a non-2xx, so that a queue the server rejects outright — answering at once
      // instead of blocking — cannot turn the caller's retries into a spin.
      if (!res.ok) await this.pause(deadline);
    } catch {
      if (!controller.signal.aborted) await this.pause(deadline);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      this.pendingAborts.delete(abort);
    }
  }

  /** A {@link BLOCKED_FETCH_RETRY_MS} pause that never outlives `deadline` or a disconnect. */
  private pause(deadline: number): Promise<void> {
    return this.interruptibleDelay(Math.min(BLOCKED_FETCH_RETRY_MS, deadline - Date.now()));
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
   * armed gap-fill: anything landing between the probe and the queue's birth reaches no queue, and
   * anything landing after it is deduped against the watermark, so every message newer than the
   * probe is delivered EXACTLY once.
   *
   * Queue GC: Zulip garbage-collects queues after ~10 min idle; the server then answers
   * `BAD_EVENT_QUEUE_ID`. Recovery: re-register (new tail) and ARM a pending gap
   * (`needsGapFillFrom`); the top of the loop then GAP-FILLS — replays every message with id > the
   * last delivered id through the catch-up path — RETRYING until it succeeds before polling the
   * fresh queue, so a transient gap-fill failure (a network blip / non-2xx history read) can no
   * longer punch a permanent hole in the push stream. Register failures and gap-fill failures
   * retry independently. Gap-fill advances the delivered watermark PER PAGE, so a mid-pagination
   * throw keeps its partial progress and a retry does not re-deliver already-delivered pages.
   * `lastDeliveredId` also dedupes the overlap when a gap-filled message's event later arrives on
   * the fresh queue.
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
    const tail = await this.fetchMessages(topic, undefined, 1);
    let lastDeliveredId = Number(tail.at(-1)?.backendMsgId ?? '0');
    const reg = await this.register(topic);
    const state: QueueState = { queueId: reg.queue_id };
    if (!alive()) {
      await this.deleteQueue(reg.queue_id);
      return;
    }
    this.queues.add(state);
    // Advertise the topic as piggyback-able only now that every await is behind us and the loop is
    // about to run — a waiter set with no live loop behind it parks a blocking fetchRecent.
    const entry = this.waiters.get(topic) ?? { wakes: new Set<() => void>(), loops: 0, healthy: 0 };
    entry.loops++;
    entry.healthy++;
    this.waiters.set(topic, entry);

    let lastEventId = reg.last_event_id;
    // Armed from the pre-register watermark so the register handshake window is replayed, and
    // re-armed by a queue GC; the top of the loop drains it, retrying until the read succeeds so a
    // transient failure can't leave a permanent push hole.
    let needsGapFillFrom: number | undefined = lastDeliveredId;
    let consecutiveFailures = 0;
    let degraded = false;
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
    const recovered = (): void => {
      consecutiveFailures = 0;
      if (!degraded) return;
      degraded = false;
      entry.healthy++;
    };
    /** Escalating retry wait, so that a permanently dead push path is neither hot nor silent. */
    const backoff = async (reason: string): Promise<void> => {
      degrade();
      consecutiveFailures++;
      if (
        consecutiveFailures === LOOP_FAILURES_BEFORE_REPORT ||
        consecutiveFailures % LOOP_FAILURE_REPORT_INTERVAL === 0
      ) {
        console.error(
          `[parley-zulip] push loop for topic ${JSON.stringify(topic)} has failed ` +
            `${consecutiveFailures}× in a row (${reason}); still retrying, backing off`,
        );
      }
      await this.interruptibleDelay(
        Math.min(LOOP_BACKOFF_MIN_MS * 2 ** (consecutiveFailures - 1), LOOP_BACKOFF_MAX_MS),
      );
    };

    const loop = async (): Promise<void> => {
      while (alive()) {
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
              signal,
            );
            needsGapFillFrom = undefined; // gap closed — resume normal polling
            recovered();
          } catch {
            if (!alive()) break;
            await backoff('gap-fill history read failed');
          }
          continue; // re-check liveness / re-attempt before polling the fresh queue
        }
        const controller = new AbortController();
        this.controllers.add(controller);
        // Client-side long-poll cap so the loop re-checks shutdown; un-acked events survive.
        let capped = false;
        const timer = setTimeout(() => {
          capped = true;
          controller.abort();
        }, this.eventsTimeoutMs);
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
          if (!alive()) break;
          // Keep the `capped` branch, so that the healthy idle poll cap is never mistaken for a
          // failure and escalated into backoff on every long-poll cycle.
          if (capped) recovered();
          else await backoff('events long-poll failed');
          continue;
        } finally {
          clearTimeout(timer);
          this.controllers.delete(controller);
        }
        if (!alive()) break;
        if (json.result === 'error') {
          if (json.code === 'BAD_EVENT_QUEUE_ID') {
            // Re-register the queue, then ARM the pending gap — the top of the loop drains it.
            try {
              const fresh = await this.register(topic, signal);
              state.queueId = fresh.queue_id;
              lastEventId = fresh.last_event_id;
              // Arm from the lowest outstanding watermark so a second GC racing before the first
              // gap closes never skips messages (`lastDeliveredId` only moves forward in practice).
              needsGapFillFrom = Math.min(needsGapFillFrom ?? lastDeliveredId, lastDeliveredId);
              recovered();
            } catch {
              if (!alive()) break;
              await backoff('re-register after queue GC failed');
            }
          } else {
            await backoff(`events poll returned ${json.code ?? 'an error'}`);
          }
          continue;
        }
        recovered();
        let sawMessage = false;
        for (const ev of json.events ?? []) {
          if (ev.id > lastEventId) lastEventId = ev.id; // ack everything, incl. heartbeats
          if (ev.type !== 'message' || ev.message === undefined) continue;
          sawMessage = true; // a message landed on this topic — release any blocked fetchers
          if (ev.message.id <= lastDeliveredId) continue; // already gap-filled — dedup
          lastDeliveredId = ev.message.id;
          deliver(zulipToMessage(topic, ev.message));
        }
        // Wake piggybacking blocking-fetch waiters; they re-query and return whatever is newly past
        // their `since`. A spurious wake only ends a wait early, which core covers by re-polling.
        if (sawMessage) this.wake(topic);
      }
    };
    const running = loop().finally(() => {
      entry.loops--;
      if (!degraded) entry.healthy--;
      if (entry.loops > 0) return;
      if (this.waiters.get(topic) === entry) this.waiters.delete(topic);
      for (const wake of [...entry.wakes]) wake(); // no loop left to wake them
    });
    this.loopExits.add(running);
    void running.finally(() => this.loopExits.delete(running));
  }

  /**
   * Real account lookup (DESIGN §4): `GET /api/v1/users` → `backendRef` = the Zulip `user_id`.
   * `email` is unique per realm, so it resolves outright; `full_name` is a user-settable, NON-unique
   * display name, so it resolves only when exactly one ACTIVE member carries it — an ambiguous or
   * deactivated match degrades to the string convention rather than letting whoever the server
   * happens to list first claim another participant's handle. Any error degrades the same way.
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    try {
      const res = await this.http('GET', '/api/v1/users');
      const { members } = (await res.json()) as {
        members: Array<{ user_id: number; email: string; full_name: string; is_active?: boolean }>;
      };
      const active = members.filter((u) => u.is_active !== false);
      const byEmail = active.find((u) => u.email === handle);
      if (byEmail !== undefined) return { handle, backendRef: String(byEmail.user_id) };
      const byName = active.filter((u) => u.full_name === handle);
      if (byName.length === 1) return { handle, backendRef: String(byName[0]!.user_id) };
    } catch {
      /* lookup is best-effort; fall through to the string convention */
    }
    return { handle, backendRef: handle };
  }

  /**
   * The Zulip topic a Parley topic addresses, used by post, the read narrow and register alike.
   * Case-folded because Zulip compares topics case-insensitively; over-long and case-colliding
   * names are rejected rather than sent, because Zulip would silently truncate the first to 60
   * characters (making the topic write-only: posts land under a name the narrow never matches)
   * and silently merge the second into one shared history.
   */
  private wireTopic(topic: Topic): string {
    const wire = topic.toLowerCase();
    if ([...wire].length > MAX_TOPIC_NAME_LENGTH) {
      throw new Error(
        `Zulip topic too long: ${[...wire].length} characters, max ${MAX_TOPIC_NAME_LENGTH} ` +
          `(Zulip truncates longer subjects on send, making topic ${JSON.stringify(topic)} ` +
          'unreadable). Shorten the Parley topic name.',
      );
    }
    const claimed = this.claimedWireTopics.get(wire);
    if (claimed !== undefined && claimed !== topic) {
      throw new Error(
        `Zulip topic collision: Parley topics ${JSON.stringify(claimed)} and ` +
          `${JSON.stringify(topic)} both map to Zulip topic ${JSON.stringify(wire)} — Zulip ` +
          'matches topics case-insensitively, so they would share one history. Rename one.',
      );
    }
    this.claimedWireTopics.set(wire, topic);
    return wire;
  }

  /**
   * Shared narrowed read used by fetchRecent AND the gap-fill after a queue GC. Paginates so the
   * seam's `limit` stays honest: Zulip rejects `num_before + num_after > 5000` outright, so a
   * larger caller limit is served as successive pages rather than propagated as a 400.
   */
  private async fetchMessages(
    topic: Topic,
    since: Cursor | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const narrow = JSON.stringify([
      { operator: 'stream', operand: this.stream },
      { operator: 'topic', operand: this.wireTopic(topic) },
    ]);
    const out: Message[] = [];
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
      const res = await this.http('GET', '/api/v1/messages', { query, signal });
      const { messages } = (await res.json()) as { messages: ZulipMessage[] };
      const got = messages.map((m) => zulipToMessage(topic, m)); // Zulip returns ascending by id
      // Keep the unshift: pages from the newest anchor walk BACKWARDS, so appending would
      // return the window in descending page order.
      if (since === undefined) out.unshift(...got);
      else out.push(...got);
      remaining -= got.length;
      const edge = since === undefined ? got[0] : got.at(-1);
      if (got.length < page || edge === undefined) break;
      anchor = String(edge.cursor);
      includeAnchor = false;
    }
    return out;
  }

  /** Register a `<stream, topic>`-narrowed message event queue; its birth is the topic's tail. */
  private async register(
    topic: Topic,
    signal?: AbortSignal,
  ): Promise<{ queue_id: string; last_event_id: number }> {
    const res = await this.http('POST', '/api/v1/register', {
      signal,
      form: {
        event_types: JSON.stringify(['message']),
        narrow: JSON.stringify([
          ['stream', this.stream],
          ['topic', this.wireTopic(topic)],
        ]),
        apply_markdown: 'false',
      },
    });
    return (await res.json()) as { queue_id: string; last_event_id: number };
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
    signal?: AbortSignal,
  ): Promise<number> {
    const page = 500;
    let cursor = asCursor(String(sinceId));
    for (;;) {
      // May throw (non-2xx / network blip / teardown) → the caller retries from `onProgress`.
      const messages = await this.fetchMessages(topic, cursor, page, signal);
      for (const m of messages) deliver(m);
      const last = messages.at(-1);
      if (last === undefined) return Number(cursor);
      cursor = last.cursor; // advance so a retry resumes past this delivered page
      onProgress(Number(cursor)); // report per-page progress — durable across a later throw
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

/** True when the URL would put the Basic-auth credential on the wire in the clear. */
function isPlaintextRemote(baseUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(baseUrl);
    if (protocol !== 'http:') return false;
    const host = hostname.replace(/^\[|]$/g, '');
    return !(host === 'localhost' || host === '::1' || /^127\./.test(host));
  } catch {
    return false;
  }
}

function zulipToMessage(topic: Topic, m: ZulipMessage): Message {
  return buildMessage({
    topic,
    sender: m.sender_email ?? '',
    content: m.content ?? '',
    timestamp: new Date((m.timestamp ?? 0) * 1000).toISOString(),
    id: String(m.id),
  });
}

/**
 * Zulip 429s carry `Retry-After` (header) and `retry-after` (JSON body), both in SECONDS. Returns
 * undefined when neither is usable, so the shared default and the shared ceiling stay in
 * `clampBackoff` rather than being re-implemented — and re-tuned — per backend.
 */
async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { 'retry-after'?: number };
    const field = json['retry-after'];
    if (typeof field === 'number' && field > 0) return field * 1000;
  } catch {
    /* no usable body hint */
  }
  return undefined;
}

/**
 * Keep this narrower than `??`, so that a key present in the config but EMPTY (a bare `site_url:`
 * in YAML is `null`) is reported rather than silently replaced by the built-in default.
 */
function orDefault<T>(value: T | undefined, fallback: T): T | undefined {
  return value === undefined ? fallback : value;
}

/** `site_url` must be usable as a base URL now, not at first request. */
function requireHttpUrl(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `backend_config.site_url must be an absolute http(s) URL (got ${JSON.stringify(raw)})`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `backend_config.site_url must use http: or https: (got ${JSON.stringify(parsed.protocol)})`,
    );
  }
  return trimmed;
}

function requireNonEmpty(key: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`backend_config.${key} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * The effective long-poll cap. A non-positive or non-numeric value is rejected outright; a usable
 * one is clamped, so that neither a sub-millisecond value nor one past the timer's 32-bit range can
 * make each poll return instantly and turn the loop into a silent request flood.
 */
function requireEventsTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_EVENTS_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      'backend_config.events_timeout_ms must be a positive, finite number of milliseconds ' +
        `(got ${JSON.stringify(value)})`,
    );
  }
  return Math.min(Math.max(value, MIN_EVENTS_TIMEOUT_MS), MAX_EVENTS_TIMEOUT_MS);
}
