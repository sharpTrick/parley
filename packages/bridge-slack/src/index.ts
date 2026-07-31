import {
  asBackendMsgId,
  asTopic,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import {
  ABSENT_ON_READ,
  ABSENT_ON_WRITE,
  type AuthTestResponse,
  asSeamError,
  type HistoryResponse,
  slackApiCall,
  SlackApiError,
  SlackShapeError,
} from './api.js';
import {
  configRisks,
  resolveConfig,
  type SlackBackendConfig,
  type SlackSettings,
} from './config.js';
import { SlackHistory } from './history.js';
import { SocketModeLink } from './link.js';
import { escapeSlackText } from './markup.js';
import { TS_RE } from './messages.js';

export type { SlackBackendConfig } from './config.js';
export { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_ROTATION_GRACE_MS } from './socket.js';
export { DIAL_BACKOFF_MS, MAX_DIAL_BACKOFF_MS, requireUsableSocketUrl } from './socket.js';
export { HISTORY_PAGE_LIMIT, MAX_HISTORY_PAGES } from './api.js';
export { MAX_TIMER_MS, TIMER_CONFIG_KEYS, TOKEN_CONFIG_KEYS } from './config.js';
export { compareTs, TS_RE } from './messages.js';
export { escapeSlackText, unescapeSlackText } from './markup.js';

/**
 * Slack backend (DESIGN §6/§9) over the raw Web API (`fetch`) + Socket Mode (`ws`) — no Slack SDK.
 * Slack is a hosted SaaS, unlike the self-hosted core backends — history durability, availability,
 * and identity live under Slack's policy (and retention limits on free plans), not yours.
 *
 * A topic maps to a channel id via `channel_map` (unmapped topics are channel-id literals); the
 * per-channel `ts` is BOTH `backendMsgId` (dedup key) and `cursor` (order key), see
 * {@link compareTs}. "Strictly after a cursor" is resolved server-side: `conversations.history`
 * treats `oldest` as EXCLUSIVE when `inclusive` is omitted, and any gap across a reconnect is
 * reconciled by cursor catch-up (DESIGN §6).
 */
export class SlackPlugin implements BackendPlugin {
  private settings = resolveConfig({});
  /** channel id → its one allowed topic: seeded from `channel_map`, then claimed first-come. */
  private readonly channelOwner = new Map<string, Topic>();
  private connected = false;
  private stopped = false;
  /** Bumped by every {@link disconnect}; a loop from a retired session must not act on wake. */
  private session = 0;
  /** Memoized `auth.test` (our own bot identity) for {@link resolveIdentity}. */
  private authTestPromise?: Promise<AuthTestResponse>;
  /** What the pieces below are allowed to know about the plugin that owns them. */
  private readonly host = {
    settings: (): SlackSettings => this.settings,
    stopped: (): boolean => this.stopped,
    session: (): number => this.session,
    channelFor: (topic: Topic): string => this.channelFor(topic),
    requireConnected: (): void => this.require(),
  };
  private readonly api = slackApiCall(this.host);
  private readonly link = new SocketModeLink(this.api, this.host);
  private readonly history = new SlackHistory(this.api, this.link, this.host);

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as SlackBackendConfig;
    // Keep every rejection ahead of the stand-down, so that a refused config leaves a working
    // connection running instead of tearing it down on the way to a load error.
    const settings = resolveConfig(cfg);
    // A second connect() inherits nothing: the previous session's routes, sockets and memoized
    // `auth.test` belong to its tokens, and leaving them would feed a handler the new
    // configuration never registered, off a socket it never opened.
    if (this.connected) await this.disconnect();
    for (const risk of configRisks(cfg)) console.warn(`[parley-slack] SECURITY: ${risk}`);
    this.settings = settings;
    this.channelOwner.clear();
    // Keep configuration claiming its channels HERE, before any call arrives, so that an ad-hoc
    // caller-supplied topic naming a mapped channel-id literal is the side that loses the collision
    // — otherwise one `post` can permanently disable a configured topic (DESIGN §14).
    for (const [topic, channel] of Object.entries(settings.channelMap)) {
      this.channelOwner.set(channel, asTopic(topic));
    }
    this.stopped = false;
    this.connected = true;
    this.link.reset();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    // Retire the session id every parked loop captured, so that a `reconnect()` sitting in its
    // backoff cannot resume against a LATER connect()'s configuration — it would open a socket the
    // new session never asked for, behind no subscribe at all.
    this.session++;
    this.link.stop();
    this.channelOwner.clear();
    this.authTestPromise = undefined;
  }

  /**
   * `chat.postMessage`. Threading is an approximation: `inReplyTo` becomes `thread_ts` plus
   * `reply_broadcast`, so Slack ALSO files a channel-level `thread_broadcast` under the same `ts`.
   * Keep the broadcast, so that the id this returns names a message both seam read paths can reach
   * — neither surfaces a plain thread reply, so without it a successful write is unreadable
   * through the seam that made it.
   * `identity` is the logical sender only — Slack stamps our bot user as the wire sender.
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const body: Record<string, unknown> = {
      channel: this.channelFor(topic),
      text: escapeSlackText(content),
    };
    if (opts?.inReplyTo !== undefined) {
      body.thread_ts = opts.inReplyTo;
      body.reply_broadcast = true;
    }
    const resp = await this.api<{ ok: boolean; ts?: string }>('chat.postMessage', body).catch(
      asSeamError(topic, ABSENT_ON_WRITE),
    );
    // Branding whatever came back would hand core an undefined dedup key that collapses with every
    // other one.
    if (typeof resp.ts !== 'string' || !TS_RE.test(resp.ts)) {
      throw new SlackShapeError(
        'chat.postMessage',
        `returned no usable ts for topic ${JSON.stringify(topic)}`,
      );
    }
    return asBackendMsgId(resp.ts);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    // Captured BEFORE the first read, so that the session a blocked call belongs to is the one it
    // was CALLED in: that read can straddle a `disconnect()` + `connect()`, and a session read
    // after it would be the new one's — leaving the block below with nothing to notice.
    const session = this.session;
    const first = await this.history.runFetch(args);

    const blockMs = args.blockMs ?? 0;
    if (blockMs <= 0 || args.since === undefined || first.messages.length > 0) {
      return first;
    }
    return this.history.blockForMessage(args, first.nextCursor, Date.now() + blockMs, session);
  }

  /**
   * Live path = ONE shared Socket Mode websocket (DESIGN §9 — genuine Events API pushes, not a
   * poll timer). The socket is established — `hello` received — before this resolves, so a post
   * immediately after subscribe() is pushed. Slack pushes only NEW events, so the subscription
   * starts at the tail and history stays owned by catch-up.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const channel = this.channelFor(topic);
    const registration = { topic, handler };
    this.link.routes.set(channel, registration);
    try {
      await this.link.ensureSocket();
      // Socket Mode says nothing about whether this channel exists or is readable, so a typo'd
      // `channel_map` target would otherwise subscribe successfully and deliver nothing, forever.
      // Probe it, so that absence reaches core as the seam's own answer and gets logged and skipped.
      await this.api<HistoryResponse>('conversations.history', { channel, limit: 1 }).catch(
        asSeamError(topic, ABSENT_ON_READ),
      );
    } catch (e: unknown) {
      // A rejected subscribe is not subscribed. Keep the delete conditional on the route still
      // being THIS call's, so that a rejection arriving after a `disconnect()` + `connect()` — the
      // probe outlives both — cannot silently unsubscribe the channel the NEW session registered,
      // leaving a `subscribe` that resolved and delivers nothing.
      if (this.link.routes.get(channel) === registration) this.link.routes.delete(channel);
      throw e;
    }
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
        const resp = await this.api<{ ok: boolean; user?: { id?: unknown } }>(
          'users.lookupByEmail',
          { email: handle },
        );
        const id = resp.user?.id;
        if (typeof id !== 'string' || id.length === 0) {
          throw new SlackShapeError('users.lookupByEmail', 'returned no usable user.id');
        }
        return { handle, backendRef: id };
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
   * every seam method rejects a second topic folding onto an owned channel — a guard living in
   * `subscribe` alone would leave `post`/`fetchRecent` free to relabel one topic's traffic as the
   * other's, crossing dedup and allowlist namespaces.
   */
  private channelFor(topic: Topic): string {
    const channel = this.settings.channelMap[topic] ?? topic;
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
    if (this.authTestPromise === undefined) {
      const attempt: Promise<AuthTestResponse> = this.api<AuthTestResponse>('auth.test', {}).catch(
        (err: unknown) => {
          // Don't memoize failure — and clear only OUR OWN entry, so that a rejection landing after
          // a `disconnect()` + `connect()` cannot evict the new session's answer.
          if (this.authTestPromise === attempt) this.authTestPromise = undefined;
          throw err;
        },
      );
      this.authTestPromise = attempt;
    }
    return this.authTestPromise;
  }

  private require(): void {
    if (!this.connected) {
      throw new Error('SlackPlugin not connected — call connect() first');
    }
  }
}
