import {
  asBackendMsgId,
  asCursor,
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
import {
  DEFAULT_DEADLINE_MS,
  fetchWithRetry,
  isLoopbackHost,
  retryAfterFromHeader,
  sanitizeBody,
} from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { INTENTS, REQUIRED_INTENTS } from './intents.js';

export { REQUIRED_INTENTS } from './intents.js';

/** Plugin-specific backend_config. */
export interface DiscordBackendConfig {
  /** Bot token (Discord developer portal → Bot → Token). Sent as `Authorization: Bot <token>`. */
  token?: string;
  /** REST base URL. Default `https://discord.com/api/v10`. Tests point this at a local fake. */
  api_url?: string;
  /**
   * Gateway websocket URL override (used by tests/fakes). Default: resolved live via
   * `GET /gateway/bot` on first subscribe.
   */
  gateway_url?: string;
  /**
   * Parley topic → Discord channel id. An UNMAPPED topic string is used as a channel id
   * literal — the zero-config path when your topics simply ARE channel ids. Values must be
   * DISTINCT: two topics folding onto one channel is rejected at `connect()`.
   */
  channel_map?: Record<string, string>;
  /**
   * How long the gateway handshake (HELLO → IDENTIFY → READY) may take before the socket is
   * terminated and the attempt fails. Default 10000.
   */
  handshake_timeout_ms?: number;
  /**
   * How many bridge instances share this bot token AND open a gateway socket. Discord's
   * 1000-IDENTIFY-per-24h quota is per BOT TOKEN, not per process, so the reconnect ceiling
   * ({@link RECONNECT_CAP_MS}) is multiplied by this. Integer ≥ 1; default 1.
   */
  gateway_dialers?: number;
  /**
   * Mention scope for every `post`. Default `{ parse: ['users'], replied_user: false }` — widen it
   * only deliberately: `@everyone`/`@here`/role pings reach the whole guild, and `post` content can
   * be untrusted inbound text an agent relayed (DESIGN §14).
   */
  allowed_mentions?: AllowedMentions;
}

/** Discord's `allowed_mentions` object — the blast radius of a `post`'s mention markup. */
export interface AllowedMentions {
  parse?: string[];
  users?: string[];
  roles?: string[];
  replied_user?: boolean;
}

/** A minimal Discord message object (the subset we read; REST and gateway share this shape). */
interface DiscordMessage {
  id: string;
  channel_id: string;
  content?: string;
  timestamp?: string;
  author?: { id: string; username: string };
  /** Users referenced by `<@id>` markup in `content` — Discord resolves them for us. */
  mentions?: Array<{ id: string; username: string }>;
}

/** A minimal gateway payload. */
interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/** The gateway opcodes this plugin speaks. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** The default mention scope of every `post` — see {@link DiscordBackendConfig.allowed_mentions}. */
const DEFAULT_ALLOWED_MENTIONS: AllowedMentions = { parse: ['users'], replied_user: false };

/**
 * Query params Discord documents as REQUIRED on the gateway CONNECT url — and which the url
 * `GET /gateway/bot` hands back carries NEITHER of. Keep both on every dial, so that the socket
 * does not land on a decommissioned API version: that answers close 4012, which is terminal, so the
 * ladder stops and a correctly provisioned bot never starts.
 */
const GATEWAY_QUERY: Record<string, string> = { v: '10', encoding: 'json' };

/** This package's published version — the release pipeline stamps `package.json`, never source. */
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/**
 * Discord's REST API requires a `DiscordBot ($url, $version)` User-Agent and documents that a
 * request without a valid one "may be blocked and return a Cloudflare error". Keep the version read
 * from the manifest, so that a release cannot ship a stale literal.
 */
const USER_AGENT = `DiscordBot (https://github.com/sharpTrick/parley, ${VERSION})`;

/** Schemes that put a bot token on the wire in the clear, and what to use instead. */
const PLAINTEXT_SCHEMES = new Map([
  ['http:', 'https://'],
  ['ws:', 'wss://'],
]);

/**
 * Channel types that DO carry `MESSAGE_CREATE` under this intent set (GUILDS | GUILD_MESSAGES |
 * MESSAGE_CONTENT, no `DIRECT_MESSAGES`): guild text (0), the text chat of voice (2) and stage (13)
 * channels, announcements (5), and the three thread classes (10/11/12). Keep this an ALLOWLIST, so
 * that an id no `MESSAGE_CREATE` can ever name — a category, a forum or media container, a
 * directory, a DM, or a type Discord adds after this was written — is named on stderr instead of
 * becoming a permanently idle topic.
 */
const PUSHABLE_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);

/** How to describe the channel types an operator most plausibly mis-copies from Discord's UI. */
const CHANNEL_TYPE_NAMES = new Map([
  [1, 'a DM'],
  [3, 'a group DM'],
  [4, 'a category'],
  [14, 'a directory'],
  [15, 'a forum container (its threads carry the messages)'],
  [16, 'a media container (its threads carry the messages)'],
]);

/** Discord REST error code for a channel that exists but this bot cannot access. */
const MISSING_ACCESS = 50001;

/**
 * Terminal Discord gateway close codes — authentication failed (4004), invalid/disallowed
 * intents (4013/4014), invalid API version (4012), and the sharding-class errors (4010/4011).
 * None are recoverable by re-IDENTIFYing; retrying re-sends IDENTIFY on every attempt and burns
 * Discord's 1000-IDENTIFY/24h budget, which RESETS (invalidates) the bot token. Treat
 * them as fatal: stop reconnecting and surface the error.
 */
const TERMINAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Rejects openSocket with this to tell the reconnect loop the close was terminal — do NOT retry. */
class TerminalGatewayCloseError extends Error {}

/** Discord REST error code for a channel that does not exist (or the bot cannot see at all). */
const UNKNOWN_CHANNEL = 10003;

/** Discord's hard caps: characters per message, and messages per `GET .../messages` page. */
const CONTENT_LIMIT = 2000;
const PAGE_LIMIT = 100;

/**
 * The smallest REST budget the FIRST query of a `fetchRecent` runs under, however little of the
 * call's budget survived the legs before it. Keep it above zero, so that whether an absent channel
 * answers {@link NoSuchTopicError} or an ordinary empty window is decided by the channel and not by
 * the clock — a `block_ms` a model chose small, or a gateway leg that ate it, otherwise flips the
 * seam's absent-topic classification into "nothing new here" and the operator sees an idle topic
 * with no error.
 */
