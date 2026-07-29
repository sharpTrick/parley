import {
  asBackendMsgId,
  asCursor,
  asTopic,
  NoSuchTopicError,
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
import { delay, fetchWithRetry } from '@sharptrick/parley-net-util';
import { WebSocket, type RawData } from 'ws';

/** Plugin-specific backend_config. */
export interface SlackBackendConfig {
  /** Bot token (`xoxb-…`) — Web API calls: `chat.postMessage`, `conversations.history`, …. */
  bot_token?: string;
  /** App-level token (`xapp-…`) with `connections:write` — Socket Mode (`apps.connections.open`). */
  app_token?: string;
  /** Web API base URL. Default `https://slack.com/api` (tests point this at an in-process fake). */
  api_url?: string;
  /**
   * Parley topic → Slack channel id (e.g. `{"ctx-payments": "C0123456789"}`). A topic with no
   * entry is used as a channel-id literal, so topics that already ARE channel ids need no map.
   */
  channel_map?: Record<string, string>;
  /**
   * Slack user/usergroup id → Parley handle (e.g. `{"U0PARLEY": "ctx-payments"}`), applied when
   * rewriting `<@U…>` mention markup into the `@handle` form core's mention filter reads.
   */
  mention_map?: Record<string, string>;
  /** Milliseconds a Socket Mode connection may stay silent after opening before `hello`. */
  handshake_timeout_ms?: number;
}

/** The subset of a Slack message object (history entry / `message` event) that we read. */
interface SlackMessage {
  type: string;
  subtype?: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  thread_ts?: string;
}

/** An `ok:false` Web API response, carrying Slack's machine-readable `error` code. */
class SlackApiError extends Error {
  constructor(
    method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} → ${code}`);
    this.name = 'SlackApiError';
  }
}

/**
 * Slack error codes that mean "this conversation is not there for us" — the seam's absent-topic
 * contract ({@link NoSuchTopicError}), which core reads as "topic not present yet" rather than a
 * backend failure. `not_in_channel` is absence for a READ (we cannot see the channel's history);
 * for a WRITE it is a live misconfiguration and must surface as a real error.
 */
const ABSENT_ON_READ = ['channel_not_found', 'not_in_channel'];
const ABSENT_ON_WRITE = ['channel_not_found'];

/** First and maximum cooldown between poll-driven `apps.connections.open` dials. */
export const DIAL_BACKOFF_MS = 500;
const MAX_DIAL_BACKOFF_MS = 5_000;

/**
 * How long a Socket Mode connection may stay silent after opening before we give up on `hello`.
 * Keep a bound here, so that a degraded edge that accepts the TCP connection and then says nothing
 * cannot park `subscribe` and every blocking `fetchRecent` for the process lifetime.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Hard ceiling on the pages one `conversations.history` walk may request. The walk is otherwise
 * bounded only by Slack choosing to stop handing out `next_cursor`; keep this as a THROW rather
 * than a break, so that a truncated walk can never publish a `nextCursor` above history it never
 * read — that span sits below the cursor and no later catch-up would revisit it.
 */
export const MAX_HISTORY_PAGES = 2_000;

/**
 * Objects asked for per `conversations.history` page. Slack caps this per rate-limit tier — 1000 for
 * an internal customer-built app, 15 for a commercially distributed non-Marketplace one — and serves
 * fewer than asked without saying so, so keep every window decision driven by what a page actually
 * CONTAINED rather than by this figure.
 */
export const HISTORY_PAGE_LIMIT = 200;

const asSeamError = (e: unknown, topic: Topic, absentCodes: string[]): unknown =>
  e instanceof SlackApiError && absentCodes.includes(e.code) ? new NoSuchTopicError(topic) : e;

/** A Socket Mode envelope (the subset we route on). */
interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackMessage };
}

interface HistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

interface AuthTestResponse {
  ok: boolean;
  user?: string;
  user_id?: string;
}

/**
 * A pending native long-poll (`fetchRecent` with `blockMs`) parked on the shared Socket Mode
 * stream. `since` is the exclusive floor (`ts`) it is waiting past; `wake` fires exactly once —
 * on a matching live event, at the `blockMs` timeout, or on `disconnect()` — and tears down its
 * own timer + registration (no leaked listeners/timers).
 */
interface Waiter {
  since: string;
  wake: () => void;
}

/**
 * The subtypes carrying new channel-level content, alongside a plain (subtype-less) post.
 *
 * Widen this only for a subtype that is new content with its own `ts`. Keep mutation records
 * (`message_changed`, `message_deleted`, `tombstone`) out, so that a human utterance already
 * delivered under its own id is not delivered a second time under the mutation's id; keep system
 * records (`channel_join`, `channel_topic`, …) out, so that join spam stays out of agent context.
 */
const SURFACED_SUBTYPES = new Set(['bot_message', 'file_share', 'me_message', 'thread_broadcast']);

/**
 * `ts` shape: `<seconds>.<fraction>`. Every inbound record is vendor- or attacker-controlled, so
 * keep this narrow ahead of every use of `ts`, so that a malformed field cannot reach `compareTs`,
 * `new Date(...)` or `asBackendMsgId` — where it throws, or mints an empty dedup key. The digit
 * bounds are load-bearing, not cosmetic: a real `ts` has 10 seconds digits, and anything past 12
 * makes `new Date(seconds * 1000)` throw on the normalize path, wedging the topic's catch-up.
 */
export const TS_RE = /^\d{1,12}\.\d{1,12}$/;

const hasUsableTs = (m: unknown): m is SlackMessage =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as SlackMessage).ts === 'string' &&
  TS_RE.test((m as SlackMessage).ts);

/**
 * A plain reply inside a thread is not channel-level content: `conversations.history` does not
 * return it, so surfacing the live copy would deliver a message no catch-up could ever replay
 * (DESIGN §6/§7). A thread's own parent carries `thread_ts === ts`, and a reply the author
 * broadcasts arrives as `thread_broadcast` — both stay.
 */
const isChannelLevel = (m: SlackMessage): boolean =>
  typeof m.thread_ts !== 'string' || m.thread_ts === m.ts || m.subtype === 'thread_broadcast';

/** A channel-level message we surface — see {@link SURFACED_SUBTYPES}. */
const isPlainMessage = (m: unknown): m is SlackMessage =>
  hasUsableTs(m) &&
  m.type === 'message' &&
  (m.subtype === undefined || (typeof m.subtype === 'string' && SURFACED_SUBTYPES.has(m.subtype))) &&
  isChannelLevel(m);

/**
 * Slack backend (DESIGN §6/§9) over the raw Web API (`fetch`) + Socket Mode (`ws`) — no Slack SDK.
 *
 * Slack is a hosted SaaS, unlike the self-hosted core backends — history durability, availability,
 * and identity live under Slack's policy (and retention limits on free plans), not yours.
 *
 * A topic maps to a channel id via `channel_map` (unmapped topics are treated as channel-id
 * literals). The per-channel message `ts` (e.g. `'1234567890.123456'`) is unique and strictly
 * increasing within its channel, so it serves as BOTH `backendMsgId` (dedup key) AND `cursor`
 * (order key). It is NOT a float and NOT lexically ordered — see {@link compareTs}. "Strictly
 * after a cursor" is resolved server-side: `conversations.history` treats `oldest` as EXCLUSIVE
 * when `inclusive` is omitted. The live path is a Socket Mode websocket driven by real Events API
 * pushes, not a poll timer; any gap across a reconnect is reconciled by cursor catch-up (DESIGN §6).
 */
export class SlackPlugin implements BackendPlugin {
  private apiUrl = 'https://slack.com/api';
  private botToken?: string;
  private appToken?: string;
  private channelMap: Record<string, string> = ownEntriesOnly({});
  private mentionMap: Record<string, string> = ownEntriesOnly({});
  private handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS;
  /**
   * channel id → the one topic allowed to use it: seeded from `channel_map` at {@link connect}, then
   * claimed first-come by unmapped channel-id literals.
   */
  private readonly channelOwner = new Map<string, Topic>();
  private connected = false;
  private stopped = false;
  /** ONE shared Socket Mode websocket per plugin instance, opened lazily on first subscribe. */
  private ws?: WebSocket;
  /** Pending/established socket, resolved once the current connection has seen `hello`. */
  private wsReady?: Promise<void>;
  /** channel id → the topic + handler it feeds (Socket Mode events carry the channel id). */
  private readonly routes = new Map<string, { topic: Topic; handler: MessageHandler }>();
  /**
   * channel id → the set of native long-poll waiters parked on that channel. Populated only while
   * a `fetchRecent({ blockMs })` is blocked; hooks the SAME shared Socket Mode stream as
   * `subscribe`, independent of whether any route is registered. Drained on wake/timeout/disconnect.
   */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** Memoized `auth.test` (our own bot identity) for {@link resolveIdentity}. */
  private authTestPromise?: Promise<AuthTestResponse>;
  /** Earliest wall clock at which a poll-driven handshake may dial — see {@link ensurePollSocket}. */
  private dialCooldownUntil = 0;
  private dialBackoffMs = DIAL_BACKOFF_MS;
  /** Whether a {@link reconnect} loop already owns re-establishing the shared socket. */
  private reconnecting = false;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as SlackBackendConfig;
    this.apiUrl = (cfg.api_url ?? 'https://slack.com/api').replace(/\/+$/, '');
    this.botToken = cfg.bot_token;
    this.appToken = cfg.app_token;
    this.channelMap = requireUsableChannelMap(cfg.channel_map ?? {});
    this.mentionMap = ownEntriesOnly(cfg.mention_map ?? {});
    this.handshakeTimeoutMs = cfg.handshake_timeout_ms ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.channelOwner.clear();
    // Keep configuration claiming its channels HERE, before any call arrives, so that an ad-hoc
    // caller-supplied topic naming a mapped channel-id literal is the side that loses the collision
    // — otherwise one `post` can permanently disable a configured topic (DESIGN §14).
    for (const [topic, channel] of Object.entries(this.channelMap)) {
      this.channelOwner.set(channel, asTopic(topic));
    }
    this.stopped = false;
    this.connected = true;
    this.dialCooldownUntil = 0;
    this.dialBackoffMs = DIAL_BACKOFF_MS;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.routes.clear();
    this.channelOwner.clear();
    // Abort every blocked long-poll cleanly (clears their timers + registrations via wake()). Snapshot
    // first — wake() mutates `waiters` — then clear so no timer/listener outlives the disconnect.
    const pending = [...this.waiters.values()].flatMap((set) => [...set]);
    this.waiters.clear();
    for (const waiter of pending) waiter.wake();
    this.wsReady = undefined;
    if (this.ws !== undefined) {
      try {
        this.ws.close();
      } catch {
        /* already closing/closed */
      }
      this.ws = undefined;
    }
    this.authTestPromise = undefined;
  }

  /**
   * `chat.postMessage`. Threading is an approximation: `inReplyTo` becomes `thread_ts`, filing the
   * message under that thread. A plain thread reply is only visible when reading the thread; a
   * reply broadcast to the channel comes back as a `thread_broadcast` entry, which we surface.
   * `identity` is the logical sender only — Slack stamps our bot user as the wire sender.
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const body: Record<string, unknown> = { channel: this.channelFor(topic), text: content };
    if (opts?.inReplyTo !== undefined) body.thread_ts = opts.inReplyTo;
    const resp = await this.api<{ ok: boolean; ts?: string }>('chat.postMessage', body).catch(
      (e: unknown) => {
        throw asSeamError(e, topic, ABSENT_ON_WRITE);
      },
    );
    // `ok:true` is not a promise that `ts` is there; branding whatever came back would hand core an
    // undefined dedup key that collapses with every other one.
    if (typeof resp.ts !== 'string' || !TS_RE.test(resp.ts)) {
      throw new Error(`Slack chat.postMessage returned no usable ts for topic ${JSON.stringify(topic)}`);
    }
    return asBackendMsgId(resp.ts);
  }

  /**
   * `conversations.history` with `oldest` = `since`, exclusive (`inclusive` is NEVER set), plus the
   * native long-poll when `blockMs` is asked for. The aggregate request cost of draining a backlog
   * this way, and the `catchup.limit` that reduces it, are documented in the package README.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const first = await this.runFetch(args);

    const blockMs = args.blockMs ?? 0;
    if (blockMs <= 0 || args.since === undefined || first.messages.length > 0) {
      return first;
    }
    return this.blockForMessage(args, args.since, Date.now() + blockMs);
  }

  /**
   * Hold a blocked `fetchRecent` for the caller's whole budget: park on the shared Socket Mode
   * stream once the handshake lands, and until then retry it on its own cooldown. Keep the wait HERE
   * rather than returning an empty page the moment Socket Mode is unavailable, so that core's
   * generic re-drive cannot turn one blocked `fetch_recent` into one `conversations.history` request
   * per `block_poll_interval_ms` for the whole budget — a tiered method, on one channel.
   */
  private async blockForMessage(
    args: FetchRecentArgs,
    since: Cursor,
    deadlineAt: number,
  ): Promise<FetchRecentResult> {
    const aborted: FetchRecentResult = { messages: [], nextCursor: since };
    const channel = this.channelFor(args.topic);
    const sinceTs = String(since);
    while (!this.stopped) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      // The handshake is bounded by `handshake_timeout_ms`, which may be far longer than this
      // call's budget; keep the caller's own bound here too, so that `block_ms` stays the ceiling
      // a blocked `parley_fetch_recent` actually observes.
      const live = await withDeadline(this.ensurePollSocket(), remaining).then(
        () => true,
        () => false,
      );
      // A teardown that landed while the handshake ran leaves nothing to wait on, and `runFetch`
      // below would reject on the disconnected plugin; the caller gets its empty page instead.
      if (this.stopped) return aborted;
      if (!live) {
        // Keep this wait on a waiter rather than a bare timer, so that `disconnect()` drains it
        // instead of holding the caller for the rest of the dial cooldown.
        await this.armWaiter(channel, sinceTs, Math.min(deadlineAt - Date.now(), DIAL_BACKOFF_MS))
          .wait;
        continue;
      }
      // Keep the waiter armed BEFORE the gap-closing re-query, so that a push landing while that
      // query is in flight is caught rather than lost — a lost wakeup here blocks for the whole budget.
      const { wait, wake } = this.armWaiter(channel, sinceTs, deadlineAt - Date.now());
      const afterConnect = await this.runFetch(args);
      if (afterConnect.messages.length > 0) {
        wake();
        return afterConnect;
      }
      await wait;
      break;
    }
    if (this.stopped) return aborted;
    return this.runFetch(args);
  }

  private async runFetch(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const channel = this.channelFor(args.topic);
    const limit = args.limit ?? 100;
    const resumeAfterSince = args.since !== undefined;

    // Keep every window decision below counting SURFACED messages, never raw entries, so that a
    // system-subtype-heavy stretch cannot end the walk early or survive the trim as a tail that
    // filters down to nothing — an empty page whose `nextCursor` is `since` livelocks the caller.
    const collected: SlackMessage[] = [];
    let newestSeenTs: string | undefined;
    let pageCursor: string | undefined;
    const walked = new Set<string>();
    let pages = 0;
    for (;;) {
      const body: Record<string, unknown> = { channel, limit: HISTORY_PAGE_LIMIT };
      if (args.since !== undefined) body.oldest = args.since; // EXCLUSIVE (no `inclusive`)
      if (pageCursor !== undefined) body.cursor = pageCursor;
      const resp = await this.api<HistoryResponse>('conversations.history', body).catch(
        (e: unknown) => {
          throw asSeamError(e, args.topic, ABSENT_ON_READ);
        },
      );
      const page = (resp.messages ?? []).filter(hasUsableTs);
      for (const m of page) {
        if (newestSeenTs === undefined || compareTs(m.ts, newestSeenTs) > 0) newestSeenTs = m.ts;
      }
      collected.push(...page.filter(isPlainMessage));
      pageCursor = resp.response_metadata?.next_cursor || undefined;

      if (!resumeAfterSince) {
        if (collected.length >= limit) break;
      } else {
        // Keep the resume-after-`since` walk running to cursor exhaustion, so that `nextCursor` can
        // never come to rest above unfetched older history — the skipped span sits below it and no
        // later catch-up would ever revisit it. Pages arrive newest-first, so retaining only the
        // oldest ~`limit + page_size` keeps memory at O(limit) while the walk runs.
        const retain = limit + HISTORY_PAGE_LIMIT;
        if (collected.length > retain) collected.splice(0, collected.length - retain);
      }
      if (pageCursor === undefined) break;

      // Termination of the walk is otherwise entirely the peer's choice. Each guard below ends it
      // with a named error rather than a break, so that a truncated walk never publishes a cursor
      // above history it did not read.
      if (this.stopped) {
        throw new Error(`Slack conversations.history walk on ${channel} aborted — disconnected`);
      }
      if (walked.has(pageCursor)) {
        throw new Error(
          `Slack conversations.history repeated page cursor on ${channel}; the walk is not advancing`,
        );
      }
      walked.add(pageCursor);
      if (++pages >= MAX_HISTORY_PAGES) {
        throw new Error(
          `Slack conversations.history walk on ${channel} exceeded ${MAX_HISTORY_PAGES} pages`,
        );
      }
    }

    const events = collected.sort((a, b) => compareTs(a.ts, b.ts));
    const window = resumeAfterSince ? events.slice(0, limit) : events.slice(-limit);
    const messages = window.map((m) => slackToMessage(args.topic, m, this.mentionMap));
    return { messages, nextCursor: messages.at(-1)?.cursor ?? this.emptyCursor(args, newestSeenTs) };
  }

  /**
   * The cursor for a window that surfaced nothing. Keep the `since` walk exhaustive (see
   * {@link runFetch}), so that stepping the cursor past those unsurfaced entries cannot skip a
   * message: it is safe only because every entry above `since` was seen and none was surfacable.
   */
  private emptyCursor(args: FetchRecentArgs, newestSeenTs: string | undefined): Cursor {
    if (args.since !== undefined && newestSeenTs !== undefined) return asCursor(newestSeenTs);
    return args.since ?? asCursor('0');
  }

  /**
   * Live path = ONE shared Socket Mode websocket (DESIGN §9 — genuine Events API pushes, not a
   * poll timer). `apps.connections.open` (app token) mints a single-use websocket URL; the socket
   * is established — `hello` received — before this resolves, so a post immediately after
   * subscribe() is pushed. Slack pushes only NEW events, so the subscription starts at the tail
   * and history stays owned by catch-up; the gap across a reconnect is reconciled the same way.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const channel = this.channelFor(topic);
    this.routes.set(channel, { topic, handler });
    await this.ensureSocket();
  }

  /**
   * `handle` containing `@` → `users.lookupByEmail` (real workspace account); our own bot name /
   * user id (per memoized `auth.test`) → the bot's user id; anything else passes through as a
   * name convention (DESIGN §4 — a handle does not imply a backend account).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    if (handle.includes('@')) {
      try {
        const resp = await this.api<{ ok: boolean; user: { id: string } }>('users.lookupByEmail', {
          email: handle,
        });
        return { handle, backendRef: resp.user.id };
      } catch (e: unknown) {
        // Keep this narrowed to "no such account", so that a provisioning failure
        // (`missing_scope`, `invalid_auth`, a 429) cannot read back as a successful passthrough.
        if (e instanceof SlackApiError && e.code === 'users_not_found') {
          return { handle, backendRef: handle };
        }
        throw e;
      }
    }
    const auth = await this.authTest();
    if (handle === auth.user || handle === auth.user_id) {
      return { handle, backendRef: auth.user_id ?? handle };
    }
    return { handle, backendRef: handle };
  }

  /**
   * Map a topic to its Slack channel id (`channel_map`, else the topic string itself), and record
   * that topic as the channel's owner. Keep this the ONE place the mapping is resolved, so that
   * every seam method rejects a second topic folding onto an owned channel: a reactive-only
   * deployment never calls `subscribe`, so a guard living there leaves `post`/`fetchRecent` free to
   * relabel one topic's traffic as the other's, crossing dedup and allowlist namespaces.
   */
  private channelFor(topic: Topic): string {
    const channel = this.channelMap[topic] ?? topic;
    const owner = this.channelOwner.get(channel);
    if (owner === undefined) {
      this.channelOwner.set(channel, topic);
      return channel;
    }
    if (owner !== topic) {
      throw new Error(
        `Slack topics ${JSON.stringify(owner)} and ${JSON.stringify(topic)} both resolve to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    return channel;
  }

  private authTest(): Promise<AuthTestResponse> {
    this.authTestPromise ??= this.api<AuthTestResponse>('auth.test', {}).catch((err: unknown) => {
      this.authTestPromise = undefined; // don't memoize failure
      throw err;
    });
    return this.authTestPromise;
  }

  /** The shared socket, opened lazily on the first subscribe; resolves once `hello` is in. */
  private ensureSocket(): Promise<void> {
    if (this.wsReady === undefined) {
      const attempt = this.openSocket();
      this.wsReady = attempt;
      // Memoize the connection, never the FAILURE: a cached rejection is replayed by every later
      // subscribe/blocking fetch without touching the network, so one transient
      // `apps.connections.open` error would disable live push for the process lifetime.
      attempt.then(
        () => {
          this.dialCooldownUntil = 0;
          this.dialBackoffMs = DIAL_BACKOFF_MS;
        },
        () => {
          if (this.wsReady === attempt) this.wsReady = undefined;
          this.dialCooldownUntil = Date.now() + this.dialBackoffMs;
          this.dialBackoffMs = Math.min(this.dialBackoffMs * 2, MAX_DIAL_BACKOFF_MS);
        },
      );
    }
    return this.wsReady;
  }

  /**
   * The long-poll's view of the shared socket. Core re-drives `fetchRecent` every
   * `block_poll_interval_ms` (250 ms) for the whole `block_max_ms` budget, so keep the cooldown
   * after a failed handshake, so that one unavailable Socket Mode cannot turn a single
   * `fetch_recent` into hundreds of `apps.connections.open` calls — Slack's tightest rate limit.
   */
  private ensurePollSocket(): Promise<void> {
    if (this.wsReady === undefined && Date.now() < this.dialCooldownUntil) {
      return Promise.reject(
        new Error('Slack Socket Mode handshake backing off after a failed apps.connections.open'),
      );
    }
    return this.ensureSocket();
  }

  /**
   * ARM a native long-poll on `channel` immediately and return its `{ wait, wake }` handle. `wait`
   * resolves when a live event strictly after `sinceTs` arrives (via {@link onEnvelope}), when
   * `blockMs` elapses, or when `wake()`/`disconnect()` drains it — EXACTLY once, self-cleaning (timer
   * cleared, registration removed), never rejecting. Arming is separated from awaiting so the caller
   * can register the waiter BEFORE the gap-closing re-query, keeping it live across that snapshot
   * window (a push landing mid-query is then caught, not lost); `wake()` cancels it if that query
   * already returned data.
   */
  private armWaiter(
    channel: string,
    sinceTs: string,
    blockMs: number,
  ): { wait: Promise<void>; wake: () => void } {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    let resolveWait!: () => void;
    const waiter: Waiter = {
      since: sinceTs,
      wake: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.waiters.get(channel);
        if (set !== undefined) {
          set.delete(waiter);
          if (set.size === 0) this.waiters.delete(channel);
        }
        resolveWait();
      },
    };
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    timer = setTimeout(waiter.wake, blockMs);
    const set = this.waiters.get(channel) ?? new Set<Waiter>();
    set.add(waiter);
    this.waiters.set(channel, set);
    return { wait, wake: waiter.wake };
  }

  private async openSocket(): Promise<void> {
    // Socket Mode handshake uses the APP token; everything else uses the bot token.
    const open = await this.api<{ ok: boolean; url: string }>('apps.connections.open', {}, 'app');
    // Keep this abort, so that a disconnect landing during the round trip cannot leave a live
    // socket nothing will ever close, burning one of the ~10 connections per app token.
    if (this.stopped) throw new Error('Slack Socket Mode connect aborted — plugin disconnected');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(open.url);
      this.ws = ws;
      let settled = false;
      let helloSeen = false;
      let handshake: ReturnType<typeof setTimeout>;
      /** Settle the handshake exactly once. */
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        if (err === undefined) resolve();
        else reject(err);
      };
      // The only other exit from this promise is a message the peer may never send.
      handshake = setTimeout(() => {
        settle(new Error(`Slack Socket Mode sent no hello within ${this.handshakeTimeoutMs}ms`));
        try {
          ws.close();
        } catch {
          /* already closing/closed */
        }
      }, this.handshakeTimeoutMs);
      ws.on('message', (data: RawData) => {
        this.onEnvelope(ws, data, () => {
          helloSeen = true;
          settle();
        });
      });
      ws.on('error', (err: Error) => {
        settle(err);
      });
      ws.on('close', () => {
        // Keep this settle AHEAD of the stopped/superseded return, so that a teardown closing the
        // socket always releases the callers awaiting the handshake instead of parking them for
        // the process lifetime. Keep it a bare reject — the owning caller (the first `subscribe`
        // or the running `reconnect` loop) retries.
        settle(new Error('Slack Socket Mode connection closed before hello'));
        if (this.stopped || this.ws !== ws) return;
        // Socket Mode URLs are SINGLE-USE: never redial the old URL.
        this.wsReady = undefined;
        // Keep this gated on `helloSeen` rather than on which call settled the handshake, so that a
        // handshake timeout or a websocket `error` — both of which settle it BEFORE the close they
        // cause — cannot be read as a live connection dropping and be handed a reconnect owner.
        if (!helloSeen) return;
        void this.reconnect();
      });
    });
  }

  /**
   * Re-establish the shared socket with capped exponential backoff until stopped. Keep this
   * single-owner, so that a close arriving while a loop is already retrying cannot start a second
   * loop: every loop dials `apps.connections.open` — Slack's tightest-limit endpoint — and their
   * failures compound instead of backing off.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      let backoffMs = 200;
      while (!this.stopped) {
        try {
          await this.ensureSocket();
          return;
        } catch {
          await delay(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 5000);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * One Socket Mode envelope. Keep the ack FIRST, before any processing, so that neither a
   * dropped subtype, an unrouted channel, nor a throwing handler can starve it — Slack redelivers
   * an unacked envelope and eventually drops the connection. Events arrive in order on the single
   * socket, so per-channel handler invocation stays in ascending `ts` order.
   */
  private onEnvelope(ws: WebSocket, data: RawData, onHello: () => void): void {
    let env: SocketEnvelope;
    try {
      env = JSON.parse(String(data)) as SocketEnvelope;
    } catch {
      return; // not JSON — nothing to ack, nothing to route
    }
    if (typeof env !== 'object' || env === null) return;
    if (typeof env.envelope_id === 'string') {
      try {
        ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch {
        /* socket already closing; redelivery on the next connection covers it */
      }
    }
    // Keep the whole post-ack body inside this catch, so that a malformed envelope throwing into a
    // socket callback — where there is no caller to propagate to and node exits — cannot happen.
    try {
      this.routeEnvelope(ws, env, onHello);
    } catch {
      /* an inbound envelope is untrusted input; drop it, keep the socket serving */
    }
  }

  private routeEnvelope(ws: WebSocket, env: SocketEnvelope, onHello: () => void): void {
    if (env.type === 'hello') {
      onHello();
      return;
    }
    if (env.type === 'disconnect') {
      // Keep this a close rather than a direct redial, so that the `close` handler stays the ONE
      // place a fresh single-use URL is minted and a rotation cannot race a reconnect owner.
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      return;
    }
    if (env.type !== 'events_api') return;
    const event = env.payload?.event;
    if (!isPlainMessage(event) || typeof event.channel !== 'string') return;

    // Wake any native long-poll waiters on this channel — independent of subscribe routes, since a
    // blocking `fetchRecent` may have no route registered. A message strictly after a waiter's floor
    // means its exclusive re-query will now return; snapshot the set (wake() mutates it).
    const waiting = this.waiters.get(event.channel);
    if (waiting !== undefined) {
      for (const waiter of [...waiting]) {
        if (compareTs(event.ts, waiter.since) > 0) waiter.wake();
      }
    }

    const route = this.routes.get(event.channel);
    if (route === undefined) return;
    try {
      route.handler(slackToMessage(route.topic, event, this.mentionMap));
    } catch {
      /* handler is best-effort; never break the loop (DESIGN §6) */
    }
  }

  /**
   * Single Web API entry point: `POST <api_url>/<method>`, `Authorization: Bearer <token>`, body
   * `application/x-www-form-urlencoded`. Keep every method form-encoded, so that read methods
   * (`conversations.history`, `users.lookupByEmail`) receive their args at all — slack.com
   * silently ignores a JSON body for those. Every Slack response carries `ok`; `ok:false` throws
   * with Slack's `error` code, interpreted here rather than in the shared HTTP helper, which owns
   * the 429 retry loop, the `Retry-After` header and the backoff clamp.
   */
  private async api<T extends { ok: boolean }>(
    method: string,
    body: Record<string, unknown>,
    auth: 'bot' | 'app' = 'bot',
  ): Promise<T> {
    const token = auth === 'app' ? this.appToken : this.botToken;
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const url = `${this.apiUrl}/${method}`;

    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }

    const res = await fetchWithRetry(
      url,
      { method: 'POST', headers, body: form.toString() },
      {
        label: `Slack ${method}`,
        isStopped: () => this.stopped,
      },
    );
    const json = (await res.json()) as T & { error?: string };
    if (!json.ok) throw new SlackApiError(method, json.error ?? 'unknown_error');
    return json;
  }

  private require(): void {
    if (!this.connected) {
      throw new Error('SlackPlugin not connected — call connect() first');
    }
  }
}

