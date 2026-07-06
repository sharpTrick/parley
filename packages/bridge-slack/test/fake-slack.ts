/**
 * In-process fake Slack — just enough Web API + Socket Mode surface for the conformance suite.
 * `node:http` serves the Web API methods; a `ws.WebSocketServer` on the same server plays the
 * Socket Mode side. Deliberately mirrors the real contract where the plugin depends on it:
 *   - `ts` values are unique AND strictly increasing per channel (global counter suffix), even
 *     under concurrent writers — the property that makes ts a valid cursor.
 *   - `conversations.history` returns NEWEST-first with `oldest` EXCLUSIVE (unless `inclusive`),
 *     and pages at a FIXED size of 50 via `response_metadata.next_cursor`, so the conformance
 *     multi-writer case (100 messages) forces real multi-page assembly in the plugin.
 *   - Every `chat.postMessage` pushes an `events_api` envelope to ALL connected sockets (Slack
 *     delivers the bot's own posts back), and incoming `{envelope_id}` acks are recorded so tests
 *     can assert the ack-every-envelope discipline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/** Fixed page size — small enough that the 100-message conformance case spans 3 pages. */
const PAGE_SIZE = 50;

interface StoredMessage {
  type: 'message';
  ts: string;
  text: string;
  user: string;
  bot_id: string;
}

/** Same integer-wise ts comparison the plugin uses — independent copy, not imported from src. */
function compareTs(a: string, b: string): number {
  const [aSec, aSub] = a.split('.');
  const [bSec, bSub] = b.split('.');
  const bySec = Number(aSec) - Number(bSec);
  if (bySec !== 0) return bySec;
  return Number(aSub ?? '0') - Number(bSub ?? '0');
}

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

  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
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
      // Socket Mode greets with hello once the connection is ready (no envelope_id, no ack).
      ws.send(JSON.stringify({ type: 'hello', num_connections: fake.sockets.size }));
    });
    return fake;
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

    if (req.method !== 'POST' || req.url === undefined || !req.url.startsWith('/api/')) {
      reply({ ok: false, error: 'unknown_method' });
      return;
    }
    if (req.headers.authorization === undefined) {
      reply({ ok: false, error: 'not_authed' });
      return;
    }

    switch (req.url.slice('/api/'.length)) {
      case 'chat.postMessage':
        reply(this.postMessage(body));
        return;
      case 'conversations.history':
        reply(this.history(body));
        return;
      case 'apps.connections.open':
        reply({ ok: true, url: this.wsUrl });
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
    // Unique AND per-channel monotonic even under concurrent writers: epoch seconds never move
    // backwards and the global counter suffix strictly increases (integer-wise, not lexically).
    const ts = `${Math.floor(Date.now() / 1000)}.${String(++this.counter).padStart(6, '0')}`;
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
    let msgs = [...(this.channels.get(channel) ?? [])];
    const oldest = body.oldest;
    if (typeof oldest === 'string') {
      // `oldest` is EXCLUSIVE unless the caller sets `inclusive` (the plugin never does).
      msgs = msgs.filter((m) =>
        body.inclusive === true ? compareTs(m.ts, oldest) >= 0 : compareTs(m.ts, oldest) > 0,
      );
    }
    msgs.sort((a, b) => compareTs(b.ts, a.ts)); // NEWEST first, like Slack
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