const MIN_QUERY_BUDGET_MS = 250;

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Reconnect backoff ceiling FOR ONE DIALER. Keep it above 86.4s (= 86400s / 1000), so that a
 * chronically flapping gateway stays under Discord's 1000-IDENTIFY-per-24h quota — the penalty for
 * exceeding it is a bot-token RESET, which breaks every Parley instance sharing that bot until a
 * human re-provisions it. The quota is per BOT TOKEN, so a fleet sharing one token multiplies this
 * by `gateway_dialers`; keep them equal to the real fan-out, so that N instances flapping together
 * still spend one token's budget.
 */
export const RECONNECT_CAP_MS = 120_000;

/**
 * How long a socket must stay up AFTER READY before its reconnect budget is forgiven. Keep this
 * well above zero, so that a gateway which drops immediately after READY cannot reset the backoff
 * on every cycle and re-IDENTIFY once a second — the same token-reset quota as above.
 */
export const STABLE_CONNECTION_MS = 60_000;

/** First rung of the reconnect ladder, doubled per attempt up to {@link RECONNECT_CAP_MS}. */
export const BACKOFF_BASE_MS = 1000;
/** Random spread added to every ladder delay, so a fleet of bridges does not re-dial in lockstep. */
export const BACKOFF_JITTER_MS = 1000;
/** Discord's mandated re-IDENTIFY wait after op 9 INVALID SESSION: a random 1–5 s. */
export const INVALID_SESSION_MIN_WAIT_MS = 1000;
export const INVALID_SESSION_SPREAD_MS = 4000;

/**
 * Discord backend (DESIGN §6/§9) — spoken to via the raw REST v10 API (global `fetch`) plus a
 * minimal gateway-websocket subset (`ws`); no discord.js. A Parley topic maps to one Discord
 * channel (via `channel_map`, or the topic string used as a channel id literal). The message
 * **snowflake** id serves as BOTH `backendMsgId` (dedup key) AND `cursor` (order key):
 * snowflakes are time-ordered and strictly increasing per channel, and "strictly after a
 * cursor" is resolved server-side (`?after=` is exclusive) — ordering is delegated to the API.
 * Snowflakes are DECIMAL strings and NOT lexically comparable; any local comparison must go
 * through `BigInt(a) < BigInt(b)` (this plugin needs none — core never compares cursors either).
 * The live path is one shared gateway websocket per plugin instance, dispatching
 * `MESSAGE_CREATE` events to subscribed channels.
 *
 * Positioning tradeoff, visible up front: Discord is a hosted SaaS, unlike the self-hosted core
 * backends — history durability, availability, and identity live under Discord's policy, not
 * yours.
 */
export class DiscordPlugin implements BackendPlugin {
  private apiUrl = 'https://discord.com/api/v10';
  private token?: string;
  private gatewayUrlOverride?: string;
  private channelMap = new Map<string, string>();
  /** Reverse of {@link channelMap}: channel id → the ONE topic that owns it. */
  private channelOwner = new Map<string, string>();
  private handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS;
  /** {@link RECONNECT_CAP_MS} scaled by `gateway_dialers` — the fleet's share of ONE token's quota. */
  private reconnectCapMs = RECONNECT_CAP_MS;
  private allowedMentions: AllowedMentions = DEFAULT_ALLOWED_MENTIONS;
  private connected = false;
  private stopped = false;
  /**
   * Set by a TERMINAL gateway close (auth/intent/version/shard). Sticky for the life of the
   * connection: those failures need a human (token, portal toggle), so every later gateway-backed
   * call fails fast with the reason instead of opening a socket Discord will close again.
   */
  private fatalGateway?: Error;
  /** Shared gateway socket (ONE per plugin instance), opened lazily on first subscribe. */
  private ws?: WebSocket;
  /** Resolves once the gateway is IDENTIFYed and READY; first subscribe awaits it. */
  private gatewayReady?: Promise<void>;
  /** True only while a socket that reached READY is still open — see {@link gatewayLive}. */
  private live = false;
  /**
   * Heartbeat intervals of sockets still open. Each socket owns its own entry, so that a late
   * HELLO on a superseded socket can never clear the LIVE socket's heartbeat and let Discord
   * zombie-close a healthy connection.
   */
  private readonly heartbeats = new Set<NodeJS.Timeout>();
  /** Last dispatch sequence number, echoed in heartbeats. */
  private seq: number | null = null;
  /**
   * Reconnect backoff attempt counter: grows the delay 1s→2s→…→{@link RECONNECT_CAP_MS}
   * (with jitter) and is RESET to 0 only when a socket that reached READY also STAYED up for
   * {@link STABLE_CONNECTION_MS}.
   */
  private reconnectAttempts = 0;
  /**
   * Earliest time any code path may open a gateway socket — the ONE IDENTIFY budget, shared by
   * the reconnect loop and by {@link ensureGateway}. Keep every dial behind it, so that a caller
   * that retries fast (core's 250 ms long-poll fallback) cannot re-IDENTIFY at its own cadence and
   * burn Discord's 1000/24h quota, whose penalty is a bot-token RESET.
   */
  private nextDialAt = 0;
  /** Pending reconnect, cleared by disconnect() so it cannot fire against the NEXT session. */
  private reconnectTimer?: NodeJS.Timeout;
  /**
   * Bumped by every `connect()`. Each socket captures it at open time; keep every deferred
   * callback behind that capture, so that a watchdog or close from a session the plugin has
   * already torn down cannot dial, re-IDENTIFY, or clear state belonging to the NEXT one.
   */
  private sessionEpoch = 0;
  /**
   * Minimum delay (ms) the NEXT dial must honor. Set by op 9 INVALID SESSION to Discord's
   * mandated random 1–5 s re-IDENTIFY wait; consumed by {@link chargeDialAttempt}.
   */
  private invalidSessionWaitMs = 0;
  /** channel id → subscription; MESSAGE_CREATE dispatch routes through this. */
  private readonly subs = new Map<string, { topic: Topic; handler: MessageHandler }>();
  /**
   * Native long-poll wakeups: channel id → set of one-shot callbacks armed by a
   * blocking `fetchRecent`. Any MESSAGE_CREATE on that channel — or the socket going away — fires
   * every waiter so the blocked fetch re-queries and returns. Independent of `subs`: a blocking fetch
   * does NOT register a subscription, it only listens on the SHARED gateway socket the live path
   * already runs (no second connection). Reusing the same `MESSAGE_CREATE` primitive keeps the
   * wait cheap and its teardown identical to the live path's.
   */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Memoized `GET /users/@me` (the bot's own account), for resolveIdentity. */
  private me?: Promise<{ id: string; username: string }>;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as DiscordBackendConfig;
    const channelMap = new Map(Object.entries(cfg.channel_map ?? {}));
    const channelOwner = requireDistinctChannels(channelMap);
    const reconnectCapMs = RECONNECT_CAP_MS * requireDialerCount(cfg.gateway_dialers);

    // Retire the previous session BEFORE installing the new config, so that a re-entrant connect()
    // cannot leave the old socket dispatching into a plugin whose `live` flag says there is none —
    // which silently degrades every later native long-poll to an immediate return.
    this.stopped = true;
    this.sessionEpoch++;
    this.teardownSession();

    this.apiUrl = (cfg.api_url ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
    this.token = cfg.token;
    this.gatewayUrlOverride = cfg.gateway_url;
    this.channelMap = channelMap;
    this.channelOwner = channelOwner;
    this.handshakeTimeoutMs = cfg.handshake_timeout_ms ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.reconnectCapMs = reconnectCapMs;
    this.allowedMentions = cfg.allowed_mentions ?? DEFAULT_ALLOWED_MENTIONS;
    this.stopped = false;
    this.connected = true;
    this.reconnectAttempts = 0;
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = 0;
    this.seq = null;

    for (const risk of plaintextCredentialRisks(cfg)) this.warn(`SECURITY: ${risk}`);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.teardownSession();
  }

  /**
   * Release everything one session owns: the socket, its heartbeat, the pending reconnect, the
   * readiness memo, the dispatch registry, every armed long-poll waiter, and the identity memo.
   * Callers set `stopped` and `sessionEpoch` first, so that a close or watchdog this releases cannot
   * dial or mark state fatal on behalf of the session that is ending.
   */
  private teardownSession(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const beat of this.heartbeats) clearInterval(beat);
    this.heartbeats.clear();
    this.ws?.close();
    this.ws = undefined;
    this.live = false;
    this.gatewayReady = undefined;
    this.fatalGateway = undefined;
    this.subs.clear();
    this.wakeWaiters();
    this.waiters.clear();
    this.me = undefined;
  }

