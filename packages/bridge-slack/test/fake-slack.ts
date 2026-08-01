/**
 * In-process fake Slack — just enough Web API + Socket Mode surface for the conformance suite.
 * `node:http` serves the Web API methods; a `ws.WebSocketServer` on the same server plays the
 * Socket Mode side. Deliberately mirrors the real contract where the plugin depends on it:
 *   - `ts` values are unique AND strictly increasing per channel (global counter suffix), even
 *     under concurrent writers — the property that makes ts a valid cursor.
 *   - `conversations.history` returns NEWEST-first with `oldest` EXCLUSIVE (unless `inclusive`),
 *     and pages via `response_metadata.next_cursor` at a size the server picks and the caller cannot
 *     raise (50 by default, so the 100-message conformance case forces real multi-page assembly).
 *   - `chat.postMessage` files a `thread_ts` post inside that thread, where `conversations.history`
 *     cannot see it, unless `reply_broadcast` also asks for the channel-level `thread_broadcast`
 *     copy — the pair of request fields that decides whether a post is readable back at all.
 *   - A channel id that was never created answers `{ok:false, error:'channel_not_found'}` — an
 *     EXISTING but empty channel is the only thing that answers `ok:true, messages:[]`. Fabricating
 *     success for unknown ids would green the seam's absent-topic contract without testing it.
 *   - Every `chat.postMessage` pushes an `events_api` envelope (Slack delivers the bot's own posts
 *     back) to exactly ONE connected socket, as Socket Mode routes payloads, and incoming
 *     `{envelope_id}` acks are recorded so tests can assert the ack-every-envelope discipline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { compareTs } from '../src/index.js';

/** Default page size — small enough that the 100-message conformance case spans 3 pages. */
const DEFAULT_PAGE_SIZE = 50;

interface StoredMessage {
  type: 'message';
  ts: string;
  text: string;
  user: string;
  bot_id: string;
  /** System/mutation records (`channel_join`, `message_changed`, …) carry a subtype; plain posts don't. */
  subtype?: string;
  /** Set on a threaded entry: the parent's `ts` (a thread parent carries its own). */
  thread_ts?: string;
}

/**
 * How a new Socket Mode connection behaves. `silent` is the degraded edge: the TCP/WS connection is
 * ACCEPTED and then nothing is ever sent — neither `hello` nor a close — which is the only shape
 * that exercises a handshake with no liveness bound.
 */
export type GreetMode = 'greet' | 'pre-hello-close' | 'silent';

/**
 * How `conversations.history` orders what it serves. `newest-first` is what Slack documents and what
 * every other fixture here runs on; the rest are a vendor that broke that contract — a reversed
 * walk, a reversed page, an unordered page — which the plugin must refuse rather than answer from.
 */
export type HistoryOrder = 'newest-first' | 'oldest-first' | 'page-reversed' | 'shuffled';

/**
 * A deterministic permutation of `page` that is not sorted by `ts` — seeded off the page's own first
 * `ts` so a failing row replays exactly. Keep it deterministic, so that an ordering the plugin
 * accepts wrongly cannot pass on one run and fail on the next.
 */
const shuffleDeterministically = <T>(page: T[], seed: number): T[] => {
  const out = [...page];
  let state = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * A plain thread reply is invisible to `conversations.history` on real Slack while its `message`
 * event still arrives on the channel stream. Keep this rule HERE and in the plugin's classifier
 * only, so both delivery paths are graded against one statement of it.
 */
const isChannelLevel = (m: StoredMessage): boolean =>
  typeof m.thread_ts !== 'string' || m.thread_ts === m.ts || m.subtype === 'thread_broadcast';

/**
 * The fake orders and filters history with the PLUGIN'S OWN comparator, imported from src. Keep it
 * imported, so that a fake that grades exclusive-`since` cannot drift from the rule it is grading —
 * a paraphrased copy disagreed with src for every suffix that was not exactly six digits.
 */
const isOrderable = (m: StoredMessage): boolean =>
  m !== null && typeof m.ts === 'string' && /^\d+\.\d+$/.test(m.ts);

const orderOf = (m: StoredMessage): string => (isOrderable(m) ? m.ts : '0');

const rand = (): string => Math.random().toString(36).slice(2, 10);

/**
 * Slack's `text` is markup and the SENDER owns escaping `&`, `<` and `>`. Removing the three legal
 * entities leaves a string in which any surviving one of those characters is an un-escaped byte the
 * sender put on the wire — where Slack would parse it as control markup.
 */
const stripEntities = (text: string): string => text.replace(/&(amp|lt|gt);/g, '');
const UNESCAPED_MARKUP = /[&<>]/;

/**
 * Decode one form field the way real Slack does: scalar args arrive as plain strings; array/object
 * args were `JSON.stringify`d by the plugin, so parse those back — but ONLY when the value actually
 * looks like a JSON object/array. A numeric-looking scalar (e.g. a `ts` cursor `oldest`) MUST stay
 * a string, so it is never round-tripped through `JSON.parse`.
 */
const decodeFormValue = (raw: string): unknown => {
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      /* not valid JSON after all — treat as a plain string */
    }
  }
  return raw;
};

