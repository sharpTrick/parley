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
 *     `createChannel` takes the channel `type` (default `0`, a guild text channel), so a DM class
 *     that can never carry push is representable.
 *   - Every REST path REFUSES a request whose `User-Agent` is not Discord's required
 *     `DiscordBot ($url, $version)` (`403`, the way Cloudflare answers in front of the API) or whose
 *     `Authorization` is not `Bot <token>` (`401`); the gateway refuses a CONNECT url missing the
 *     required `v`/`encoding` query params (4012), an IDENTIFY without that token (4004) or missing
 *     a required intent (4014), and `POST .../messages` refuses a body with no `allowed_mentions`.
 *     Keep those refusals here, so that a plugin change which stops sending one loses a test
 *     instead of passing silently.
 *   - `GET /channels/:id/messages` honors `after` (EXCLUSIVE, BigInt compare), `before`
 *     (EXCLUSIVE, backward paging) and `limit` (1–100, else `400`), and returns the page
 *     NEWEST-FIRST — so the plugin's reverse-to-ascending is exercised.
 *   - `POST .../messages` enforces Discord's 2000-character content cap (`400`, code 50035) and
 *     broadcasts an op 0 MESSAGE_CREATE dispatch to every IDENTIFYed gateway socket (bots DO
 *     receive their own sends), with a per-socket event seq `s`.
 *   - `injectFault` scripts any status/headers/body (429 with header and/or body `retry_after`,
 *     403 Missing Access, 500 …) so the error half of the plugin is testable; `closeGateway`
 *     forces a gateway close code onto live sockets, and `scriptGateway` decides how the NEXT
 *     connection is answered (a close code, a drop, or a stall).
 *   - Gateway: op 10 HELLO on connect; op 2 IDENTIFY → op 0 READY; op 1 heartbeat → op 11 ack.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { REQUIRED_INTENTS } from '../src/intents.js';
import { gatewayQueryOk } from './fake-gateway.js';

/** Discord's documented User-Agent shape; Cloudflare may block a request without one. */
export const USER_AGENT_RE = /^DiscordBot \(.+, .+\)$/;

/** The fake's one bot account (`GET /users/@me`, and `author` on every stored message). */
export const BOT_USER = { id: '990000000000000001', username: 'parley-bot' };

/** The bot token the fake accepts unless `startFakeDiscord` is given another. */
export const FAKE_TOKEN = 'fake-token';

/** Discord channel types: a guild text channel, a DM, and a group DM. */
export const GUILD_TEXT = 0;
export const DM = 1;
export const GROUP_DM = 3;

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
  /** Users Discord resolved from `<@id>` markup in `content` — present on REST and gateway alike. */
  mentions?: Array<{ id: string; username: string }>;
}

/** A scripted response served INSTEAD of the normal handler, once per queued entry. */
export interface FakeFault {
  status: number;
  body?: unknown;
  /** Served verbatim instead of `body` — the way to script a body no JSON encoder would produce. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Only consume this fault for requests whose path contains this substring. */
  path?: string;
  /** Serve it this many times (default 1). */
  times?: number;
  /** Hold the response this long before writing it — a request that stalls rather than fails. */
  delayMs?: number;
}

export interface FakeDiscord {
  /** REST base, path-compatible with the real thing: `http://127.0.0.1:<port>/api/v10`. */
  apiUrl: string;
  /** Gateway websocket URL (also what `GET /gateway/bot` answers). */
  gatewayUrl: string;
  /**
   * Make a channel id resolvable, as `type` (default {@link GUILD_TEXT}). Ids that were never
   * created answer 404 / code 10003.
   */
  createChannel(id: string, type?: number): void;
  /** Every `POST .../messages` body the fake accepted, oldest first. */
  posts(): Array<{ channelId: string; body: Record<string, unknown> }>;
  /** Queue a scripted failure (or any response) for the next matching request(s). */
  injectFault(fault: FakeFault): void;
  /**
   * Store and broadcast a message the fake did not mint from `post` — i.e. a HUMAN's, carrying
   * whatever native markup and resolved `mentions[]` Discord would have put on it.
   */
  deliver(
    channelId: string,
    msg: {
      content: string;
      mentions?: Array<{ id: string; username: string }>;
      author?: { id: string; username: string };
    },
  ): void;
  /** Requests received so far, optionally filtered to paths containing `pathIncludes`. */
  requestCount(pathIncludes?: string): number;
  /** The raw `path?query` of every request received so far, oldest first — undecoded. */
  requests(): string[];
  /** The `User-Agent` of every request received so far, oldest first (`''` when absent). */
  userAgents(): string[];
  /** Close every connected gateway socket with an explicit gateway close code. */
  closeGateway(code: number): void;
  /**
   * How the fake answers every LATER gateway connection: `undefined` speaks the protocol, a number
   * closes with that code before HELLO, `'drop'` cuts the connection (1006), and `'stall'` accepts
   * the socket and then says nothing.
   */
  scriptGateway(script: number | 'stall' | 'drop' | undefined): void;
  close(): Promise<void>;
}