  /**
   * `POST /channels/<id>/messages`. The seam's `identity` is deliberately unused: Discord stamps
   * `author` from whichever bot token is configured, so per-session attribution needs a
   * per-session token, not an argument.
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const characters = countCharacters(content);
    if (characters > CONTENT_LIMIT) {
      throw new Error(
        `Discord caps a message at ${CONTENT_LIMIT} characters; this post is ${characters}. ` +
          'Split it across posts (chunking here would break the one-post/one-backendMsgId contract).',
      );
    }
    const channelId = this.channelId(topic);
    const res = await this.http('POST', `/channels/${encodeURIComponent(channelId)}/messages`, {
      body: {
        content,
        allowed_mentions: this.allowedMentions,
        message_reference:
          opts?.inReplyTo !== undefined ? { message_id: opts.inReplyTo } : undefined,
      },
    });
    const json = (await res.json()) as DiscordMessage;
    return asBackendMsgId(json.id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const limit = args.limit ?? 100;
    const blockMs = args.blockMs ?? 0;
    const deadline = Date.now() + (blockMs > 0 ? blockMs : DEFAULT_DEADLINE_MS);

    if (args.since === undefined) {
      // Keep paging BACKWARDS with `before` past the API's 100-per-page cap, so that a larger
      // limit is not answered with a truncated head whose cursor already sits past everything
      // older than it.
      const newestFirst: DiscordMessage[] = [];
      let before: string | undefined;
      for (let page = 0; newestFirst.length < limit; page++) {
        const size = Math.min(limit - newestFirst.length, PAGE_LIMIT);
        const query = before === undefined ? `limit=${size}` : `limit=${size}&before=${before}`;
        const chunk = await this.pageWithin(args.topic, query, deadline, page);
        if (chunk === undefined || chunk.length === 0) break;
        newestFirst.push(...chunk);
        before = chunk.at(-1)!.id;
        if (chunk.length < size) break;
      }
      const messages = newestFirst.reverse().map((m) => toMessage(args.topic, m));
      return { messages, nextCursor: messages.at(-1)?.cursor ?? asCursor('0') };
    }

    if (blockMs <= 0) {
      return this.fetchSince(args.topic, args.since, limit, deadline);
    }

    // Native long-poll: the exclusive `since` query is empty, so wait on the SAME
    // gateway MESSAGE_CREATE stream the live path uses for a message on this channel — up to
    // blockMs — then re-run the exclusive REST query so ids/cursor stay canonical. Returning
    // early/empty is always safe (core polls the remaining budget), so any failure to establish
    // the live socket degrades gracefully to the immediate query. Keep EVERY leg — the connect and
    // both REST queries — inside the same `blockMs` budget, so that neither a gateway that accepts
    // the socket without completing the handshake nor a rate-limited REST query can stretch this
    // call past the cap core sized for the client's tool timeout.
    try {
      await withDeadline(this.ensureGateway(), blockMs);
    } catch {
      /* no socket → skip the wait below; the immediate page is still correct */
    }
    const socketLive = this.gatewayLive();
    const remaining = deadline - Date.now();
    const rawChannelId = this.channelId(args.topic);
    // Arm the waiter BEFORE the first query so a message landing during it can't be lost.
    const waiter = socketLive && remaining > 0 ? this.armWaiter(rawChannelId, remaining) : undefined;
    try {
      const first = await this.fetchWithin(args.topic, args.since, limit, deadline);
      if (first.messages.length > 0 || waiter === undefined) return first;
      await waiter.fired; // resolves on MESSAGE_CREATE for this channel, timeout, or disconnect
      if (this.stopped || Date.now() >= deadline) return first;
      return await this.fetchWithin(args.topic, args.since, limit, deadline);
    } finally {
      waiter?.cancel();
    }
  }

  /**
   * One catch-up walk bounded by the long-poll's own `deadline`. A budget spent while a query was
   * in flight answers the empty replayable page — core polls the rest of its budget and this call
   * still owes an answer within `blockMs`. A failure that arrives BEFORE the deadline is a real one
   * and propagates, so bounding the leg cannot hide a 404 or a 500. An ABSENT TOPIC escapes that
   * swallow whatever the clock says: it is a seam classification, not a transport failure, and a
   * classification that depends on the budget left when the 404 landed is one the caller cannot act
   * on.
   */
  private async fetchWithin(
    topic: Topic,
    since: Cursor,
    limit: number,
    deadline: number,
  ): Promise<FetchRecentResult> {
    try {
      return await this.fetchSince(topic, since, limit, deadline);
    } catch (err) {
      if (err instanceof NoSuchTopicError) throw err;
      if (Date.now() >= deadline) return { messages: [], nextCursor: since };
      throw err;
    }
  }

  /**
   * One exclusive-`since` catch-up walk. `?after=` is exclusive server-side; each page comes back
   * newest-first → reverse to ascending; for limit > 100, page forward advancing `after` to the
   * last (largest) returned id until filled, or a short page says the tail is reached, or the
   * call's shared `deadline` runs out. Empty → `nextCursor` echoes `since` (stable, replayable).
   */
  private async fetchSince(
    topic: Topic,
    since: Cursor,
    limit: number,
    deadline: number,
  ): Promise<FetchRecentResult> {
    const messages: Message[] = [];
    let after = String(since);
    for (let page = 0; messages.length < limit; page++) {
      const size = Math.min(limit - messages.length, PAGE_LIMIT);
      const query = `after=${encodeURIComponent(after)}&limit=${size}`;
      const chunk = await this.pageWithin(topic, query, deadline, page);
      if (chunk === undefined || chunk.length === 0) break;
      const ascending = chunk.reverse();
      for (const m of ascending) messages.push(toMessage(topic, m));
      after = ascending.at(-1)!.id;
      if (chunk.length < size) break;
    }
    return { messages, nextCursor: messages.at(-1)?.cursor ?? since };
  }

  /**
   * The `page`th page of a walk sharing ONE absolute `deadline`, or undefined once that deadline
   * has ended the walk. Re-read the clock per page, so that a limit spanning N pages cannot spend N
   * times the budget the caller set — a per-attempt DURATION restarts it on every round trip. Page
   * ZERO runs even on a spent budget ({@link MIN_QUERY_BUDGET_MS}): a call that answers an empty
   * window without ever asking is guessing. A failure on a LATER page whose deadline has passed
   * ends the walk rather than failing it, so a bounded call still answers with the pages it did
   * gather and a cursor to resume from; every other failure propagates.
   */
  private async pageWithin(
    topic: Topic,
    query: string,
    deadline: number,
    page: number,
  ): Promise<DiscordMessage[] | undefined> {
    const remaining = deadline - Date.now();
    const budget = page === 0 ? Math.max(remaining, MIN_QUERY_BUDGET_MS) : remaining;
    if (budget <= 0) return undefined;
    try {
      return await this.getMessages(topic, query, budget);
    } catch (err) {
      if (page === 0 || err instanceof NoSuchTopicError || Date.now() < deadline) throw err;
      return undefined;
    }
  }

  /**
   * One `GET /channels/<id>/messages` page (newest-first). A channel Discord does not know
   * (`10003 Unknown Channel`) is the seam's ABSENT TOPIC, not a failure: core maps
   * {@link NoSuchTopicError} to "topic not present yet" (an empty roster for `parley_list_users`),
   * while every other non-2xx — including a 404 that is not Unknown Channel, and `50001 Missing
   * Access`, which means the channel exists but this bot is misconfigured — stays a real failure.
   */
  private async getMessages(
    topic: Topic,
    query: string,
    deadlineMs?: number,
  ): Promise<DiscordMessage[]> {
    const path = `/channels/${encodeURIComponent(this.channelId(topic))}/messages?${query}`;
    const res = await this.http('GET', path, { allowStatuses: [404], deadlineMs });
    if (res.status === 404) {
      const raw = await res.text().catch(() => '');
      if (errorCode(raw) === UNKNOWN_CHANNEL) throw new NoSuchTopicError(topic as string);
      throw new Error(`Discord GET ${path} → 404: ${sanitizeBody(raw)}`);
    }
    return (await res.json()) as DiscordMessage[];
  }

  /**
   * Release every armed long-poll waiter (each `fire` clears its own timer and map entry). A woken
   * fetch re-runs its exclusive REST query, so this only has to signal "stop waiting".
   */
  private wakeWaiters(): void {
    for (const set of [...this.waiters.values()]) for (const fire of [...set]) fire();
  }

  /**
   * Arm a one-shot long-poll waiter on `channelId`, resolving `fired` when a MESSAGE_CREATE for
   * that channel arrives, when `blockMs` elapses, or when the socket goes away — a close and
   * `disconnect()` both run {@link wakeWaiters}. Idempotent `cancel()` (also invoked by the fire
   * path) clears the timer and de-registers, so no listener or timer can leak past the wait.
   */
  private armWaiter(channelId: string, blockMs: number): { fired: Promise<void>; cancel: () => void } {
    let resolveFired!: () => void;
    const fired = new Promise<void>((r) => {
      resolveFired = r;
    });
    let settled = false;
    const fire = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = this.waiters.get(channelId);
      if (set !== undefined) {
        set.delete(fire);
        if (set.size === 0) this.waiters.delete(channelId);
      }
      resolveFired();
    };
    const timer = setTimeout(fire, blockMs);
    let set = this.waiters.get(channelId);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(channelId, set);
    }
    set.add(fire);
    return { fired, cancel: fire };
  }

  /**
   * Live path = ONE shared gateway websocket per plugin instance, opened lazily on the first
   * subscribe (DESIGN §9 — genuine push events, not a poll timer). The gateway only ever emits
   * NEW `MESSAGE_CREATE`s, so a subscription naturally starts at the tail (history is owned by
   * catch-up). The first subscribe awaits HELLO → IDENTIFY → READY, so the socket is FULLY
   * established before this resolves; later subscribes just add their channel to the dispatch
   * map. Discord delivers a bot's own sends back as MESSAGE_CREATE, matching the other backends'
   * "including our own posts" live semantics.
   *
   * A TRANSIENT dial failure resolves rather than rejecting: the failed dial has already joined the
   * reconnect ladder, the gateway carries only NEW messages, and catch-up owns history — so a
   * subscription that goes live a backoff later loses nothing, while a rejection fails core's
   * attach and takes the REST half of the bridge down with it. A TERMINAL close still rejects,
   * because only a human can fix the token or the portal toggle.
   *
   * The channel is then checked once over REST. A channel that can never carry push (a DM class, a
   * category or forum container, no access) is ONE topic's misconfiguration, so it is a line on
   * stderr and a dropped subscription — rejecting fails core's attach and would take catch-up and
   * `post` for every OTHER topic down with it. An id Discord does not know at all is the seam's
   * absent topic and still rejects, because core is built to skip that one topic and carry on.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const channelId = this.channelId(topic);
    this.subs.set(channelId, { topic, handler });
    try {
      await this.ensureGateway();
    } catch (err) {
      if (err instanceof TerminalGatewayCloseError) {
        this.subs.delete(channelId);
        throw err;
      }
      this.warn(
        `live push for topic ${JSON.stringify(topic as string)} is not up yet ` +
          `(${reasonOf(err)}); ${
            this.reconnectTimer === undefined
              ? 'no reconnect is scheduled'
              : 'the reconnect ladder is retrying'
          }`,
      );
    }

    let unpushable: string | undefined;
    try {
      unpushable = await this.unpushableReason(topic, channelId);
    } catch (err) {
      if (err instanceof NoSuchTopicError) {
        this.subs.delete(channelId);
        throw err;
      }
      this.warn(
        `could not verify that topic ${JSON.stringify(topic as string)} can carry live push ` +
          `(${reasonOf(err)}); leaving the subscription wired`,
      );
      return;
    }
    if (unpushable !== undefined) {
      this.subs.delete(channelId);
      this.warn(
        `topic ${JSON.stringify(topic as string)} maps to channel ${channelId}, which ${unpushable}` +
          ' — this topic gets no live push; map it to a guild text channel instead',
      );
    }
  }

  /**
   * `GET /channels/<id>`, once per subscribed channel: why this channel can never carry a
   * `MESSAGE_CREATE` for this topic, or undefined when it can. An id Discord does not know throws
   * {@link NoSuchTopicError} (the seam's absent topic); a transport or server failure throws, and
   * the caller treats that as unverified rather than unpushable.
   */
  private async unpushableReason(topic: Topic, channelId: string): Promise<string | undefined> {
    const path = `/channels/${encodeURIComponent(channelId)}`;
    const res = await this.http('GET', path, { allowStatuses: [403, 404] });
    if (res.status === 403 || res.status === 404) {
      const raw = await res.text().catch(() => '');
      const code = errorCode(raw);
      if (code === UNKNOWN_CHANNEL) throw new NoSuchTopicError(topic as string);
      if (code === MISSING_ACCESS) {
        return (
          'this bot cannot access (50001 Missing Access) — invite the bot and grant View ' +
          'Channels / Read Message History'
        );
      }
      throw new Error(`Discord GET ${path} → ${res.status}: ${sanitizeBody(raw)}`);
    }
    const { type } = (await res.json()) as { type?: number };
    if (type === undefined || PUSHABLE_CHANNEL_TYPES.has(type)) return undefined;
    const named = CHANNEL_TYPE_NAMES.get(type) ?? 'a channel type that carries no guild messages';
    return (
      `is ${named} (type ${type}); the intent set is GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT ` +
      'with no DIRECT_MESSAGES, so no MESSAGE_CREATE can name it'
    );
  }

  /**
   * Every operator-facing diagnostic, on ONE line. Keep the scrub delegated to net-util's shared
   * neutralizer instead of a local character class, so that a family nobody listed — U+0085 NEL,
   * U+009B CSI, an ESC that rewrites the line above — cannot forge an entry in the operator's log.
   */
  private warn(line: string): void {
    process.stderr.write(`parley-discord: ${sanitizeBody(line)}\n`);
  }

  /**
   * Open the ONE shared gateway socket if it isn't up yet, and await READY. Used by both the live
   * path (`subscribe`) and native long-poll (`fetchRecent` blocking), so the blocking wait hooks
   * the SAME connection rather than opening a second one.
   */
  private async ensureGateway(): Promise<void> {
    if (this.fatalGateway !== undefined) throw this.fatalGateway;
    if (this.gatewayReady === undefined) {
      const wait = this.nextDialAt - Date.now();
      if (wait > 0) {
        throw new Error(`Discord gateway dial refused: backing off for another ${wait}ms`);
      }
      const epoch = this.sessionEpoch;
      this.gatewayReady = this.openGateway().catch((err) => {
        // Keep clearing the memo here, so that one failed dial does not wedge every later caller
        // on a rejected promise; the ladder openGateway just joined is what paces the retry.
        if (epoch === this.sessionEpoch) this.gatewayReady = undefined;
        throw err;
      });
    }
    await this.gatewayReady;
  }

  /**
   * A MESSAGE_CREATE-carrying socket exists right now. Distinct from `gatewayReady`, which is
   * memoized across the whole reconnect cycle: a long-poll that armed its waiter on the memoized
   * promise would sleep its entire budget on a socket that is down.
   */
  private gatewayLive(): boolean {
    return this.live && this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Charge one attempt against the shared IDENTIFY budget and return the delay it earned. Every
   * path that opens (or fails to open) a socket goes through this, so the sustained dial rate is
   * the backoff ladder regardless of who initiated it.
   */
  private chargeDialAttempt(): number {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempts++, this.reconnectCapMs);
    const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
    const wait = Math.max(this.invalidSessionWaitMs, backoff + jitter);
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = Date.now() + wait;
    return wait;
  }

  /**
   * Map a logical handle to a backend identity. Discord has NO global name → id lookup for
   * arbitrary users (search is per-guild and privileged), so only OUR OWN bot account resolves
   * to a real id (`GET /users/@me`, memoized); every other handle passes through as a string
   * convention (DESIGN §4).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    if (this.me === undefined) {
      this.me = (async () => {
        const res = await this.http('GET', '/users/@me');
        return (await res.json()) as { id: string; username: string };
      })().catch((err) => {
        this.me = undefined; // don't cache a transient failure
        throw err;
      });
    }
    const me = await this.me;
    if ((handle as string) === me.username) return { handle, backendRef: me.id };
    return { handle, backendRef: handle };
  }

  /**
   * Topic → Discord channel id: `channel_map` entry, else the topic string IS the channel id. A
   * literal that another topic already maps to is refused here rather than at one entry point, so
   * that the same Discord message can never cross the seam under two topic labels — which would
   * defeat core's per-topic dedup namespace and interleave the two topics' cursors.
   */
  private channelId(topic: Topic): string {
    const mapped = this.channelMap.get(topic as string);
    if (mapped !== undefined) return requireRoutableChannel(topic, mapped);
    const owner = this.channelOwner.get(topic as string);
    if (owner !== undefined) {
      throw new Error(
        `Discord topics ${JSON.stringify(owner)} and ${JSON.stringify(topic)} both ` +
          `resolve to channel ${topic as string}; give each topic its own channel_map target`,
      );
    }
    return requireRoutableChannel(topic, topic as string);
  }

  private require(): void {
    if (!this.connected) {
      throw new Error('DiscordPlugin not connected — call connect() first');
    }
  }

  /**
   * One dial attempt, end to end. A failed dial joins the same backoff-and-reopen loop every later
   * outage uses — keep the whole attempt inside it, URL RESOLUTION INCLUDED, so that the outage
   * most likely at process start (a 5xx or a 429 on `GET /gateway/bot`) is not the one case with no
   * in-plugin recovery.
   */
  private async openGateway(): Promise<void> {
    const epoch = this.sessionEpoch;
    try {
      await this.dial();
    } catch (err) {
      if (err instanceof TerminalGatewayCloseError) this.chargeDialAttempt();
      else this.scheduleReconnect(epoch);
      throw err;
    }
  }

  /**
   * Resolve the gateway wss URL (config override for tests/fakes; else `GET /gateway/bot`) and open
   * the socket. Re-resolved per attempt: Discord does not promise the url survives an outage.
   */
  private async dial(): Promise<void> {
    const base = this.gatewayUrlOverride ?? (await this.resolveGatewayUrl());
    await this.openSocket(gatewayDialUrl(base));
  }

  private async resolveGatewayUrl(): Promise<string> {
    const res = await this.http('GET', '/gateway/bot');
    return ((await res.json()) as { url: string }).url;
  }

  /**
   * Open (or re-open) the gateway socket; resolves on READY. Minimal protocol subset:
   * HELLO (op 10) → start the heartbeat interval (op 1 echoing the last dispatch seq `s`) and
   * send IDENTIFY (op 2); READY (op 0) resolves; op 11 acks are ignored beyond liveness.
   *
   * Reconnect (close / op 7 RECONNECT / op 9 INVALID SESSION while running): capped exponential
   * backoff with jitter (`scheduleReconnect`), reopen, re-IDENTIFY — except a TERMINAL close code
   * (auth/intent/version/shard) stops the loop instead of burning the IDENTIFY budget.
   * RESUME is deliberately SKIPPED — the push gap during the outage is harmless, because the live
   * path is best-effort and cursor catch-up (`fetchRecent` since the last persisted cursor)
   * reconciles anything missed (DESIGN §6).
   */
  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const epoch = this.sessionEpoch;
      const ws = new WebSocket(url);
      this.ws = ws;
      let ready = false;
      let readyAt = 0;
      let heartbeat: NodeJS.Timeout | undefined;
      let awaitedAck = false;
      let identified = false;
      // A socket Discord (or a proxy) accepts but never carries to READY would otherwise park
      // this promise forever — and with it subscribe(), bridge startup, and every blocking
      // fetchRecent that awaits the same gateway.
      const handshake = setTimeout(() => {
        if (ready) return;
        reject(
          new Error(
            `Discord gateway handshake timed out after ${this.handshakeTimeoutMs}ms (no READY)`,
          ),
        );
        ws.terminate();
      }, this.handshakeTimeoutMs);

      ws.on('message', (data) => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
          // Superseded, post-disconnect, or already closed by a branch below: such a socket owns
          // none of the shared state, and IDENTIFYing from here would spend budget on a connection
          // nothing reads. Keep the readyState half, so that a peer which keeps sending after we
          // closed cannot drive one diagnostic per frame while the close handshake finishes.
          ws.close();
          return;
        }
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(String(data)) as GatewayPayload;
        } catch {
          return; // not JSON — not ours to crash on
        }
        // Keep EVERY branch below inside this boundary, so that a frame no opcode branch expected
        // ends one socket instead of the process: a throw in a `ws` listener is an
        // uncaughtException, which takes the REST half and every other topic down with it.
        try {
          switch (payload.op) {
            case OP.HELLO: {
              // Discord sends exactly ONE HELLO per connection, and an IDENTIFY is the scarce
              // thing here: keep the send behind this flag, so that a peer repeating HELLO on an
              // open socket cannot spend the 1000-IDENTIFY-per-24h quota at its own frame rate —
              // the penalty is a bot-token RESET that breaks every Parley instance sharing it.
              if (identified) {
                this.warn(
                  'gateway sent a second HELLO on a socket that has already IDENTIFYed; ' +
                    'closing it so the ladder paces the next attempt',
                );
                ws.close();
                break;
              }
              const interval = heartbeatIntervalOf(payload.d);
              if (interval === undefined) {
                this.warn(
                  'gateway sent a HELLO with no usable heartbeat_interval ' +
                    `(${shapeOf(payload.d)}); closing the socket so the ladder retries`,
                );
                ws.close();
                break;
              }
              heartbeat = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (awaitedAck) {
                  // The previous beat was never ACKed (op 11) → the TCP connection is half-dead.
                  // terminate() (NOT close()) forces the `close` event IMMEDIATELY, so the existing
                  // close→scheduleReconnect path takes over within ONE interval instead of
                  // buffering beats into a dead socket for the ~15–25 min kernel TCP timeout.
                  ws.terminate();
                  return;
                }
                // Arm BEFORE sending, so that an ACK arriving in the same tick clears the flag it
                // was meant to clear instead of being overwritten into a false "missed ack".
                awaitedAck = true;
                ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
              }, interval);
              this.heartbeats.add(heartbeat);
              identified = true;
              ws.send(
                JSON.stringify({
                  op: OP.IDENTIFY,
                  d: {
                    token: this.token ?? '',
                    intents: INTENTS,
                    properties: { os: 'linux', browser: 'parley', device: 'parley' },
                  },
                }),
              );
              break;
            }
            case OP.DISPATCH: {
              if (typeof payload.s === 'number') this.seq = payload.s;
              if (payload.t === 'READY' && !ready) {
                ready = true;
                readyAt = Date.now();
                this.live = true;
                clearTimeout(handshake);
                resolve();
              } else if (payload.t === 'MESSAGE_CREATE') {
                const d = dispatchedMessage(payload.d);
                if (d === undefined) {
                  this.warn(
                    `gateway sent a MESSAGE_CREATE with no usable id or channel_id (${shapeOf(
                      payload.d,
                    )}); dropping it`,
                  );
                  break;
                }
                const sub = this.subs.get(d.channel_id);
                if (sub !== undefined) {
                  try {
                    sub.handler(toMessage(sub.topic, d));
                  } catch {
                    /* handler is best-effort; never break the loop (DESIGN §6) */
                  }
                }
                const waiting = this.waiters.get(d.channel_id);
                if (waiting !== undefined) for (const fire of [...waiting]) fire();
              }
              break;
            }
            case OP.HEARTBEAT: {
              ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
              break;
            }
            case OP.RECONNECT: {
              ws.close();
              break;
            }
            case OP.INVALID_SESSION: {
              this.invalidSessionWaitMs =
                INVALID_SESSION_MIN_WAIT_MS + Math.floor(Math.random() * INVALID_SESSION_SPREAD_MS);
              ws.close();
              break;
            }
            case OP.HEARTBEAT_ACK: {
              awaitedAck = false;
              break;
            }
            default:
              break;
          }
        } catch (err) {
          this.warn(
            `gateway frame op ${String(payload.op)} could not be handled ` +
              `(${reasonOf(err)}); closing the socket so the ladder retries`,
          );
          ws.close();
        }
      });

      ws.on('error', () => {
        /* the paired close event drives teardown/reconnect; don't crash the process */
      });

      ws.on('close', (code: number) => {
        clearTimeout(handshake);
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          this.heartbeats.delete(heartbeat);
          heartbeat = undefined;
        }
        const terminal = TERMINAL_CLOSE.has(code);
        const err = terminal
          ? new TerminalGatewayCloseError(
              `Discord gateway closed with terminal code ${code} — check the bot token and the ` +
                'MESSAGE CONTENT privileged intent; live push is down until this bridge restarts',
            )
          : new Error(`Discord gateway closed before READY (code ${code})`);
        if (!ready) reject(err);
        // Keep every mutation below behind this check, so that a close delivered after the plugin
        // moved on — real `ws` emits it a tick late — cannot mark the NEXT session fatal.
        if (this.ws !== ws) return;
        this.ws = undefined;
        this.live = false;
        if (!this.stopped) {
          if (terminal) {
            this.gatewayReady = undefined;
            this.fatalGateway = err;
            process.stderr.write(`parley-discord: ${err.message}\n`);
          } else if (ready) {
            if (Date.now() - readyAt >= STABLE_CONNECTION_MS) this.reconnectAttempts = 0;
            this.scheduleReconnect(epoch);
          }
        }
        // The socket that would have woken them is gone: release every blocked long-poll so it
        // re-queries REST now and hands the rest of its budget back to core's poll fallback.
        this.wakeWaiters();
      });
    });
  }

  /**
   * Backoff-and-reopen loop (re-IDENTIFY, no RESUME) until disconnect(), spending the same dial
   * budget every other path spends ({@link chargeDialAttempt}). A terminal close short-circuits it
   * (openSocket rejects with TerminalGatewayCloseError).
   */
  private scheduleReconnect(epoch: number): void {
    if (this.stopped || epoch !== this.sessionEpoch) return;
    const wait = this.chargeDialAttempt();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped || epoch !== this.sessionEpoch) return;
      // Dial through the memo every other caller awaits, so that a re-entrant caller (core's 250 ms
      // long-poll fallback) cannot open a second socket alongside this one and double the IDENTIFY
      // rate the ladder is pacing.
      const attempt = this.dial().catch((err: unknown) => {
        if (epoch === this.sessionEpoch) this.gatewayReady = undefined;
        if (!(err instanceof TerminalGatewayCloseError)) this.scheduleReconnect(epoch);
        throw err;
      });
      this.gatewayReady = attempt;
      void attempt.catch(() => undefined);
    }, wait);
  }

  /**
   * Single HTTP entry point. Adds `Authorization: Bot <token>` and Discord's required
   * {@link USER_AGENT}, JSON encodes, and transparently
   * retries on 429 honoring Discord's JSON `retry_after` (SECONDS, float — converted to ms).
   * Retries stop the moment we disconnect, so an aborted test never leaves a loop hammering the
   * API. Throws on unexpected non-2xx.
   */
  private async http(
    method: string,
    path: string,
    opts?: { body?: unknown; allowStatuses?: number[]; deadlineMs?: number },
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (this.token !== undefined) headers.Authorization = `Bot ${this.token}`;
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      {
        label: `Discord ${method} ${path}`,
        // Stop retrying once disconnected — don't compete for the rate-limit budget post-teardown.
        isStopped: () => this.stopped,
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
        deadlineMs: opts?.deadlineMs,
      },
    );
  }
}