/**
 * Compare two Slack `ts` values (`'<seconds>.<suffix>'`) — the cursor order key.
 *
 * NOT a float compare: `Number('<seconds>.<suffix>')` loses the low-order digits outright once the
 * seconds grow past the double's ~1 µs resolution there, collapsing distinct `ts` values to equal.
 * NOT a lexical compare: seconds are unpadded, so `'2.…'` would sort after `'10.…'`. Compare the
 * seconds as integers, then the suffix as a FRACTION — zero-padded to a common width, since a
 * suffix is a place-value fraction (`.1` is 0.1 s, not 1 µs), not an integer count.
 */
export function compareTs(a: string, b: string): number {
  const [aSec, aSub = ''] = a.split('.');
  const [bSec, bSub = ''] = b.split('.');
  const bySec = Number(aSec) - Number(bSec);
  if (bySec !== 0) return bySec;
  const width = Math.max(aSub.length, bSub.length);
  return Number(aSub.padEnd(width, '0') || '0') - Number(bSub.padEnd(width, '0') || '0');
}

/**
 * A config lookup table with NO prototype chain. Keep both config maps built this way, so that a key
 * like `__proto__`, `constructor` or `toString` — legal in core's `topics`/`post_topics` and
 * reachable straight from untrusted inbound mention markup — cannot answer with an
 * `Object.prototype` member as if it were a configured entry.
 */
