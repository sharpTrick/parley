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
  fetchWithRetry,
  retryAfterFromHeader,
  sanitizeBody,
} from '@sharptrick/parley-net-util';
import WebSocket from 'ws';

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

/** A minimal gateway payload (opcodes we speak: 0/1/2/7/9/10/11). */
interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/**
 * GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT — without MESSAGE_CONTENT, content arrives empty.
 * MESSAGE_CONTENT is a PRIVILEGED intent: it must also be toggled on in the developer portal.
 */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

/**
 * Terminal Discord gateway close codes — authentication failed (4004), invalid/disallowed
 * intents (4013/4014), invalid API version (4012), and the sharding-class errors (4010/4011).
 * None are recoverable by re-IDENTIFYing; retrying re-sends IDENTIFY on every attempt and burns
 * Discord's 1000-IDENTIFY/24h budget, which RESETS (invalidates) the bot token (BUG-07). Treat
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

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Reconnect backoff ceiling. Keep it ABOVE 86.4s, so that a chronically flapping gateway stays
 * under Discord's 1000-IDENTIFY-per-24h quota — the penalty for exceeding it is a bot-token RESET,
 * which breaks every Parley instance sharing that bot until a human re-provisions it.
 */
export const RECONNECT_CAP_MS = 120_000;

/**
 * How long a socket must stay up AFTER READY before its reconnect budget is forgiven. Keep this
 * well above zero, so that a gateway which drops immediately after READY cannot reset the backoff
 * on every cycle and re-IDENTIFY once a second — the same token-reset quota as above.
 */