export async function startFakeDiscord(opts?: { token?: string }): Promise<FakeDiscord> {
  const token = opts?.token ?? FAKE_TOKEN;
  /** channel id → messages in arrival (= snowflake) order, oldest first. Absent = no such channel. */
  const channels = new Map<string, FakeMessage[]>();
  const channelTypes = new Map<string, number>();
  /** Connected gateway sockets → { identified, per-socket dispatch seq }. */
  const sockets = new Map<WebSocket, { identified: boolean; seq: number }>();
  const faults: FakeFault[] = [];
  const requests: string[] = [];
  const userAgents: string[] = [];
  const accepted: Array<{ channelId: string; body: Record<string, unknown> }> = [];
  let gatewayUrl = ''; // known after listen(); read lazily by the request handler
  let gatewayScript: number | 'stall' | 'drop' | undefined;

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
    userAgents.push(req.headers['user-agent'] ?? '');

    // Cloudflare sits in FRONT of the API, so an unidentified client never reaches the credential
    // check — keep this first, so that a row varying the token cannot mask a missing User-Agent.
    if (!USER_AGENT_RE.test(req.headers['user-agent'] ?? '')) {
      return json(res, 403, { message: 'error code: 1010', code: 0 });
    }
    if (req.headers.authorization !== `Bot ${token}`) {
      return json(res, 401, { message: '401: Unauthorized', code: 0 });
    }

    const fault = takeFault(url.pathname + url.search);
    if (fault !== undefined) {
      if (fault.delayMs !== undefined) {
        // Give up the hold as soon as the client walks away, so that a stall a caller's deadline
        // aborted cannot outlive the case and write onto a destroyed response after `close()`.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, fault.delayMs);
          const stop = (): void => {
            clearTimeout(timer);
            resolve();
          };
          req.once('aborted', stop);
          res.once('close', stop);
        });
        if (res.destroyed) return;
      }
      if (fault.rawBody !== undefined) {
        res.writeHead(fault.status, { 'Content-Type': 'application/json', ...fault.headers });
        res.end(fault.rawBody);
        return;
      }
      return json(res, fault.status, fault.body ?? {}, fault.headers);
    }

    if (req.method === 'GET' && url.pathname === '/api/v10/gateway/bot') {
      return json(res, 200, { url: gatewayUrl });
    }
    if (req.method === 'GET' && url.pathname === '/api/v10/users/@me') {
      return json(res, 200, BOT_USER);
    }

    const one = /^\/api\/v10\/channels\/([^/]+)$/.exec(url.pathname);
    if (one !== null && req.method === 'GET') {
      const channelId = decodeURIComponent(one[1]!);
      if (!channels.has(channelId)) {
        return json(res, 404, { message: 'Unknown Channel', code: 10003 });
      }
      return json(res, 200, { id: channelId, type: channelTypes.get(channelId) ?? GUILD_TEXT });
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
          allowed_mentions?: unknown;
          message_reference?: { message_id: string };
        };
        // Absent `allowed_mentions` makes real Discord parse EVERY mention in `content`, so refuse
        // the unbounded body here rather than accepting it and losing the blast-radius contract.
        if (body.allowed_mentions === undefined) {
          return json(res, 400, {
            message: 'Invalid Form Body',
            code: 50035,
            errors: { allowed_mentions: { _errors: [{ code: 'MENTION_SCOPE_UNSPECIFIED' }] } },
          });
        }
        const content = body.content ?? '';
        // CODE POINTS, the unit Discord counts. Measuring UTF-16 units here would make the cap
        // self-confirming: a plugin using the same wrong unit would look correct on astral text.
        if ([...content].length > CONTENT_LIMIT) {
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
        accepted.push({ channelId, body: body as Record<string, unknown> });
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
  wss.on('connection', (ws, req) => {
    if (!gatewayQueryOk(`ws://127.0.0.1${req.url ?? ''}`)) {
      ws.close(4012); // an unversioned connect never gets HELLO out of real Discord either
      return;
    }
    if (gatewayScript !== undefined) {
      if (typeof gatewayScript === 'number') ws.close(gatewayScript);
      else if (gatewayScript === 'drop') ws.terminate();
      return;
    }
    const state = { identified: false, seq: 0 };
    sockets.set(ws, state);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data) => {
      let payload: { op?: number; d?: unknown };
      try {
        payload = JSON.parse(String(data)) as { op?: number; d?: unknown };
      } catch {
        return;
      }
      if (payload.op === 2) {
        const d = (payload.d ?? {}) as { token?: unknown; intents?: unknown };
        if (d.token !== token) {
          ws.close(4004);
          return;
        }
        const intents = typeof d.intents === 'number' ? d.intents : 0;
        if (Object.values(REQUIRED_INTENTS).some((bit) => (intents & bit) === 0)) {
          ws.close(4014);
          return;
        }
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
    createChannel: (id: string, type = GUILD_TEXT) => {
      if (!channels.has(id)) channels.set(id, []);
      channelTypes.set(id, type);
    },
    posts: () => [...accepted],
    injectFault: (fault: FakeFault) => faults.push({ ...fault }),
    deliver: (channelId, msg) => {
      const list = channels.get(channelId);
      if (list === undefined) throw new Error(`fake-discord: no such channel ${channelId}`);
      const stored: FakeMessage = {
        id: mintId(),
        channel_id: channelId,
        content: msg.content,
        timestamp: new Date().toISOString(),
        author: msg.author ?? { id: '112233445500', username: 'human' },
        ...(msg.mentions !== undefined ? { mentions: msg.mentions } : {}),
      };
      list.push(stored);
      broadcast(stored);
    },
    requestCount: (pathIncludes?: string) =>
      pathIncludes === undefined
        ? requests.length
        : requests.filter((p) => p.includes(pathIncludes)).length,
    requests: () => [...requests],
    userAgents: () => [...userAgents],
    closeGateway: (code: number) => {
      for (const ws of sockets.keys()) ws.close(code);
    },
    scriptGateway: (script) => {
      gatewayScript = script;
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
