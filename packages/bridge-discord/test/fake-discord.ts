/**
 * In-process fake of the Discord REST v10 + gateway surface the plugin speaks — just enough
 * protocol to run the shared conformance suite hermetically (no real Discord, no credentials).
 *
 * Fidelity notes (matching real Discord where it matters to the seam):
 *   - Message ids are minted from a GLOBAL strictly-increasing counter, as decimal snowflake
 *     strings — time-ordered per channel, NOT lexically comparable (forces BigInt compares).
 *   - Channels must EXIST (`createChannel`) before they resolve; an unknown id answers
 *     `404 {"message":"Unknown Channel","code":10003}` exactly as Discord does, so the plugin's
 *     absent-topic mapping is exercised rather than papered over by an invented empty page.
 *   - `GET /channels/:id/messages` honors `after` (EXCLUSIVE, BigInt compare), `before`
 *     (EXCLUSIVE, backward paging) and `limit` (1–100, else `400`), and returns the page
 *     NEWEST-FIRST — so the plugin's reverse-to-ascending is exercised.
 *   - `POST .../messages` enforces Discord's 2000-character content cap (`400`, code 50035) and
 *     broadcasts an op 0 MESSAGE_CREATE dispatch to every IDENTIFYed gateway socket (bots DO
 *     receive their own sends), with a per-socket event seq `s`.
 *   - `injectFault` scripts any status/headers/body (429 with header and/or body `retry_after`,
 *     403 Missing Access, 500 …) so the error half of the plugin is testable; `closeGateway`
 *     forces a gateway close code onto live sockets.
 *   - Gateway: op 10 HELLO on connect; op 2 IDENTIFY → op 0 READY; op 1 heartbeat → op 11 ack.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/** The fake's one bot account (`GET /users/@me`, and `author` on every stored message). */
const BOT_USER = { id: '990000000000000001', username: 'parley-bot' };

/** Discord's hard cap on a bot message body. */
export const CONTENT_LIMIT = 2000;
/** Discord's hard cap on one `GET /channels/:id/messages` page. */
export const PAGE_LIMIT = 100;

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

/** A scripted response served INSTEAD of the normal handler, once per queued entry. */
export interface FakeFault {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Only consume this fault for requests whose path contains this substring. */
  path?: string;
  /** Serve it this many times (default 1). */
  times?: number;
}

export interface FakeDiscord {
  /** REST base, path-compatible with the real thing: `http://127.0.0.1:<port>/api/v10`. */
  apiUrl: string;
  /** Gateway websocket URL (also what `GET /gateway/bot` answers). */
  gatewayUrl: string;
  /** Make a channel id resolvable. Ids that were never created answer 404 / code 10003. */
  createChannel(id: string): void;
  /** Queue a scripted failure (or any response) for the next matching request(s). */
  injectFault(fault: FakeFault): void;
  /** Requests received so far, optionally filtered to paths containing `pathIncludes`. */
  requestCount(pathIncludes?: string): number;
  /** Close every connected gateway socket with an explicit gateway close code. */
  closeGateway(code: number): void;
  close(): Promise<void>;
}

export async function startFakeDiscord(): Promise<FakeDiscord> {
  /** channel id → messages in arrival (= snowflake) order, oldest first. Absent = no such channel. */
  const channels = new Map<string, FakeMessage[]>();
  /** Connected gateway sockets → { identified, per-socket dispatch seq }. */
  const sockets = new Map<WebSocket, { identified: boolean; seq: number }>();
  const faults: FakeFault[] = [];
  const requests: string[] = [];
  let gatewayUrl = ''; // known after listen(); read lazily by the request handler

  const broadcast = (msg: FakeMessage): void => {
    for (const [ws, state] of sockets) {
      if (!state.identified || ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: ++state.seq, d: msg }));
    }
  };

  const takeFault = (path: string): FakeFault | undefined => {
    const i = faults.findIndex((f) => f.path === undefined || path.includes(f.path));
    if (i < 0) return undefined;
    const fault = faults[i]!;
    const remaining = (fault.times ?? 1) - 1;
    if (remaining <= 0) faults.splice(i, 1);
    else fault.times = remaining;
    return fault;
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);

    const fault = takeFault(url.pathname + url.search);
    if (fault !== undefined) {
      return json(res, fault.status, fault.body ?? {}, fault.headers);
    }

    if (req.method === 'GET' && url.pathname === '/api/v10/gateway/bot') {
      return json(res, 200, { url: gatewayUrl });
    }
    if (req.method === 'GET' && url.pathname === '/api/v10/users/@me') {
      return json(res, 200, BOT_USER);
    }

    const m = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    if (m !== null) {
      const channelId = decodeURIComponent(m[1]!);
      const list = channels.get(channelId);
      if (list === undefined) {
        return json(res, 404, { message: 'Unknown Channel', code: 10003 });
      }
      if (req.method === 'POST') {
        const body = (await readJson(req)) as {
          content?: string;
          message_reference?: { message_id: string };
        };
        const content = body.content ?? '';
        if (content.length > CONTENT_LIMIT) {
          return json(res, 400, {
            message: 'Invalid Form Body',
            code: 50035,
            errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH' }] } },
          });
        }
        const msg: FakeMessage = {
          id: mintId(),
          channel_id: channelId,
          content,
          timestamp: new Date().toISOString(),
          author: BOT_USER,
          ...(body.message_reference !== undefined
            ? { message_reference: body.message_reference }
            : {}),
        };
        list.push(msg);
        broadcast(msg);
        return json(res, 200, msg);
      }
      if (req.method === 'GET') {
        const after = url.searchParams.get('after');
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? '50');
        if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
          return json(res, 400, { message: 'Invalid Form Body', code: 50035 });
        }
        // `after`/`before` are EXCLUSIVE; snowflakes are decimal strings → BigInt, never lexical.
        let window = list;
        if (after !== null) window = window.filter((msg) => BigInt(msg.id) > BigInt(after));
        if (before !== null) window = window.filter((msg) => BigInt(msg.id) < BigInt(before));
        // With `after`: the OLDEST `limit` past it (forward paging window); otherwise the most
        // recent `limit`. Either way the page is returned NEWEST-FIRST, like real Discord.
        const page = after !== null ? window.slice(0, limit) : window.slice(-limit);
        return json(res, 200, [...page].reverse());
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
    createChannel: (id: string) => {
      if (!channels.has(id)) channels.set(id, []);
    },
    injectFault: (fault: FakeFault) => faults.push({ ...fault }),
    requestCount: (pathIncludes?: string) =>
      pathIncludes === undefined
        ? requests.length
        : requests.filter((p) => p.includes(pathIncludes)).length,
    closeGateway: (code: number) => {
      for (const ws of sockets.keys()) ws.close(code);
    },
    close: async () => {
      for (const ws of sockets.keys()) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
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