export class FakeSlack {
  /** Web API base, e.g. `http://127.0.0.1:PORT/api` — pass as the plugin's `api_url`. */
  readonly apiUrl: string;
  /** Socket Mode URL handed out by `apps.connections.open`. */
  readonly wsUrl: string;
  /** envelope_id of every events_api envelope pushed to any socket. */
  readonly pushed = new Set<string>();
  /** envelope_id of every ack received back over any socket. */
  readonly acked = new Set<string>();
  /** Count of `apps.connections.open` calls served — a deterministic proxy for reconnect attempts. */
  connectionsOpened = 0;
  /** Count of `hello` envelopes sent (only when greeting) — marks a settled Socket Mode connection. */
  helloSent = 0;
  /**
   * Greeted connections that have since closed. Each one is a drain on the plugin side — it releases
   * every long-poll parked on that stream — so a per-call request ceiling that a lost socket
   * legitimately widens can be stated over THIS instead of over a hand-tuned constant.
   */
  establishedClosed = 0;

  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly pageSize: number;
  private readonly sockets = new Set<WebSocket>();
  /** Sockets this fake has greeted — the ones whose close the plugin reads as a lost stream. */
  private readonly greeted = new WeakSet<WebSocket>();
  /** Timer behind {@link flap}. */
  private flapping?: ReturnType<typeof setInterval>;
  /** Channels that EXIST. Anything else answers `channel_not_found`, like slack.com. */
  private readonly known = new Set<string>();
  /** method → the `ok:false` code to answer with, and how many more times. */
  private readonly failures = new Map<string, { code: string; times: number }>();
  /** method → artificial latency (ms), for racing a teardown against an in-flight request. */
  private readonly latency = new Map<string, number>();
  /** method → a callback fired after its payload is computed, before it is written. */
  private readonly hooks = new Map<string, (hit: number) => void | Promise<void>>();
  /** method → requests served, counted BEFORE any injected failure (did it reach the wire?). */
  readonly requests = new Map<string, number>();
  /**
   * method → every decoded request body it received, in order. A field the plugin believes it sets
   * is only real if it is ON the request, so keep this recorder per-METHOD rather than for the one
   * method a test happened to need: a `chat.postMessage` argument the fixture never looked at is how
   * `thread_ts` reached neither the wire assertions nor the stored record.
   */
  private readonly bodies = new Map<string, Array<Record<string, unknown>>>();
  /** method → requests that arrived with NO `Authorization` header (answered `not_authed`). */
  readonly unauthenticated = new Map<string, number>();
  private greet: GreetMode = 'greet';
  private historyOrder: HistoryOrder = 'newest-first';
  /** The URL `apps.connections.open` hands out — see {@link setWsUrl}. */
  private handedOutWsUrl?: string;
  /** Global monotonic counter — the ts suffix. Node is single-threaded, so ts minting is atomic. */
  private counter = 0;
  /** Round-robin position for {@link deliverToOneSocket}. */
  private nextSocket = 0;
  private readonly channels = new Map<string, StoredMessage[]>();

  private constructor(server: Server, wss: WebSocketServer, port: number, pageSize: number) {
    this.server = server;
    this.wss = wss;
    this.pageSize = pageSize;
    this.apiUrl = `http://127.0.0.1:${port}/api`;
    this.wsUrl = `ws://127.0.0.1:${port}/socket`;
  }

