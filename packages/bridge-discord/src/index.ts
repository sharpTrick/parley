import {
  asBackendMsgId,
  asCursor,
  NoSuchTopicError,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS, isLoopbackHost, sanitizeBody } from '@sharptrick/parley-net-util';
import { newestWindow, windowSince, type PageFn } from './catchup.js';
import {
  DEFAULT_ALLOWED_MENTIONS,
  requireDistinctChannels,
  requireReconnectCap,
  requireRoutableChannel,
  type AllowedMentions,
  type DiscordBackendConfig,
} from './config.js';
import { reasonOf, warn } from './diagnostics.js';
import { DiscordGateway, TerminalGatewayCloseError } from './gateway.js';
import { DiscordRest } from './rest.js';
import {
  CONTENT_LIMIT,
  countCharacters,
  errorCode,
  hasUsableId,
  MISSING_ACCESS,
  pageRecords,
  toMessage,
  UNKNOWN_CHANNEL,
  unpushableChannelReason,
  type DiscordMessage,
} from './wire.js';

export { REQUIRED_INTENTS } from './intents.js';
export type { AllowedMentions, DiscordBackendConfig } from './config.js';
export {
  BACKOFF_BASE_MS,
  BACKOFF_JITTER_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  INVALID_SESSION_MIN_WAIT_MS,
  INVALID_SESSION_SPREAD_MS,
  RECONNECT_CAP_MS,
  STABLE_CONNECTION_MS,
} from './gateway.js';

/**
 * Discord backend (DESIGN §6/§9); the README carries the seam mapping and the hosted-SaaS
 * positioning. One topic = one channel, and the message snowflake is BOTH `backendMsgId` and
 * `cursor`. Snowflakes are DECIMAL strings and NOT lexically comparable, so keep every "strictly
 * after" resolved server-side by the exclusive `?after=`, so that no local ordering can compare
 * them as text; a comparison this plugin genuinely needed would have to go through `BigInt`.
 */
export class DiscordPlugin implements BackendPlugin {
  private channelMap = new Map<string, string>();
  /** Reverse of {@link channelMap}: channel id → the ONE topic that owns it. */
  private channelOwner = new Map<string, string>();
  private allowedMentions: AllowedMentions = DEFAULT_ALLOWED_MENTIONS;
  private connected = false;
  private stopped = false;
  private readonly rest = new DiscordRest(() => this.stopped);
  private readonly gateway = new DiscordGateway(this.rest, {
    isStopped: () => this.stopped,
    onMessage: (m) => this.dispatch(m),
    onSocketGone: () => this.wakeWaiters(),
  });
  /** channel id → subscription; MESSAGE_CREATE dispatch routes through this. */
  private readonly subs = new Map<string, { topic: Topic; handler: MessageHandler }>();
  /**
   * Native long-poll wakeups: channel id → one-shot callbacks armed by a blocking `fetchRecent`,
   * fired by a MESSAGE_CREATE on that channel or by the socket going away. Keep them independent
   * of `subs` and listening on the SHARED socket, so that a blocking fetch never opens a second
   * gateway connection or registers a subscription core did not ask for.
   */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Memoized `GET /users/@me` (the bot's own account), for resolveIdentity. */
  private me?: Promise<{ id: string; username: string }>;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as DiscordBackendConfig;
    const channelMap = new Map(Object.entries(cfg.channel_map ?? {}));
    const channelOwner = requireDistinctChannels(channelMap);
    const reconnectCapMs = requireReconnectCap(cfg.gateway_dialers);

    // Retire the previous session BEFORE installing the new config, so that a re-entrant connect()
    // cannot leave the old socket dispatching into a plugin whose `live` flag says there is none —
    // which silently degrades every later native long-poll to an immediate return.
    this.stopped = true;
    this.gateway.restart(cfg, reconnectCapMs);
    this.forgetTopics();

    this.rest.configure(cfg.api_url, cfg.token);
    this.channelMap = channelMap;
    this.channelOwner = channelOwner;
    this.allowedMentions = cfg.allowed_mentions ?? DEFAULT_ALLOWED_MENTIONS;
    this.stopped = false;
    this.connected = true;

    for (const risk of plaintextCredentialRisks(cfg)) warn(`SECURITY: ${risk}`);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.gateway.stop();
    this.forgetTopics();
  }

  private forgetTopics(): void {
    this.subs.clear();
    this.wakeWaiters();
    this.waiters.clear();
    this.me = undefined;
  }

