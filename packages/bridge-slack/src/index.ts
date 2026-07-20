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
}

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
 * A channel-level message we surface. Everything else (`message_changed`, `message_deleted`,
 * `channel_join`, thread broadcasts, …) is a mutation/system record, not a new message —
 * surfacing those would break dedup (same `ts`, different payload). Plain messages carry no
 * `subtype`; app/bot posts may carry `bot_message`.
 */
const isPlainMessage = (m: SlackMessage): boolean =>
  m.type === 'message' && (m.subtype === undefined || m.subtype === 'bot_message');

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
  private channelMap: Record<string, string> = {};
  private connected = false;
  private stopped = false;
  /** ONE shared Socket Mode websocket per plugin instance, opened lazily on first subscribe. */
  private ws?: WebSocket;
  /** Pending/established socket, resolved once the current connection has seen `hello`. */
  private wsReady?: Promise<void>;
  /** channel id → the topic + handler it feeds (Socket Mode events carry the channel id). */
  private readonly routes = new Map<string, { topic: Topic; handler: MessageHandler }>();
  /**
   * channel id → the set of native long-poll waiters parked on that channel (issue #20). Populated
   * only while a `fetchRecent({ blockMs })` is blocked; hooks the SAME shared Socket Mode stream as
   * `subscribe`, independent of whether any route is registered. Drained on wake/timeout/disconnect.
   */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** Memoized `auth.test` (our own bot identity) for {@link resolveIdentity}. */
  private authTestPromise?: Promise<AuthTestResponse>;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as SlackBackendConfig;
    this.apiUrl = (cfg.api_url ?? 'https://slack.com/api').replace(/\/+$/, '');
    this.botToken = cfg.bot_token;
    this.appToken = cfg.app_token;
    this.channelMap = cfg.channel_map ?? {};
    this.stopped = false;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.routes.clear();
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
   * `chat.postMessage`. THREADING IS AN APPROXIMATION: `inReplyTo` becomes `thread_ts`, which
   * files the message under that thread — Slack thread replies do NOT surface at channel level
   * (in `conversations.history` or channel-level `message` events) unless broadcast, so a
   * threaded reply is durable but only visible when reading the thread. The conformance suite
   * never uses `inReplyTo`; top-level posts (the normal Parley path) are unaffected.
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const body: Record<string, unknown> = { channel: this.channelFor(topic), text: content };
    if (opts?.inReplyTo !== undefined) body.thread_ts = opts.inReplyTo;
    const resp = await this.api<{ ok: boolean; ts: string }>('chat.postMessage', body);
    // identity is the logical sender; Slack stamps the wire sender as our bot user.
    void identity;
    return asBackendMsgId(resp.ts);
  }

  /**
   * `conversations.history`, exclusive `oldest` = `since` (`inclusive` is NEVER set, keeping the
   * API's default exclusivity — DESIGN §6's exclusive-`since` contract, server-side).
   *
   * COST CAVEAT: Slack returns pages NEWEST-first and `response_metadata.next_cursor` pages
   * FURTHER BACK in time, while the seam wants the OLDEST unseen page (ascending, resuming after
   * `since`). So with `since` set we must page ALL the way to the OLDEST end of `(since, now]` —
   * until the cursor runs out — then sort ascending and take the FIRST `limit` entries. There is NO
   * page cap on this walk: capping it would return the newest `limit` of a truncated set and set
   * `nextCursor` ABOVE the never-fetched older messages, permanently skipping the middle of a long
   * backlog (the skipped span sits below `nextCursor` and no later catch-up would ever revisit it —
   * BUG-18). A reader that's been offline across a huge backlog therefore pays O(backlog / page)
   * requests for one call, but memory stays O(limit): since pages arrive newest-first, the oldest
   * live at the tail, so we retain only a rolling tail of ~`limit + page_size` collected messages
   * and discard the newer ones as older pages arrive. Without `since` only the most recent `limit`
   * are needed, so paging stops as soon as enough PLAIN (surfaced) messages have been collected —
   * counting plain, not raw, so a system-subtype-heavy page can't cut the window short (BUG-31).
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const first = await this.runFetch(args);

    const blockMs = args.blockMs ?? 0;
    // Native long-poll engages ONLY when asked (blockMs > 0), resuming a `since`, and the exclusive
    // query came back empty. Any other case is the unchanged durable catch-up. Returning early/empty
    // is always safe — core's generic wrapper polls the remaining budget — so this stays conservative.
    if (blockMs <= 0 || args.since === undefined || first.messages.length > 0) {
      return first;
    }

    const channel = this.channelFor(args.topic);
    const sinceTs = String(args.since);
    try {
      // Wait on the EXISTING shared Socket Mode stream (the one `subscribe` uses); never a 2nd socket.
      await this.ensureSocket();
    } catch {
      // Live stream unavailable (e.g. no app token) — hand back the empty page; core polls onward.
      return first;
    }
    // Arm the waiter FIRST, then run the gap-closing re-query, so the waiter is live across that
    // snapshot window: a push that lands mid-query is caught, not lost (otherwise onEnvelope could
    // process the push before this HTTP response resolves and the waiter is armed — a lost wakeup).
    const { wait, wake } = this.armWaiter(channel, sinceTs, blockMs);

    // Re-query once the socket is live: a message may have landed in the gap between `first` and the
    // socket becoming ready. If so, cancel the (now-redundant) waiter and return immediately.
    const afterConnect = await this.runFetch(args);
    if (afterConnect.messages.length > 0) {
      wake();
      return afterConnect;
    }

    // Park on the live stream until a message strictly after `since` arrives, blockMs elapses, or we
    // disconnect. Then re-run the canonical exclusive query for canonical ids/cursor.
    await wait;
    if (this.stopped) return { messages: [], nextCursor: args.since };
    return this.runFetch(args);
  }

  private async runFetch(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.require();
    const channel = this.channelFor(args.topic);
    const limit = args.limit ?? 100;
    const resumeAfterSince = args.since !== undefined;

    const collected: SlackMessage[] = [];
    let pageCursor: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = { channel, limit: 200 };
      if (args.since !== undefined) body.oldest = args.since; // EXCLUSIVE (no `inclusive`)
      if (pageCursor !== undefined) body.cursor = pageCursor;
      const resp = await this.api<HistoryResponse>('conversations.history', body);
      collected.push(...(resp.messages ?? []));
      pageCursor = resp.response_metadata?.next_cursor || undefined;

      if (!resumeAfterSince) {
        // Newest-first default window: stop once `limit` PLAIN (surfaced) messages are in hand.
        // Counting RAW here would let a system-subtype-heavy first page (channel_join, …) end the
        // walk short of a full window, dropping the older plain messages below `nextCursor` (BUG-31).
        if (collected.filter(isPlainMessage).length >= limit) break;
        if (pageCursor === undefined) break;
      } else {
        // Resume-after-`since`: walk to the OLDEST end so `nextCursor` never sits above unfetched
        // history (BUG-18). Pages are newest-first, so the oldest live at the tail; keep only the
        // oldest ~`limit + page_size` so memory stays O(limit) while the request count is the
        // documented O(backlog / page) cost caveat.
        if (collected.length > limit + 200) collected.splice(0, collected.length - (limit + 200));
        if (pageCursor === undefined) break; // NO page cap: walk to cursor exhaustion.
      }
    }

    // Defensive ascending re-sort after multi-page assembly (pages arrive newest-first; never
    // trust concatenation order, and never compare `ts` lexically or as floats — compareTs).
    const events = collected.filter(isPlainMessage).sort((a, b) => compareTs(a.ts, b.ts));
    const window = resumeAfterSince ? events.slice(0, limit) : events.slice(-limit);
    const messages = window.map((m) => slackToMessage(args.topic, m));
    const nextCursor = messages.at(-1)?.cursor ?? args.since ?? asCursor('0');
    return { messages, nextCursor };
  }

  /**
   * Live path = ONE shared Socket Mode websocket (DESIGN §9 — genuine Events API pushes, not a
   * poll timer). `apps.connections.open` (app token) mints a SINGLE-USE websocket URL; the socket
   * is established — `hello` envelope received — BEFORE this resolves, so a post immediately after
   * subscribe() is guaranteed to be pushed. Slack's Events API only pushes NEW events, so the
   * subscription naturally starts at the tail; history is owned by catch-up. Our own
   * `chat.postMessage` output IS delivered (Slack pushes the bot's messages back like anyone
   * else's). On a `disconnect` envelope or socket close while running, we reconnect via a FRESH
   * `apps.connections.open` with backoff — the push gap across the reconnect is reconciled by
   * cursor catch-up (DESIGN §6). `disconnect()` closes the socket and stops the reconnect loop.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    this.routes.set(this.channelFor(topic), { topic, handler });
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
      } catch {
        // users_not_found (or missing users:read.email scope) → name-convention passthrough.
        return { handle, backendRef: handle };
      }
    }
    const auth = await this.authTest();
    if (handle === auth.user || handle === auth.user_id) {
      return { handle, backendRef: auth.user_id ?? handle };
    }
    return { handle, backendRef: handle };
  }

  /** Map a topic to its Slack channel id (`channel_map`, else the topic string itself). */
  private channelFor(topic: Topic): string {
    return this.channelMap[topic] ?? topic;
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
    this.wsReady ??= this.openSocket();
    return this.wsReady;
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
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(open.url);
      this.ws = ws;
      let settled = false;
      ws.on('message', (data: RawData) => {
        this.onEnvelope(ws, data, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });
      ws.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        // Post-establishment errors surface as a close → the reconnect path below.
      });
      ws.on('close', () => {
        if (this.stopped || this.ws !== ws) return;
        // Socket Mode URLs are SINGLE-USE: never redial the old URL.
        this.wsReady = undefined;
        if (!settled) {
          // Pre-`hello` close: ONLY reject — the owning caller (the first `subscribe` OR the
          // existing `reconnect` loop) retries. Spawning `reconnect()` here too would stack a
          // second loop per failed attempt during an outage, each independently clearing
          // `wsReady` and defeating the exponential backoff (BUG-30).
          settled = true;
          reject(new Error('Slack Socket Mode connection closed before hello'));
          return;
        }
        // Post-`hello` close: this connection was live; mint a fresh single-use URL.
        void this.reconnect();
      });
    });
  }

  /** Re-establish the shared socket with capped exponential backoff until stopped. */
  private async reconnect(): Promise<void> {
    let backoffMs = 200;
    while (!this.stopped) {
      try {
        await this.ensureSocket();
        return;
      } catch {
        this.wsReady = undefined; // clear the rejected attempt so the next loop retries
        await delay(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 5000);
      }
    }
  }

  /**
   * One Socket Mode envelope. ACK FIRST, before ANY processing: an unacked envelope gets
   * redelivered and the connection eventually dropped, and ack-first means a throwing handler
   * can never starve acks. Events arrive in order on the single socket, so per-channel handler
   * invocation stays in ascending `ts` order (the seam's per-topic ordering guarantee).
   */
  private onEnvelope(ws: WebSocket, data: RawData, onHello: () => void): void {
    let env: SocketEnvelope;
    try {
      env = JSON.parse(String(data)) as SocketEnvelope;
    } catch {
      return; // not JSON — nothing to ack, nothing to route
    }
    if (env.envelope_id !== undefined) {
      try {
        ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch {
        /* socket already closing; redelivery on the next connection covers it */
      }
    }
    if (env.type === 'hello') {
      onHello();
      return;
    }
    if (env.type === 'disconnect') {
      // Slack is rotating this connection out; close → the 'close' handler reconnects fresh.
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      return;
    }
    if (env.type !== 'events_api') return;
    const event = env.payload?.event;
    if (event === undefined || event.channel === undefined || !isPlainMessage(event)) return;

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
      route.handler(slackToMessage(route.topic, event));
    } catch {
      /* handler is best-effort; never break the loop (DESIGN §6) */
    }
  }

  /**
   * Single Web API entry point: `POST <api_url>/<method>`, `Authorization: Bearer <token>`, body
   * `application/x-www-form-urlencoded` — Slack accepts form encoding UNIVERSALLY (incl.
   * `chat.postMessage`), while read methods like `conversations.history`/`users.lookupByEmail`
   * silently IGNORE JSON args, so every method is form-encoded to match the official SDK (scalar
   * args → strings; array/object args → `JSON.stringify`). Every Slack response carries `ok`;
   * `ok:false` throws with Slack's `error` code — that envelope shape is interpreted HERE, not in
   * the shared helper. Transparently retries HTTP 429 honoring the `Retry-After` header (SECONDS,
   * `> 0`-guarded so a header-less 429 backs off the default, never `delay(0)`). Retries stop the
   * moment we disconnect, so an aborted test never leaves a loop hammering the API.
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

    // Slack form convention: scalar → string; array/object arg → JSON.stringify(value).
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
        // Stop retrying once disconnected, so an aborted test never leaves a loop hammering the API.
        isStopped: () => this.stopped,
        retryAfterOf: readRetryAfter,
      },
    );
    const json = (await res.json()) as T & { error?: string };
    if (!json.ok) throw new Error(`Slack ${method} → ${json.error ?? 'unknown_error'}`);
    return json;
  }

  private require(): void {
    if (!this.connected) {
      throw new Error('SlackPlugin not connected — call connect() first');
    }
  }
}

/**
 * Compare two Slack `ts` values (`'<seconds>.<suffix>'`). A `ts` is NOT a float — parsing
 * `'1234567890.123456'` as a number loses low-order precision — and NOT lexically ordered
 * (suffix widths could differ). Compare the epoch-seconds part, then the suffix, both as
 * integers. Used only for defensive sorting after multi-page assembly; the API itself handles
 * `oldest` exclusivity and per-page order.
 */
export function compareTs(a: string, b: string): number {
  const [aSec, aSub] = a.split('.');
  const [bSec, bSub] = b.split('.');
  const bySec = Number(aSec) - Number(bSec);
  if (bySec !== 0) return bySec;
  return Number(aSub ?? '0') - Number(bSub ?? '0');
}

function slackToMessage(topic: Topic, m: SlackMessage): Message {
  return buildMessage({
    topic,
    sender: m.user ?? m.bot_id ?? '',
    content: m.text ?? '',
    // Informational only (DESIGN §5) — derived from the ts seconds, never used for ordering.
    timestamp: new Date(Number(m.ts.split('.')[0]) * 1000).toISOString(),
    id: m.ts,
  });
}

/**
 * Slack 429s carry `Retry-After` (SECONDS) in the header; there is no body retry field. Honor the
 * header only when it is a positive finite number — an absent/empty header parses as
 * `Number(null|'') === 0`, which must NOT be treated as "retry immediately" (BUG-41's 0 ms tight
 * loop). Cap the wait at 5s; otherwise fall to the 500 ms default.
 */
function readRetryAfter(res: Response): number {
  const header = Number(res.headers.get('retry-after')); // seconds
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5000);
  return 500;
}