  /**
   * `pageSize` is how many objects `conversations.history` returns per page, whatever `limit` the
   * caller asked for — real Slack caps it per rate-limit tier (15 objects for a commercially
   * distributed non-Marketplace app, 1000 for an internal one) and silently serves fewer than asked.
   */
  static async start(opts?: { pageSize?: number }): Promise<FakeSlack> {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeSlack(
      server,
      wss,
      (server.address() as AddressInfo).port,
      opts?.pageSize ?? DEFAULT_PAGE_SIZE,
    );

    server.on('request', (req, res) => {
      void fake.handleHttp(req, res);
    });
    wss.on('connection', (ws) => {
      fake.sockets.add(ws);
      ws.on('close', () => {
        fake.sockets.delete(ws);
        if (fake.greeted.has(ws)) fake.establishedClosed++;
      });
      ws.on('message', (data) => {
        try {
          const { envelope_id } = JSON.parse(String(data)) as { envelope_id?: string };
          if (envelope_id !== undefined) fake.acked.add(envelope_id);
        } catch {
          /* ignore non-JSON */
        }
      });
      if (fake.greet === 'greet') {
        // Socket Mode greets with hello once the connection is ready (no envelope_id, no ack).
        fake.helloSent++;
        fake.greeted.add(ws);
        ws.send(JSON.stringify({ type: 'hello', num_connections: fake.sockets.size }));
      } else if (fake.greet === 'pre-hello-close') {
        // Accept the socket then immediately close it WITHOUT a hello, so the plugin's pre-`hello`
        // close branch is exercised on every reconnect attempt.
        ws.close();
      }
      // 'silent': accepted and left open, saying nothing at all.
    });
    return fake;
  }

  /** How new Socket Mode connections behave — see {@link GreetMode}. */
  setGreet(mode: GreetMode): void {
    this.greet = mode;
  }

  /** How `conversations.history` orders what it serves — see {@link HistoryOrder}. */
  setHistoryOrder(order: HistoryOrder): void {
    this.historyOrder = order;
  }

  /**
   * Hand out `url` from `apps.connections.open` instead of this fake's own socket. Pointed at a
   * closed port it is the everyday firewall/proxy/blip shape: the dial SUCCEEDS and the websocket
   * then never connects, so the handshake settles through `error` rather than through a close.
   */
  setWsUrl(url: string): void {
    this.handedOutWsUrl = url;
  }

  /** Create an EMPTY but existing channel (`ok:true, messages:[]`), unlike an unknown id. */
  createChannel(channel: string): void {
    if (!this.channels.has(channel)) this.channels.set(channel, []);
    this.known.add(channel);
  }

  /** Answer `method` with `{ok:false, error:code}` for the next `times` calls. */
  failMethod(method: string, code: string, times = Number.POSITIVE_INFINITY): void {
    this.failures.set(method, { code, times });
  }

  /** Hold `method`'s response for `ms`, widening the in-flight window a teardown can race. */
  setLatency(method: string, ms: number): void {
    this.latency.set(method, ms);
  }

  /** How many times `method` reached the wire (counted before injected failures). */
  hits(method: string): number {
    return this.requests.get(method) ?? 0;
  }

  /** How many of {@link hits} arrived with no bearer token at all. */
  unauthedHits(method: string): number {
    return this.unauthenticated.get(method) ?? 0;
  }

  /** Every decoded request body `method` received, in wire order — see {@link bodies}. */
  requestBodies(method: string): Array<Record<string, unknown>> {
    return this.bodies.get(method) ?? [];
  }

  /** Sockets currently connected — must be 0 once a plugin has disconnected. */
  get liveSockets(): number {
    return this.sockets.size;
  }

  /** The `text` bytes as they reached the wire, before any read-side decoding. */
  rawTexts(channel: string): string[] {
    return (this.channels.get(channel) ?? []).map((m) => m.text);
  }