export const STABLE_CONNECTION_MS = 60_000;

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
  private channelMap: Record<string, string> = {};
  private handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS;
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
   * Reconnect backoff attempt counter (BUG-07): grows the delay 1s→2s→…→{@link RECONNECT_CAP_MS}
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
   * Minimum delay (ms) the NEXT dial must honor. Set by op 9 INVALID SESSION to the
   * gateway-mandated random 1–5 s re-identify wait; consumed by {@link chargeDialAttempt}.
   */
  private op9MinWaitMs = 0;
  /** channel id → subscription; MESSAGE_CREATE dispatch routes through this. */
  private readonly subs = new Map<string, { topic: Topic; handler: MessageHandler }>();
  /**
   * Native long-poll wakeups (issue #20): channel id → set of one-shot callbacks armed by a
   * blocking `fetchRecent`. Any MESSAGE_CREATE on that channel — OR `disconnect()` — fires every
   * waiter so the blocked fetch re-queries and returns. Independent of `subs`: a blocking fetch
   * does NOT register a subscription, it only listens on the SHARED gateway socket the live path
   * already runs (no second connection). Reusing the same `MESSAGE_CREATE` primitive keeps the
   * wait cheap and its teardown identical to the live path's.
   */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Memoized `GET /users/@me` (the bot's own account), for resolveIdentity. */
  private me?: Promise<{ id: string; username: string }>;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as DiscordBackendConfig;
    this.apiUrl = (cfg.api_url ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
    this.token = cfg.token;
    this.gatewayUrlOverride = cfg.gateway_url;
    this.channelMap = requireDistinctChannels(cfg.channel_map ?? {});
    this.handshakeTimeoutMs = cfg.handshake_timeout_ms ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.fatalGateway = undefined;
    this.stopped = false;
    this.connected = true;
    this.reconnectAttempts = 0;
    this.op9MinWaitMs = 0;
    this.nextDialAt = 0;
    this.seq = null;
    this.live = false;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
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
    // Abort every in-flight long-poll cleanly (fire clears its own timer + map entry). A blocked
    // fetch then sees `stopped` and returns an empty page — no leaked listeners or timers.
    for (const set of [...this.waiters.values()]) for (const fire of [...set]) fire();
    this.waiters.clear();
    this.me = undefined;
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    if (content.length > CONTENT_LIMIT) {
      throw new Error(
        `Discord caps a message at ${CONTENT_LIMIT} characters; this post is ${content.length}. ` +
          'Split it across posts (chunking here would break the one-post/one-backendMsgId contract).',
      );
    }
    const channelId = this.channelId(topic);
    const res = await this.http('POST', `/channels/${encodeURIComponent(channelId)}/messages`, {
      body: {
        content,
        message_reference:
          opts?.inReplyTo !== undefined ? { message_id: opts.inReplyTo } : undefined,
      },
    });
    const json = (await res.json()) as DiscordMessage;
    // identity is the logical sender; Discord stamps `author` as the bot account behind `token`.
    void identity;
    return asBackendMsgId(json.id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const limit = args.limit ?? 100;

    if (args.since === undefined) {
      // Default window: the newest `limit` messages, returned ASCENDING (Discord replies
      // newest-first; reverse). The API caps a page at 100, so a larger limit pages BACKWARDS
      // with `before` — truncating instead would strand everything older behind a cursor that
      // already sits past it.
      const newestFirst: DiscordMessage[] = [];
      let before: string | undefined;
      while (newestFirst.length < limit) {
        const page = Math.min(limit - newestFirst.length, PAGE_LIMIT);
        const query = before === undefined ? `limit=${page}` : `limit=${page}&before=${before}`;
        const chunk = await this.getMessages(args.topic, query);
        if (chunk.length === 0) break;
        newestFirst.push(...chunk);
        before = chunk.at(-1)!.id;
        if (chunk.length < page) break;
      }
      const messages = newestFirst.reverse().map((m) => toMessage(args.topic, m));
      return { messages, nextCursor: messages.at(-1)?.cursor ?? asCursor('0') };
    }

    const blockMs = args.blockMs ?? 0;
    // No long-poll requested → the durable exclusive-since page, exactly as before.
    if (blockMs <= 0) {
      return this.fetchSince(args.topic, args.since, limit);
    }

    // Native long-poll (issue #20): the exclusive `since` query is empty, so wait on the SAME
    // gateway MESSAGE_CREATE stream the live path uses for a message on this channel — up to
    // blockMs — then re-run the exclusive REST query so ids/cursor stay canonical. Returning
    // early/empty is always safe (core polls the remaining budget), so any failure to establish
    // the live socket degrades gracefully to the immediate query. Keep the CONNECT inside the
    // same `blockMs` budget, so that a gateway which accepts the socket but never completes the
    // handshake cannot stretch this call past the cap core sized for the client's tool timeout.
    const deadline = Date.now() + blockMs;
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
      const first = await this.fetchSince(args.topic, args.since, limit);
      if (first.messages.length > 0 || waiter === undefined) return first;
      await waiter.fired; // resolves on MESSAGE_CREATE for this channel, timeout, or disconnect
      if (this.stopped) return { messages: [], nextCursor: args.since };
      return await this.fetchSince(args.topic, args.since, limit);
    } finally {
      waiter?.cancel();
    }
  }

  /**
   * One exclusive-`since` catch-up page. `?after=` is exclusive server-side; each page comes back
   * newest-first → reverse to ascending; for limit > 100, page forward advancing `after` to the
   * last (largest) returned id until filled or a short page says the tail is reached. Empty →
   * `nextCursor` echoes `since` (stable, replayable).
   */
  private async fetchSince(topic: Topic, since: Cursor, limit: number): Promise<FetchRecentResult> {
    const messages: Message[] = [];
    let after = String(since);
    while (messages.length < limit) {
      const page = Math.min(limit - messages.length, PAGE_LIMIT);
      const chunk = await this.getMessages(
        topic,
        `after=${encodeURIComponent(after)}&limit=${page}`,
      );
      if (chunk.length === 0) break;
      const ascending = chunk.reverse();
      for (const m of ascending) messages.push(toMessage(topic, m));
      after = ascending.at(-1)!.id;
      if (chunk.length < page) break;
    }
    return { messages, nextCursor: messages.at(-1)?.cursor ?? since };
  }

  /**
   * One `GET /channels/<id>/messages` page (newest-first). A channel Discord does not know
   * (`10003 Unknown Channel`) is the seam's ABSENT TOPIC, not a failure: core maps
   * {@link NoSuchTopicError} to "topic not present yet" (an empty roster for `parley_list_users`),
   * while every other non-2xx — including a 404 that is not Unknown Channel, and `50001 Missing
   * Access`, which means the channel exists but this bot is misconfigured — stays a real failure.
   */
  private async getMessages(topic: Topic, query: string): Promise<DiscordMessage[]> {
    const path = `/channels/${encodeURIComponent(this.channelId(topic))}/messages?${query}`;
    const res = await this.http('GET', path, { allowStatuses: [404] });
    if (res.status === 404) {
      const raw = await res.text().catch(() => '');
      let code: unknown;
      try {
        code = (JSON.parse(raw) as { code?: number }).code;
      } catch {
        /* not JSON — not Unknown Channel either */
      }
      if (code === UNKNOWN_CHANNEL) throw new NoSuchTopicError(topic as string);
      throw new Error(`Discord GET ${path} → 404: ${sanitizeBody(raw)}`);
    }
    return (await res.json()) as DiscordMessage[];
  }

  /**
   * Arm a one-shot long-poll waiter on `channelId`, resolving `fired` when a MESSAGE_CREATE for
   * that channel arrives, when `blockMs` elapses, or when `disconnect()` fires it. Idempotent
   * `cancel()` (also invoked by the fire path) clears the timer and de-registers, so no listener
   * or timer can leak past the wait.
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
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const channelId = this.channelId(topic);
    const existing = this.subs.get(channelId);
    if (existing !== undefined && existing.topic !== topic) {
      // Silently overwriting would drop the earlier topic's handler AND relabel its traffic as
      // this topic, mis-routing core's per-topic seen-set and mention filter.
      throw new Error(
        `Discord topics ${JSON.stringify(existing.topic)} and ${JSON.stringify(topic)} both ` +
          `resolve to channel ${channelId}; give each topic its own channel_map target`,
      );
    }
    this.subs.set(channelId, { topic, handler });
    await this.ensureGateway();
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
      this.gatewayReady = this.openGateway().catch((err) => {
        // Don't poison the shared socket on transient failure — let the next caller retry, once
        // the budget this failed dial just charged has elapsed.
        this.gatewayReady = undefined;
        this.chargeDialAttempt();
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
    const backoff = Math.min(1000 * 2 ** this.reconnectAttempts++, RECONNECT_CAP_MS);
    const jitter = Math.floor(Math.random() * 1000);
    const wait = Math.max(this.op9MinWaitMs, backoff + jitter);
    this.op9MinWaitMs = 0;
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

  /** Topic → Discord channel id: `channel_map` entry, else the topic string IS the channel id. */
  private channelId(topic: Topic): string {
    return this.channelMap[topic as string] ?? (topic as string);
  }

  private require(): void {
    if (!this.connected) {
      throw new Error('DiscordPlugin not connected — call connect() first');
    }
  }

  /** Resolve the gateway wss URL (config override for tests/fakes; else `GET /gateway/bot`). */
  private async openGateway(): Promise<void> {
    let url = this.gatewayUrlOverride;
    if (url === undefined) {
      const res = await this.http('GET', '/gateway/bot');
      url = ((await res.json()) as { url: string }).url;
    }
    await this.openSocket(url);
  }

  /**
   * Open (or re-open) the gateway socket; resolves on READY. Minimal protocol subset:
   * HELLO (op 10) → start the heartbeat interval (op 1 echoing the last dispatch seq `s`) and
   * send IDENTIFY (op 2); READY (op 0) resolves; op 11 acks are ignored beyond liveness.
   *
   * Reconnect (close / op 7 RECONNECT / op 9 INVALID SESSION while running): capped exponential
   * backoff with jitter (`scheduleReconnect`), reopen, re-IDENTIFY — except a TERMINAL close code
   * (auth/intent/version/shard) stops the loop instead of burning the IDENTIFY budget (BUG-07).
   * RESUME is deliberately SKIPPED — the push gap during the outage is harmless, because the live
   * path is best-effort and cursor catch-up (`fetchRecent` since the last persisted cursor)
   * reconciles anything missed (DESIGN §6).
   */
  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let ready = false;
      let readyAt = 0;
      let heartbeat: NodeJS.Timeout | undefined;
      let awaitedAck = false;
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
        if (this.ws !== ws) {
          // Superseded (or post-disconnect) socket: it owns none of the shared state, and
          // IDENTIFYing from here would spend budget on a connection nothing reads.
          ws.close();
          return;
        }
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(String(data)) as GatewayPayload;
        } catch {
          return; // not JSON — not ours to crash on
        }
        switch (payload.op) {
          case 10: {
            // HELLO → heartbeat cadence + IDENTIFY.
            const hello = payload.d as { heartbeat_interval: number };
            if (heartbeat !== undefined) {
              clearInterval(heartbeat);
              this.heartbeats.delete(heartbeat);
            }
            awaitedAck = false;
            heartbeat = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) return;
              if (awaitedAck) {
                // The previous beat was never ACKed (op 11) → the TCP connection is half-dead
                // (BUG-20). terminate() (NOT close()) forces the `close` event IMMEDIATELY, so the
                // existing close→scheduleReconnect path takes over within ONE interval instead of
                // buffering beats into a dead socket for the ~15–25 min kernel TCP timeout.
                ws.terminate();
                return;
              }
              // Arm BEFORE sending, so that an ACK arriving in the same tick clears the flag it
              // was meant to clear instead of being overwritten into a false "missed ack".
              awaitedAck = true;
              ws.send(JSON.stringify({ op: 1, d: this.seq }));
            }, hello.heartbeat_interval);
            this.heartbeats.add(heartbeat);
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: this.token ?? '',
                  intents: INTENTS,
                  properties: { os: 'linux', browser: 'parley', device: 'parley' },
                },
              }),
            );
            break;
          }
          case 0: {
            if (payload.s !== null && payload.s !== undefined) this.seq = payload.s;
            if (payload.t === 'READY' && !ready) {
              ready = true;
              readyAt = Date.now();
              this.live = true;
              clearTimeout(handshake);
              resolve();
            } else if (payload.t === 'MESSAGE_CREATE') {
              const d = payload.d as DiscordMessage;
              const sub = this.subs.get(d.channel_id);
              if (sub !== undefined) {
                try {
                  sub.handler(toMessage(sub.topic, d));
                } catch {
                  /* handler is best-effort; never break the loop (DESIGN §6) */
                }
              }
              // Wake any long-poll fetch blocked on this channel (issue #20). It re-runs the
              // exclusive REST query, so the wakeup only needs to signal "something arrived".
              const waiting = this.waiters.get(d.channel_id);
              if (waiting !== undefined) for (const fire of [...waiting]) fire();
            }
            break;
          }
          case 1: {
            // Server-requested immediate heartbeat.
            ws.send(JSON.stringify({ op: 1, d: this.seq }));
            break;
          }
          case 7: {
            // RECONNECT — drop the socket; the close handler owns the reconnect.
            ws.close();
            break;
          }
          case 9: {
            // INVALID SESSION — Discord mandates a random 1–5 s wait before re-identifying
            // (BUG-07). Stash the min-wait for scheduleReconnect (which the close handler
            // triggers), then drop the socket.
            this.op9MinWaitMs = 1000 + Math.floor(Math.random() * 4000);
            ws.close();
            break;
          }
          case 11: {
            // HEARTBEAT_ACK — liveness (BUG-20). Clears the pending-ack flag; a MISSING ack (still
            // set at the next beat) is what forces ws.terminate() in the heartbeat interval above.
            awaitedAck = false;
            break;
          }
          default:
            break; // anything else we don't speak
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
        const current = this.ws === ws;
        if (current) {
          this.ws = undefined;
          this.live = false;
        }
        if (TERMINAL_CLOSE.has(code)) {
          // Fatal (auth/intent/version/shard): never auto-retry — re-IDENTIFYing on every attempt
          // burns Discord's 1000-IDENTIFY/24h budget and resets the bot token (BUG-07). The close
          // is recorded and REPORTED in both phases: after READY nothing else would ever mention
          // it, and "live push silently stopped forever" is the worst failure this plugin has.
          const err = new TerminalGatewayCloseError(
            `Discord gateway closed with terminal code ${code} — check the bot token and the ` +
              'MESSAGE CONTENT privileged intent; live push is down until this bridge restarts',
          );
          this.gatewayReady = undefined;
          this.fatalGateway = err;
          process.stderr.write(`parley-discord: ${err.message}\n`);
          if (!ready) reject(err);
          return;
        }
        if (!ready) {
          reject(new Error(`Discord gateway closed before READY (code ${code})`));
          return;
        }
        if (this.stopped || !current) return;
        if (Date.now() - readyAt >= STABLE_CONNECTION_MS) this.reconnectAttempts = 0;
        this.scheduleReconnect(url);
      });
    });
  }

  /**
   * Backoff-and-reopen loop (re-IDENTIFY, no RESUME) until disconnect(), spending the same dial
   * budget every other path spends ({@link chargeDialAttempt}). A terminal close short-circuits it
   * (openSocket rejects with TerminalGatewayCloseError).
   */
  private scheduleReconnect(url: string): void {
    if (this.stopped) return;
    const wait = this.chargeDialAttempt();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      void this.openSocket(url).catch((err) => {
        if (err instanceof TerminalGatewayCloseError) return; // fatal — don't restart the storm
        this.scheduleReconnect(url);
      });
    }, wait);
  }

  /**
   * Single HTTP entry point. Adds `Authorization: Bot <token>`, JSON encodes, and transparently
   * retries on 429 honoring Discord's JSON `retry_after` (SECONDS, float — converted to ms).
   * Retries stop the moment we disconnect, so an aborted test never leaves a loop hammering the
   * API. Throws on unexpected non-2xx.
   */
  private async http(
    method: string,
    path: string,
    opts?: { body?: unknown; allowStatuses?: number[] },
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {};
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
      },
    );
  }
}

/**
 * Reject a `channel_map` whose targets are not distinct. Two topics folding onto one channel makes
 * the topic → channel map non-injective, which silently drops one topic's subscription and
 * relabels its traffic as the other's (core's `safeName` guards the same class the other way).
 */
function requireDistinctChannels(map: Record<string, string>): Record<string, string> {
  const owner = new Map<string, string>();
  for (const [topic, channel] of Object.entries(map)) {
    const prior = owner.get(channel);
    if (prior !== undefined) {
      throw new Error(
        `Discord channel_map maps both ${JSON.stringify(prior)} and ${JSON.stringify(topic)} to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    owner.set(channel, topic);
  }
  return map;
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
 * field (SECONDS, float). The clamp and the no-hint default live in net-util's `clampBackoff`.
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