/**
 * Reject a `channel_map` whose targets are not distinct, and return the channel id → owning topic
 * reverse index. Two topics folding onto one channel makes the topic → channel map non-injective,
 * which silently drops one topic's subscription and relabels its traffic as the other's (core's
 * `safeName` guards the same class the other way).
 */
function requireDistinctChannels(map: Map<string, string>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [topic, channel] of map) {
    const prior = owner.get(channel);
    if (prior !== undefined) {
      throw new Error(
        `Discord channel_map maps both ${JSON.stringify(prior)} and ${JSON.stringify(topic)} to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    owner.set(channel, topic);
  }
  return owner;
}

/**
 * The url actually dialed: the resolved (or overridden) base carrying {@link GATEWAY_QUERY}. The
 * params are SET rather than defaulted, so that a base carrying a stale `v` or an `encoding` this
 * plugin cannot parse never decides the wire format; every other param on the base survives.
 */
function gatewayDialUrl(base: string): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(GATEWAY_QUERY)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Every configured endpoint that would carry the bot token in the clear, phrased for the operator's
 * stderr. A warning rather than a load error, so that a loopback fake or a dev proxy still runs.
 */
function plaintextCredentialRisks(cfg: DiscordBackendConfig): string[] {
  const endpoints: Array<[key: string, value: string | undefined, carries: string]> = [
    ['api_url', cfg.api_url, 'the `Authorization: Bot <token>` header of every REST call'],
    ['gateway_url', cfg.gateway_url, 'the bot token in the gateway IDENTIFY'],
  ];
  const risks: string[] = [];
  for (const [key, value, carries] of endpoints) {
    if (value === undefined) continue;
    const plaintext = plaintextRemoteOrigin(value);
    if (plaintext === undefined) continue;
    risks.push(
      `backend_config.${key} ${plaintext.origin} is a plaintext scheme to a non-loopback host, so ` +
        `${carries} crosses the network unencrypted, where anyone on the path can take the token ` +
        `and post as this bot. Use ${plaintext.secure} for any remote endpoint.`,
    );
  }
  return risks;
}

/** The origin of a plaintext-scheme URL to a non-loopback host, with the scheme to use instead. */
function plaintextRemoteOrigin(raw: string): { origin: string; secure: string } | undefined {
  try {
    const { protocol, hostname, origin } = new URL(raw);
    const secure = PLAINTEXT_SCHEMES.get(protocol);
    return secure !== undefined && !isLoopbackHost(hostname) ? { origin, secure } : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Length in the unit Discord's 2000-character cap counts: CODE POINTS, not UTF-16 code units. Keep
 * the spread, so that astral text (emoji, CJK extensions, historic scripts) is not refused at half
 * the real limit under a length the provider never measured.
 */
const countCharacters = (content: string): number => [...content].length;

/** The text of a caught rejection, for a diagnostic that must never crash on a non-Error. */
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** How a refused gateway payload is named in a diagnostic, without quoting the payload itself. */
const shapeOf = (d: unknown): string => (d === null ? 'null' : `a ${typeof d}`);

/**
 * A HELLO's heartbeat period, or undefined when the gateway sent no usable one. Refuse a
 * non-positive interval as well as a missing one, so that a `0` cannot turn `setInterval` into a
 * per-millisecond beat against Discord's rate limiter.
 */
function heartbeatIntervalOf(d: unknown): number | undefined {
  if (typeof d !== 'object' || d === null) return undefined;
  const { heartbeat_interval: ms } = d as { heartbeat_interval?: unknown };
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * A MESSAGE_CREATE payload, or undefined when it carries no usable routing key or id. `id` becomes
 * both `backendMsgId` and `cursor`, so a frame without one would cross the seam carrying `undefined`
 * into core's dedup set and into the cursor it persists for the topic.
 */
function dispatchedMessage(d: unknown): DiscordMessage | undefined {
  if (typeof d !== 'object' || d === null) return undefined;
  const { channel_id: channel, id } = d as { channel_id?: unknown; id?: unknown };
  return typeof channel === 'string' && typeof id === 'string'
    ? (d as unknown as DiscordMessage)
    : undefined;
}

/** Discord's numeric error code from a JSON error body, or undefined when the body is not one. */
function errorCode(raw: string): number | undefined {
  try {
    const { code } = JSON.parse(raw) as { code?: number };
    return typeof code === 'number' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a channel id that cannot survive as a path segment. `encodeURIComponent` is what keeps a
 * topic string inside `/channels/<id>/…`, and it leaves `.` and `..` untouched — but those are DOT
 * SEGMENTS, which the URL parser removes, so such an id silently retargets the call at a different
 * Discord route instead of naming a channel. Keep the refusal here, so that every entry point
 * resolving a topic is covered by one check.
 */
function requireRoutableChannel(topic: Topic, id: string): string {
  if (id === '' || /^\.{1,2}$/.test(id)) {
    throw new Error(
      `Discord topic ${JSON.stringify(topic as string)} resolves to channel id ` +
        `${JSON.stringify(id)}, which is not a usable URL path segment; point the topic at a real ` +
        'channel id (directly or through channel_map)',
    );
  }
  return id;
}

/**
 * Reject a `gateway_dialers` that is not an integer ≥ 1. It divides ONE bot token's IDENTIFY quota,
 * so a zero or fractional value silently shrinks the reconnect ceiling instead of widening it, and
 * the penalty for overrunning the quota is a token RESET.
 */
function requireDialerCount(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Discord gateway_dialers must be an integer >= 1 (how many instances share this bot ` +
        `token and open a gateway socket); got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Settle with `p`, or reject at `ms` — the caller's budget, not the callee's, wins. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rejectDeadline) => {
      timer = setTimeout(() => rejectDeadline(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function toMessage(topic: Topic, m: DiscordMessage): Message {
  return buildMessage({
    topic,
    sender: m.author?.username ?? '',
    content: renderMentions(m),
    timestamp: m.timestamp ?? '',
    id: m.id,
  });
}

/** `<@id>` / `<@!id>` — how Discord serializes a user mention; NEVER the `@handle` text. */
const USER_MENTION_RE = /<@!?(\d+)>/g;

/**
 * Rewrite Discord's user-mention markup to the `@username` form core's `parseMentions` reads, using
 * the payload's own resolved `mentions[]`. Without this every mention crossing the seam is a raw
 * snowflake, so `Message.mentions` never holds a Parley handle and core's mention filter drops
 * every message. An id Discord did not resolve renders as Discord's own client renders it.
 */
function renderMentions(m: DiscordMessage): string {
  const content = m.content ?? '';
  if (content === '') return content;
  const byId = new Map((m.mentions ?? []).map((u) => [u.id, u.username]));
  return content.replace(
    USER_MENTION_RE,
    (_raw, id: string) => `@${byId.get(id) ?? 'unknown-user'}`,
  );
}

/**
 * Discord's 429 hint: the standard `Retry-After` header, else Discord's own `retry_after` body
 * field (SECONDS, float). Return it UNCLAMPED, so that we never retry sooner than Discord asked —
 * that is what escalates a rate limit into a ban. net-util honours a stated wait in full and
 * refuses one that cannot fit the call's deadline.
 */
async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { retry_after?: number };
    const seconds = json.retry_after;
    return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}
