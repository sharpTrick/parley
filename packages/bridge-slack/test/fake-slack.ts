/**
 * In-process fake Slack — just enough Web API + Socket Mode surface for the conformance suite.
 * `node:http` serves the Web API methods; a `ws.WebSocketServer` on the same server plays the
 * Socket Mode side. Deliberately mirrors the real contract where the plugin depends on it:
 *   - `ts` values are unique AND strictly increasing per channel (global counter suffix), even
 *     under concurrent writers — the property that makes ts a valid cursor.
 *   - `conversations.history` returns NEWEST-first with `oldest` EXCLUSIVE (unless `inclusive`),
 *     and pages at a FIXED size of 50 via `response_metadata.next_cursor`, so the conformance
 *     multi-writer case (100 messages) forces real multi-page assembly in the plugin.
 *   - A channel id that was never created answers `{ok:false, error:'channel_not_found'}` — an
 *     EXISTING but empty channel is the only thing that answers `ok:true, messages:[]`. Fabricating
 *     success for unknown ids would green the seam's absent-topic contract without testing it.
 *   - Every `chat.postMessage` pushes an `events_api` envelope to ALL connected sockets (Slack
 *     delivers the bot's own posts back), and incoming `{envelope_id}` acks are recorded so tests
 *     can assert the ack-every-envelope discipline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { compareTs } from '../src/index.js';

/** Fixed page size — small enough that the 100-message conformance case spans 3 pages. */
const PAGE_SIZE = 50;

interface StoredMessage {
  type: 'message';
  ts: string;
  text: string;
  user: string;
  bot_id: string;
  /** System/mutation records (`channel_join`, `message_changed`, …) carry a subtype; plain posts don't. */
  subtype?: string;
}

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

  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
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
  /** When false, new Socket Mode connections are closed WITHOUT `hello` (pre-`hello` close, BUG-30). */
  private greet = true;
  /** Global monotonic counter — the ts suffix. Node is single-threaded, so ts minting is atomic. */
  private counter = 0;
  private readonly channels = new Map<string, StoredMessage[]>();

  private constructor(server: Server, wss: WebSocketServer, port: number) {
    this.server = server;
    this.wss = wss;
    this.apiUrl = `http://127.0.0.1:${port}/api`;
    this.wsUrl = `ws://127.0.0.1:${port}/socket`;
  }

  static async start(): Promise<FakeSlack> {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeSlack(server, wss, (server.address() as AddressInfo).port);

    server.on('request', (req, res) => {
      void fake.handleHttp(req, res);
    });
    wss.on('connection', (ws) => {
      fake.sockets.add(ws);
      ws.on('close', () => fake.sockets.delete(ws));
      ws.on('message', (data) => {
        try {
          const { envelope_id } = JSON.parse(String(data)) as { envelope_id?: string };
          if (envelope_id !== undefined) fake.acked.add(envelope_id);
        } catch {
          /* ignore non-JSON */
        }
      });
      if (fake.greet) {
        // Socket Mode greets with hello once the connection is ready (no envelope_id, no ack).
        fake.helloSent++;
        ws.send(JSON.stringify({ type: 'hello', num_connections: fake.sockets.size }));
      } else {
        // Pre-`hello` close: accept the socket then immediately close it WITHOUT a hello, so the
        // plugin's pre-`hello` close branch (BUG-30) is exercised on every reconnect attempt.
        ws.close();
      }
    });
    return fake;
  }

  /** Toggle whether new Socket Mode connections receive `hello` or are closed pre-`hello`. */
  setGreet(on: boolean): void {
    this.greet = on;
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

  /** Sockets currently connected — must be 0 once a plugin has disconnected. */
  get liveSockets(): number {
    return this.sockets.size;
  }

  /** Push one raw `events_api` envelope (any subtype) to every connected socket. */
  pushEvent(channel: string, event: Record<string, unknown>): string {
    const envelopeId = `env-${rand()}`;
    this.pushed.add(envelopeId);
    const envelope = JSON.stringify({
      envelope_id: envelopeId,
      type: 'events_api',
      payload: { event: { type: 'message', channel, ...event } },
    });
    for (const ws of this.sockets) ws.send(envelope);
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
    const envelope = JSON.stringify({ envelope_id: envelopeId, ...body });
    for (const ws of this.sockets) ws.send(envelope);
    return envelopeId;
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
   * Bulk-seed a channel directly (bypassing `chat.postMessage`/the socket push) so pagination and
   * subtype-filter tests can stage large / system-subtype-heavy histories the live path can't cheaply
   * produce. `ts` is minted the same way `postMessage` does (unique, strictly increasing), so entries
   * are returned in insertion (ascending-`ts`) order.
   */
  seed(channel: string, entries: Array<{ text: string; subtype?: string }>): StoredMessage[] {
    this.createChannel(channel);
    const list = this.channels.get(channel) ?? [];
    const created = entries.map((e) => {
      const ts = this.mintTs();
      const msg: StoredMessage = { type: 'message', ts, text: e.text, user: 'U0PARLEY', bot_id: 'B0PARLEY' };
      if (e.subtype !== undefined) msg.subtype = e.subtype;
      list.push(msg);
      return msg;
    });
    this.channels.set(channel, list);
    return created;
  }

  async close(): Promise<void> {
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
    // slack.com does — which is precisely what makes the BUG-25 fix CI-observable.
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
    if (req.headers.authorization === undefined) {
      reply({ ok: false, error: 'not_authed' });
      return;
    }

    const method = req.url.slice('/api/'.length);
    this.requests.set(method, this.hits(method) + 1);
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
        await replyAfterHook(method, { ok: true, url: this.wsUrl });
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
    // Unique AND per-channel monotonic even under concurrent writers: epoch seconds never move
    // backwards and the global counter suffix strictly increases (integer-wise, not lexically).
    const ts = this.mintTs();
    const msg: StoredMessage = { type: 'message', ts, text, user: 'U0PARLEY', bot_id: 'B0PARLEY' };
    const list = this.channels.get(channel) ?? [];
    list.push(msg);
    this.channels.set(channel, list);

    // Events API push to every connected Socket Mode client (own posts included, like Slack).
    const envelopeId = `env-${rand()}`;
    this.pushed.add(envelopeId);
    const envelope = JSON.stringify({
      envelope_id: envelopeId,
      type: 'events_api',
      payload: { event: { ...msg, channel } },
    });
    for (const ws of this.sockets) ws.send(envelope);

    return { ok: true, channel, ts };
  }

  private history(body: Record<string, unknown>): Record<string, unknown> {
    const channel = body.channel;
    if (typeof channel !== 'string') return { ok: false, error: 'invalid_arguments' };
    if (!this.known.has(channel)) return { ok: false, error: 'channel_not_found' };
    let msgs = [...(this.channels.get(channel) ?? [])];
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
    const offset = typeof body.cursor === 'string' ? Number(body.cursor) : 0;
    const page = msgs.slice(offset, offset + PAGE_SIZE);
    const hasMore = offset + PAGE_SIZE < msgs.length;
    return {
      ok: true,
      messages: page,
      has_more: hasMore,
      response_metadata: { next_cursor: hasMore ? String(offset + PAGE_SIZE) : '' },
    };
  }
}