  /**
   * Deliver one payload the way Socket Mode does: to exactly ONE of the app's open connections.
   * Slack does not fan an event out — "when multiple connections are active, each payload may be
   * sent to any of the connections" — so two sessions sharing an app token each see a subset. Keep
   * this single-delivery, so that no test can rest on a fan-out the vendor does not perform.
   */
  private deliverToOneSocket(envelope: string): void {
    const open = [...this.sockets];
    if (open.length === 0) return;
    open[this.nextSocket++ % open.length]!.send(envelope);
  }

  /** Push one raw `events_api` envelope (any subtype) — see {@link deliverToOneSocket}. */
  pushEvent(channel: string, event: Record<string, unknown>): string {
    const envelopeId = `env-${rand()}`;
    this.pushed.add(envelopeId);
    this.deliverToOneSocket(
      JSON.stringify({
        envelope_id: envelopeId,
        type: 'events_api',
        payload: { event: { type: 'message', channel, ...event } },
      }),
    );
    return envelopeId;
  }

  /**
   * Push an ARBITRARY envelope body — the shapes a vendor or an attacker can put on the wire that
   * `pushEvent` cannot express (no `event`, a non-`events_api` type, a malformed `ts`). The
   * `envelope_id` is minted here and recorded in {@link pushed}, so ack discipline is assertable
   * for envelopes the plugin deliberately drops.
   */
  pushEnvelope(body: Record<string, unknown>): string {
    const envelopeId = `env-${rand()}`;
    this.pushed.add(envelopeId);
    this.deliverToOneSocket(JSON.stringify({ envelope_id: envelopeId, ...body }));
    return envelopeId;
  }

  /**
   * Push an envelope with NO `envelope_id`, which is how real Socket Mode sends `hello` and
   * `disconnect` — Slack asks for an ack only on `events_api`/`slash_commands`/`interactive`. Keep
   * control envelopes on this method, so that no test can grade ack discipline against an envelope
   * Slack never asks to have acked.
   */
  pushUnackedEnvelope(body: Record<string, unknown>): void {
    const envelope = JSON.stringify(body);
    for (const ws of this.sockets) ws.send(envelope);
  }

  /**
   * Close the LEAST-recently-connected socket — the old half of a Socket Mode rotation, which
   * `dropSockets` cannot express because it would take the replacement down with it.
   */
  dropOldestSocket(): void {
    const [oldest] = this.sockets;
    oldest?.close();
  }

  /**
   * Append raw, possibly MALFORMED history entries — the shapes a real API can return and `seed`
   * cannot express (no `ts`, a numeric `ts`, a null entry). Deliberately untyped: the point is that
   * the plugin must survive records its interface says are impossible.
   */
  seedRaw(channel: string, entries: unknown[]): void {
    this.createChannel(channel);
    const list = this.channels.get(channel) ?? [];
    list.push(...(entries as StoredMessage[]));
    this.channels.set(channel, list);
  }

  /**
   * Run `fn` when `method` is served, AFTER its response payload has been computed and BEFORE it is
   * written. That is the only place a test can land an event strictly inside a request's in-flight
   * window — which is where the gap-closing re-query's lost-wakeup lives.
   */
  onHit(method: string, fn: (hit: number) => void | Promise<void>): void {
    this.hooks.set(method, fn);
  }

  /** Mint the next `ts` without storing anything (for pushed events with no history row). */
  mintTs(): string {
    return `${Math.floor(Date.now() / 1000)}.${String(++this.counter).padStart(6, '0')}`;
  }

  /** Close every currently-connected Socket Mode socket (simulate an established-socket drop). */
  dropSockets(): void {
    for (const ws of this.sockets) ws.close();
  }

  /**
   * Drop whatever socket is open, every `everyMs`, until {@link stopFlap} or {@link close}. The edge
   * that ACCEPTS, greets and then closes — a draining load balancer, a flapping proxy, an app token
   * at its connection quota being reaped. `setGreet('pre-hello-close')` cannot express it: there the
   * handshake FAILS, which is the one shape a dial-failure ladder already paces. Here every
   * `apps.connections.open` succeeds and every handshake completes.
   */
  flap(everyMs: number): void {
    this.stopFlap();
    this.flapping = setInterval(() => this.dropSockets(), everyMs);
  }

  stopFlap(): void {
    if (this.flapping !== undefined) clearInterval(this.flapping);
    this.flapping = undefined;
  }

