/**
 * In-process fake of the Discord REST v10 + gateway surface the plugin speaks — just enough
 * protocol to run the shared conformance suite hermetically (no real Discord, no credentials).
 *
 * Fidelity notes (matching real Discord where it matters to the seam):
 *   - Message ids are minted from a GLOBAL strictly-increasing counter, as decimal snowflake
 *     strings — time-ordered per channel, NOT lexically comparable (forces BigInt compares).
 *   - `GET /channels/:id/messages` honors `after` (EXCLUSIVE, BigInt compare) + `limit`, and
 *     returns the page NEWEST-FIRST — so the plugin's reverse-to-ascending is exercised.
 *   - `POST .../messages` broadcasts an op 0 MESSAGE_CREATE dispatch to every IDENTIFYed
 *     gateway socket (bots DO receive their own sends), with a per-socket event seq `s`.
 *   - Gateway: op 10 HELLO on connect; op 2 IDENTIFY → op 0 READY; op 1 heartbeat → op 11 ack.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/** The fake's one bot account (`GET /users/@me`, and `author` on every stored message). */
const BOT_USER = { id: '990000000000000001', username: 'parley-bot' };

/** Global increasing counter → decimal snowflake strings, unique across all fake instances. */
let snowflake = 100_000_000_000_000n;
const mintId = (): string => String(++snowflake);

interface FakeMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string };
  message_reference?: { message_id: string };
}

export interface FakeDiscord {
  /** REST base, path-compatible with the real thing: `http://127.0.0.1:<port>/api/v10`. */
  apiUrl: string;
  /** Gateway websocket URL (also what `GET /gateway/bot` answers). */
  gatewayUrl: string;
  close(): Promise<void>;
}

export async function startFakeDiscord(): Promise<FakeDiscord> {
  /** channel id → messages in arrival (= snowflake) order, oldest first. */
  const channels = new Map<string, FakeMessage[]>();
  /** Connected gateway sockets → { identified, per-socket dispatch seq }. */
  const sockets = new Map<WebSocket, { identified: boolean; seq: number }>();
  let gatewayUrl = ''; // known after listen(); read lazily by the request handler

  const broadcast = (msg: FakeMessage): void => {
    for (const [ws, state] of sockets) {
      if (!state.identified || ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: ++state.seq, d: msg }));
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/v10/gateway/bot') {
      return json(res, 200, { url: gatewayUrl });
    }
    if (req.method === 'GET' && url.pathname === '/api/v10/users/@me') {
      return json(res, 200, BOT_USER);
    }

    const m = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    if (m !== null) {
      const channelId = decodeURIComponent(m[1]!);
      if (req.method === 'POST') {
        const body = (await readJson(req)) as {
          content?: string;
          message_reference?: { message_id: string };
        };
        const msg: FakeMessage = {
          id: mintId(),
          channel_id: channelId,
          content: body.content ?? '',
          timestamp: new Date().toISOString(),
          author: BOT_USER,
          ...(body.message_reference !== undefined
            ? { message_reference: body.message_reference }
            : {}),
        };
        let list = channels.get(channelId);
        if (list === undefined) {
          list = [];
          channels.set(channelId, list);
        }
        list.push(msg);
        broadcast(msg);
        return json(res, 200, msg);
      }
      if (req.method === 'GET') {
        const after = url.searchParams.get('after');
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 100);
        let list = channels.get(channelId) ?? [];
        // `after` is EXCLUSIVE; snowflakes are decimal strings → BigInt compare, never lexical.
        if (after !== null) list = list.filter((msg) => BigInt(msg.id) > BigInt(after));
        // With `after`: the OLDEST `limit` past it (forward paging window); without: the most
        // recent `limit`. Either way the page is returned NEWEST-FIRST, like real Discord.
        const window = after !== null ? list.slice(0, limit) : list.slice(-limit);
        return json(res, 200, [...window].reverse());
      }
    }

    json(res, 404, { message: 'Not Found', code: 0 });
  }

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    const state = { identified: false, seq: 0 };
    sockets.set(ws, state);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data) => {
      let payload: { op?: number };
      try {
        payload = JSON.parse(String(data)) as { op?: number };
      } catch {
        return;
      }
      if (payload.op === 2) {
        state.identified = true;
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: ++state.seq,
            d: { user: BOT_USER, session_id: 'fake-session' },
          }),
        );
      } else if (payload.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      }
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  gatewayUrl = `ws://127.0.0.1:${port}`;

  return {
    apiUrl: `http://127.0.0.1:${port}/api/v10`,
    gatewayUrl,
    close: async () => {
      for (const ws of sockets.keys()) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}