function ownEntriesOnly<T>(map: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(map)) out[key] = value;
  return out;
}

/**
 * Reject a `channel_map` that cannot be used as one. Keep this fail-fast, so that two topics folding
 * onto one channel cannot silently displace each other's route and relabel one topic's traffic as
 * the other's — crossing into a different topic's dedup and allowlist namespace — and so that a
 * target that is not a channel id cannot reach the wire as `"undefined"` or a JSON blob.
 */
function requireUsableChannelMap(map: Record<string, string>): Record<string, string> {
  const owner = new Map<string, string>();
  for (const [topic, channel] of Object.entries(map)) {
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new Error(
        `Slack channel_map maps ${JSON.stringify(topic)} to ${JSON.stringify(channel)}, ` +
          `which is not a channel id`,
      );
    }
    const prior = owner.get(channel);
    if (prior !== undefined) {
      throw new Error(
        `Slack channel_map maps both ${JSON.stringify(prior)} and ${JSON.stringify(topic)} to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    owner.set(channel, topic);
  }
  return ownEntriesOnly(map);
}

/**
 * The poster's Slack user/bot id. A workflow- or app-authored entry can carry neither field, and an
 * EMPTY `senderHandle` violates the seam's own well-formedness rule and lands in core's identity
 * filter and roster as a blank peer, so fall back to a stable non-empty name.
 */
const senderOf = (m: SlackMessage): string => {
  for (const id of [m.user, m.bot_id]) {
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'unknown';
};

/**
 * Slack's mention markup — `<@U…>`, `<@U…|label>`, `<!subteam^S…|@group>`, `<!here>` — is NOT the
 * `@handle` text core's `parseMentions` reads, so without this rewrite `Message.mentions` holds raw
 * Slack ids and a bridge running with `mention_filter` on delivers nothing. `mention_map` supplies
 * the id → handle mapping; Slack's own label is the fallback, and an unmapped, unlabelled id stays
 * as the id (visible, but not a Parley handle).
 */
const MENTION_RE = /<([@!])([^>|\s]*)(?:\|([^>]*))?>/g;
/** The `<!…>` bodies that ARE mentions; every other one (`<!date^…>`, …) is left as Slack wrote it. */
const BROADCASTS = new Set(['here', 'channel', 'everyone']);

function renderMentions(text: string, mentionMap: Record<string, string>): string {
  return text.replace(MENTION_RE, (raw, sigil: string, body: string, label?: string) => {
    if (sigil === '!' && !BROADCASTS.has(body) && !body.startsWith('subteam^')) return raw;
    const id = sigil === '!' ? body.replace(/^subteam\^/, '') : body;
    const mapped = mentionMap[id];
    if (mapped !== undefined) return `@${mapped}`;
    if (label !== undefined && label.length > 0) return label.startsWith('@') ? label : `@${label}`;
    return id.length > 0 ? `@${id}` : raw;
  });
}

function slackToMessage(topic: Topic, m: SlackMessage, mentionMap: Record<string, string>): Message {
  return buildMessage({
    topic,
    sender: senderOf(m),
    content: renderMentions(m.text ?? '', mentionMap),
    // Informational only (DESIGN §5) — derived from the ts seconds, never used for ordering.
    timestamp: new Date(Number(m.ts.split('.')[0]) * 1000).toISOString(),
    id: m.ts,
  });
}

/**
 * Reject once `ms` has passed, so a caller with its own budget can bound a wait it does not own.
 * `p` stays subscribed by the race, so a later rejection of it is never unhandled.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