  /**
   * Bulk-seed a channel directly (bypassing `chat.postMessage`/the socket push) so pagination and
   * subtype-filter tests can stage large / system-subtype-heavy histories the live path can't cheaply
   * produce. `ts` is minted the same way `postMessage` does (unique, strictly increasing), so entries
   * are returned in insertion (ascending-`ts`) order.
   */
  seed(
    channel: string,
    entries: Array<{ text: string; subtype?: string; thread?: 'parent' | 'reply' }>,
  ): StoredMessage[] {
    this.createChannel(channel);
    const list = this.channels.get(channel) ?? [];
    const created = entries.map((e) => {
      const ts = this.mintTs();
      const msg: StoredMessage = { type: 'message', ts, text: e.text, user: 'U0PARLEY', bot_id: 'B0PARLEY' };
      if (e.subtype !== undefined) msg.subtype = e.subtype;
      if (e.thread === 'parent') msg.thread_ts = ts;
      if (e.thread === 'reply') msg.thread_ts = '1000000000.000001';
      list.push(msg);
      return msg;
    });
    this.channels.set(channel, list);
    return created;
  }

  async close(): Promise<void> {
    this.stopFlap();
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    // The plugin form-encodes EVERY Web API call (application/x-www-form-urlencoded), exactly like
    // real Slack expects. A regression back to a JSON request body would drop these args here
    // (URLSearchParams finds no `key=value` pairs), so the conformance suite fails the way
    // slack.com does.
    const body: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
      body[k] = decodeFormValue(v);
    }

    const reply = (payload: Record<string, unknown>): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    // The payload is computed BEFORE the hook runs, so an event the hook lands is genuinely
    // concurrent with this request rather than reflected in its (already snapshotted) answer.
    const replyAfterHook = async (method: string, payload: Record<string, unknown>): Promise<void> => {
      await this.hooks.get(method)?.(this.hits(method));
      reply(payload);
    };

    if (req.method !== 'POST' || req.url === undefined || !req.url.startsWith('/api/')) {
      reply({ ok: false, error: 'unknown_method' });
      return;
    }

    const method = req.url.slice('/api/'.length);
    // Keep the counter AHEAD of the auth check, so that a storm of token-less calls cannot score
    // zero against every `hits()` ceiling in the suite — the counter's meaning is "reached the wire".
    this.requests.set(method, this.hits(method) + 1);
    this.bodies.set(method, [...this.requestBodies(method), body]);
    if (req.headers.authorization === undefined) {
      this.unauthenticated.set(method, this.unauthedHits(method) + 1);
      reply({ ok: false, error: 'not_authed' });
      return;
    }

    const held = this.latency.get(method);
    if (held !== undefined) await new Promise<void>((r) => setTimeout(r, held));
    const failure = this.failures.get(method);
    if (failure !== undefined && failure.times > 0) {
      failure.times--;
      reply({ ok: false, error: failure.code });
      return;
    }

