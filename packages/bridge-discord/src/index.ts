import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { fetchWithRetry } from '@sharptrick/parley-net-util';
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
   * literal — the zero-config path when your topics simply ARE channel ids.
   */
  channel_map?: Record<string, string>;
}

/** A minimal Discord message object (the subset we read; REST and gateway share this shape). */
interface DiscordMessage {
  id: string;
  channel_id: string;
  content?: string;
  timestamp?: string;
  author?: { id: string; username: string };
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
  private connected = false;
  private stopped = false;
  /** Shared gateway socket (ONE per plugin instance), opened lazily on first subscribe. */
  private ws?: WebSocket;
  /** Resolves once the gateway is IDENTIFYed and READY; first subscribe awaits it. */
  private gatewayReady?: Promise<void>;
  private heartbeat?: NodeJS.Timeout;
  /** Last dispatch sequence number, echoed in heartbeats. */
  private seq: number | null = null;
  /** channel id → subscription; MESSAGE_CREATE dispatch routes through this. */
  private readonly subs = new Map<string, { topic: Topic; handler: MessageHandler }>();
  /** Memoized `GET /users/@me` (the bot's own account), for resolveIdentity. */
  private me?: Promise<{ id: string; username: string }>;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as DiscordBackendConfig;
    this.apiUrl = (cfg.api_url ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
    this.token = cfg.token;
    this.gatewayUrlOverride = cfg.gateway_url;
    this.channelMap = cfg.channel_map ?? {};
    this.stopped = false;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.ws?.close();
    this.ws = undefined;
    this.gatewayReady = undefined;
    this.subs.clear();
    this.me = undefined;
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
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
    const channelId = encodeURIComponent(this.channelId(args.topic));
    const limit = args.limit ?? 100;

    if (args.since === undefined) {
      // Default window: the most recent messages, returned ASCENDING (Discord replies
      // newest-first; reverse). The API caps a page at 100 — that cap IS the default window.
      const res = await this.http(
        'GET',
        `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`,
      );
      const chunk = (await res.json()) as DiscordMessage[];
      const messages = chunk.reverse().map((m) => toMessage(args.topic, m));
      return { messages, nextCursor: messages.at(-1)?.cursor ?? asCursor('0') };
    }

    // Exclusive `since`: `?after=` is exclusive server-side. Each page comes back newest-first
    // → reverse to ascending; for limit > 100, page forward advancing `after` to the last
    // (largest) returned id until filled or a short page says the tail is reached.
    const messages: Message[] = [];
    let after = String(args.since);
    while (messages.length < limit) {
      const page = Math.min(limit - messages.length, 100);
      const res = await this.http(
        'GET',
        `/channels/${channelId}/messages?after=${encodeURIComponent(after)}&limit=${page}`,
      );
      const chunk = (await res.json()) as DiscordMessage[];
      if (chunk.length === 0) break;
      const ascending = chunk.reverse();
      for (const m of ascending) messages.push(toMessage(args.topic, m));
      after = ascending.at(-1)!.id;
      if (chunk.length < page) break;
    }
    return { messages, nextCursor: messages.at(-1)?.cursor ?? args.since };
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
    this.subs.set(this.channelId(topic), { topic, handler });
    if (this.gatewayReady === undefined) {
      this.gatewayReady = this.openGateway().catch((err) => {
        // Don't poison the shared socket on transient failure — let the next subscribe retry.
        this.gatewayReady = undefined;
        throw err;
      });
    }
    await this.gatewayReady;
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
   * Reconnect (close / op 7 RECONNECT / op 9 INVALID SESSION while running): back off ~500ms,
   * reopen, re-IDENTIFY. RESUME is deliberately SKIPPED — the push gap during the outage is
   * harmless, because the live path is best-effort and cursor catch-up (`fetchRecent` since the
   * last persisted cursor) reconciles anything missed (DESIGN §6).
   */
  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let ready = false;

      ws.on('message', (data) => {
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
            if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: this.seq }));
              }
            }, hello.heartbeat_interval);
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
            }
            break;
          }
          case 1: {
            // Server-requested immediate heartbeat.
            ws.send(JSON.stringify({ op: 1, d: this.seq }));
            break;
          }
          case 7: // RECONNECT
          case 9: {
            // INVALID SESSION — either way: drop the socket; the close handler re-opens.
            ws.close();
            break;
          }
          default:
            break; // op 11 heartbeat-ack and anything else: liveness only
        }
      });

      ws.on('error', () => {
        /* the paired close event drives teardown/reconnect; don't crash the process */
      });

      ws.on('close', () => {
        if (this.heartbeat !== undefined) {
          clearInterval(this.heartbeat);
          this.heartbeat = undefined;
        }
        if (this.ws === ws) this.ws = undefined;
        if (!ready) {
          reject(new Error('Discord gateway closed before READY'));
          return;
        }
        if (!this.stopped) this.scheduleReconnect(url);
      });
    });
  }

  /** Backoff-and-reopen loop; keeps retrying (re-IDENTIFY, no RESUME) until disconnect(). */
  private scheduleReconnect(url: string): void {
    if (this.stopped) return;
    setTimeout(() => {
      if (this.stopped) return;
      void this.openSocket(url).catch(() => this.scheduleReconnect(url));
    }, 500);
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
    opts?: { body?: unknown },
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
      },
    );
  }
}

function toMessage(topic: Topic, m: DiscordMessage): Message {
  return buildMessage({
    topic,
    sender: m.author?.username ?? '',
    content: m.content ?? '',
    timestamp: m.timestamp ?? '',
    id: m.id,
  });
}

/**
 * Discord's 429 body carries `retry_after` in SECONDS (float); Discord ALSO sends the standard
 * `Retry-After` header (SECONDS). Prefer the header, then the body — both `> 0`-guarded — convert
 * to ms (ceil the float), cap at 5s, default 500.
 */
async function readRetryAfter(res: Response): Promise<number> {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(Math.ceil(header * 1000), 5000);
  try {
    const json = (await res.clone().json()) as { retry_after?: number };
    const s = json.retry_after;
    if (typeof s === 'number' && s > 0) return Math.min(Math.ceil(s * 1000), 5000);
  } catch {
    /* fall through to default backoff */
  }
  return 500;
}