  /**
   * `POST /channels/<id>/messages`. The seam's `identity` is deliberately unused: Discord stamps
   * `author` from the configured bot token, so per-session attribution needs a per-session token.
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
    const res = await this.rest.request(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/messages`,
      {
        body: {
          content,
          allowed_mentions: this.allowedMentions,
          message_reference:
            opts?.inReplyTo !== undefined ? { message_id: opts.inReplyTo } : undefined,
        },
      },
    );
    const json: unknown = await res.json();
    if (!hasUsableId(json)) {
      throw new Error(
        'Discord POST /channels/<id>/messages answered 200 with no usable message id; the post ' +
          'may or may not have landed, and there is no backendMsgId to dedup or reply to',
      );
    }
    return asBackendMsgId(json.id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const limit = args.limit ?? 100;
    const blockMs = args.blockMs ?? 0;
    const deadline = Date.now() + (blockMs > 0 ? blockMs : DEFAULT_DEADLINE_MS);

    if (args.since === undefined) {
      const records = await newestWindow(this.pager(args.topic), limit, deadline);
      const messages = records.map((m) => toMessage(args.topic, m));
      return { messages, nextCursor: messages.at(-1)?.cursor ?? asCursor('0') };
    }

    if (blockMs <= 0) {
      return this.fetchSince(args.topic, args.since, limit, deadline);
    }

    // Native long-poll: wait on the SAME gateway MESSAGE_CREATE stream the live path uses, then
    // re-run the exclusive REST query so ids/cursor stay canonical. Keep EVERY leg — the connect
    // and both REST queries — inside the one `blockMs` budget, so that neither a gateway that
    // accepts the socket without completing the handshake nor a rate-limited REST query can
    // stretch this call past the cap core sized for the client's tool timeout. Returning
    // early/empty is always safe: core polls the rest of its own budget.
    try {
      await withDeadline(this.gateway.ensureUp(), blockMs);
    } catch {
      /* no socket → skip the wait below; the immediate page is still correct */
    }
    const socketLive = this.gateway.isLive();
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
   * One catch-up walk bounded by the long-poll's own `deadline`: a budget spent while a query was
   * in flight answers the empty replayable page. Keep the swallow behind an EXPIRED clock and let
   * an ABSENT TOPIC through it whatever the clock says, so that bounding this leg can hide neither
   * a real 404 or 500 nor a seam classification the caller has to act on.
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

  /** Empty → `nextCursor` echoes `since` (stable, replayable). */
  private async fetchSince(
    topic: Topic,
    since: Cursor,
    limit: number,
    deadline: number,
  ): Promise<FetchRecentResult> {
    const records = await windowSince(this.pager(topic), String(since), limit, deadline);
    const messages = records.map((m) => toMessage(topic, m));
    return { messages, nextCursor: messages.at(-1)?.cursor ?? since };
  }

  /**
   * One `GET /channels/<id>/messages` page (newest-first) for `topic`. Keep ONLY `10003 Unknown
   * Channel` mapped to the seam's absent topic, so that a 404 that is not it, and `50001 Missing
   * Access` — the channel exists and this bot is misconfigured — stay real failures instead of
   * reading to core as "topic not present yet".
   */
  private pager(topic: Topic): PageFn {
    return async (query, budgetMs) => {
      const path = `/channels/${encodeURIComponent(this.channelId(topic))}/messages?${query}`;
      const res = await this.rest.request('GET', path, {
        allowStatuses: [404],
        deadlineMs: budgetMs,
      });
      if (res.status === 404) {
        const raw = await res.text().catch(() => '');
        if (errorCode(raw) === UNKNOWN_CHANNEL) throw new NoSuchTopicError(topic as string);
        throw new Error(`Discord GET ${path} → 404: ${sanitizeBody(raw)}`);
      }
      return pageRecords(path, await res.json());
    };
  }

  private wakeWaiters(): void {
    for (const set of [...this.waiters.values()]) for (const fire of [...set]) fire();
  }

  private dispatch(m: DiscordMessage): void {
    const sub = this.subs.get(m.channel_id);
    if (sub !== undefined) {
      try {
        sub.handler(toMessage(sub.topic, m));
      } catch {
        /* handler is best-effort; never break the loop (DESIGN §6) */
      }
    }
    const waiting = this.waiters.get(m.channel_id);
    if (waiting !== undefined) for (const fire of [...waiting]) fire();
  }

  /**
   * Arm a one-shot waiter on `channelId`: `fired` resolves on a MESSAGE_CREATE for that channel,
   * at `blockMs`, or when the socket goes away. Keep `cancel()` idempotent and shared with the fire
   * path, so that no timer or map entry can leak past the wait.
   */
  private armWaiter(
    channelId: string,
    blockMs: number,
  ): { fired: Promise<void>; cancel: () => void } {
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
   * Live path = the ONE shared gateway socket, opened lazily here, then a single REST check of the
   * channel. The README's `subscribe` row is the contract; the risk it exists for is that this
   * method decides the fate of the WHOLE bridge. Keep a transient dial failure and an unpushable
   * channel non-fatal, so that ONE topic's outage or misconfiguration cannot fail core's attach and
   * take catch-up and `post` for every other topic with it. A TERMINAL close and an id Discord does
   * not know still reject: the first needs a human, the second is the one topic core skips.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const channelId = this.channelId(topic);
    this.subs.set(channelId, { topic, handler });
    try {
      await this.gateway.ensureUp();
    } catch (err) {
      if (err instanceof TerminalGatewayCloseError) {
        this.subs.delete(channelId);
        throw err;
      }
      warn(
        `live push for topic ${JSON.stringify(topic as string)} is not up yet ` +
          `(${reasonOf(err)}); ${
            this.gateway.reconnectPending
              ? 'the reconnect ladder is retrying'
              : 'no reconnect is scheduled'
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
      warn(
        `could not verify that topic ${JSON.stringify(topic as string)} can carry live push ` +
          `(${reasonOf(err)}); leaving the subscription wired`,
      );
      return;
    }
    if (unpushable !== undefined) {
      this.subs.delete(channelId);
      warn(
        `topic ${JSON.stringify(topic as string)} maps to channel ${channelId}, which ${unpushable}` +
          ' — this topic gets no live push; map it to a guild text channel instead',
      );
    }
  }

  /**
   * `GET /channels/<id>`, once per subscribed channel: why it can never carry a `MESSAGE_CREATE`,
   * or undefined when it can. Keep a transport or server failure THROWING rather than answering a
   * reason, so that the caller reads it as unverified and leaves the subscription wired.
   */
  private async unpushableReason(topic: Topic, channelId: string): Promise<string | undefined> {
    const path = `/channels/${encodeURIComponent(channelId)}`;
    const res = await this.rest.request('GET', path, { allowStatuses: [403, 404] });
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
    return unpushableChannelReason(type);
  }

  /**
   * Discord has NO global name → id lookup (search is per-guild and privileged), so only our own
   * bot account resolves to a real id; every other handle passes through as a string convention
   * (DESIGN §4).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    if (this.me === undefined) {
      this.me = (async () => {
        const res = await this.rest.request('GET', '/users/@me');
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
   * Topic → Discord channel id: `channel_map` entry, else the topic string IS the channel id. Keep
   * the collision refused HERE rather than at one entry point, so that the same Discord message can
   * never cross the seam under two topic labels and interleave the two topics' cursors.
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
   * The ladder state, forwarded under the names the gateway suites read off the PLUGIN. Keep them,
   * so that a reader who deletes them as unused turns the IDENTIFY-budget, heartbeat-leak and
   * terminal-close tables into assertions against `undefined` — each of those tables guards a
   * bot-token RESET or a leaked interval that stops the process exiting.
   */
  private get reconnectAttempts(): number {
    return this.gateway.reconnectAttempts;
  }
  private get heartbeats(): ReadonlySet<NodeJS.Timeout> {
    return this.gateway.heartbeats;
  }
  private get gatewayReady(): Promise<void> | undefined {
    return this.gateway.ready;
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rejectDeadline) => {
      timer = setTimeout(() => rejectDeadline(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Schemes that put a bot token on the wire in the clear, and what to use instead. */
const PLAINTEXT_SCHEMES = new Map([['http:', 'https://'], ['ws:', 'wss://']]);

/**
 * Every configured endpoint that would carry the bot token in the clear, phrased for the operator's
 * stderr. A warning rather than a load error, so that a loopback fake or a dev proxy still runs.
 * Keep it and {@link plaintextRemoteOrigin} in THIS file, so that net-util's fork registry — which
 * records the local copy BY PATH — still names the debt it was written to hold.
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

function plaintextRemoteOrigin(raw: string): { origin: string; secure: string } | undefined {
  try {
    const { protocol, hostname, origin } = new URL(raw);
    const secure = PLAINTEXT_SCHEMES.get(protocol);
    return secure !== undefined && !isLoopbackHost(hostname) ? { origin, secure } : undefined;
  } catch {
    return undefined;
  }
}