    switch (method) {
      case 'chat.postMessage':
        await replyAfterHook(method, this.postMessage(body));
        return;
      case 'conversations.history':
        await replyAfterHook(method, this.history(body));
        return;
      case 'apps.connections.open':
        this.connectionsOpened++;
        await replyAfterHook(method, { ok: true, url: this.handedOutWsUrl ?? this.wsUrl });
        return;
      case 'auth.test':
        reply({ ok: true, user: 'parley-bot', user_id: 'U0PARLEY', bot_id: 'B0PARLEY', team: 'T0FAKE' });
        return;
      case 'users.lookupByEmail':
        if (body.email === 'alice@example.com') {
          reply({ ok: true, user: { id: 'U0ALICE', name: 'alice' } });
        } else {
          reply({ ok: false, error: 'users_not_found' });
        }
        return;
      default:
        reply({ ok: false, error: 'unknown_method' });
    }
  }

  private postMessage(body: Record<string, unknown>): Record<string, unknown> {
    const channel = body.channel;
    const text = body.text;
    if (typeof channel !== 'string' || typeof text !== 'string') {
      return { ok: false, error: 'invalid_arguments' };
    }
    if (!this.known.has(channel)) return { ok: false, error: 'channel_not_found' };
    // Real Slack ACCEPTS this and turns it into a live broadcast/mention; refuse it here instead, so
    // that dropping the sender's escaping cannot pass silently. `unescaped_markup` is this fake's
    // own sentinel — Slack has no such code, and no production path may depend on it.
    if (UNESCAPED_MARKUP.test(stripEntities(text))) {
      return { ok: false, error: 'unescaped_markup' };
    }
    // Unique AND per-channel monotonic even under concurrent writers: epoch seconds never move
    // backwards and the global counter suffix strictly increases (integer-wise, not lexically).
    const ts = this.mintTs();
    const msg: StoredMessage = { type: 'message', ts, text, user: 'U0PARLEY', bot_id: 'B0PARLEY' };
    // `thread_ts` files the post under a thread, and `reply_broadcast` makes Slack ALSO file a
    // channel-level `thread_broadcast` copy — the two request fields that decide whether the id
    // `chat.postMessage` returns is reachable through `conversations.history` at all. A fake that
    // stored every post at channel level graded threading against a contract slack.com does not
    // have, and `seed()` was then the only writer that could produce a threaded row.
    if (typeof body.thread_ts === 'string') {
      msg.thread_ts = body.thread_ts;
      if (body.reply_broadcast === 'true' || body.reply_broadcast === true) {
        msg.subtype = 'thread_broadcast';
      }
    }
    const list = this.channels.get(channel) ?? [];
    list.push(msg);
    this.channels.set(channel, list);

    // Events API push (own posts included, like Slack) — to ONE connection, see deliverToOneSocket.
    const envelopeId = `env-${rand()}`;
    this.pushed.add(envelopeId);
    this.deliverToOneSocket(
      JSON.stringify({
        envelope_id: envelopeId,
        type: 'events_api',
        payload: { event: { ...msg, channel } },
      }),
    );

    return { ok: true, channel, ts };
  }

  /**
   * The objects one page may carry: what the caller ASKED for, capped by the tier's own page size
   * and defaulting to Slack's documented 100 when the request omits `limit`. Serving `pageSize`
   * regardless would hide a request that dropped, renamed or mistyped the parameter.
   */
  private pageLength(body: Record<string, unknown>): number {
    const asked = Number(body.limit);
    return Math.min(Number.isInteger(asked) && asked > 0 ? asked : 100, this.pageSize);
  }

  private history(body: Record<string, unknown>): Record<string, unknown> {
    const channel = body.channel;
    if (typeof channel !== 'string') return { ok: false, error: 'invalid_arguments' };
    if (!this.known.has(channel)) return { ok: false, error: 'channel_not_found' };
    let msgs = [...(this.channels.get(channel) ?? [])].filter(
      (m) => m === null || typeof m !== 'object' || isChannelLevel(m),
    );
    const oldest = body.oldest;
    if (typeof oldest === 'string') {
      // `oldest` is EXCLUSIVE unless the caller sets `inclusive` (the plugin never does). An entry
      // with no orderable `ts` is never filtered out — those exist to reach the plugin, and a fake
      // that quietly swallowed them would grade the plugin on input it never receives.
      msgs = msgs.filter(
        (m) =>
          !isOrderable(m) ||
          (body.inclusive === true ? compareTs(m.ts, oldest) >= 0 : compareTs(m.ts, oldest) > 0),
      );
    }
    msgs.sort((a, b) => compareTs(orderOf(b), orderOf(a))); // NEWEST first, like Slack
    if (this.historyOrder === 'oldest-first') msgs.reverse();
    const offset = typeof body.cursor === 'string' ? Number(body.cursor) : 0;
    const size = this.pageLength(body);
    let page = msgs.slice(offset, offset + size);
    if (this.historyOrder === 'page-reversed') page = [...page].reverse();
    if (this.historyOrder === 'shuffled') {
      page = shuffleDeterministically(page, Number(String(page[0]?.ts ?? '1').split('.')[1] ?? 1));
    }
    const hasMore = offset + size < msgs.length;
    return {
      ok: true,
      messages: page,
      has_more: hasMore,
      response_metadata: { next_cursor: hasMore ? String(offset + size) : '' },
    };
  }
}
