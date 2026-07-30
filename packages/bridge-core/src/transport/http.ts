import type { Server as NodeHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type RequestHandler } from 'express';
import type { ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { CORE_VERSION } from '../version.js';
import { startPresenceLoop, type PresenceLoop } from './presence-loop.js';
import { registerTools, toolDepsFor, type ToolDeps } from './tools.js';

/**
 * Build a REACTIVE-ONLY MCP server (DESIGN §8/§10 remote mode): the post / fetchRecent / reply
 * tools over the same seam, with NO `claude/channel` capability and NO push loop — the chat
 * client cannot receive pushes. `deps` is derived ONCE at app scope (see {@link createRemoteHttpApp})
 * and shared across every per-request server, so the allowlist/regexes are compiled a single time,
 * not per POST. No `seen` is passed: without a push loop there is no dedup state to maintain.
 */
export function buildReactiveServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'parley', version: CORE_VERSION }, { capabilities: { tools: {} } });
  registerTools(server, deps);
  return server;
}

/**
 * Tear one per-request object down without letting its failure escape. Keep the WHOLE call inside
 * the try, so that a `close` which throws synchronously — or rejects a tick later, as a transport
 * over an already-destroyed socket does — cannot become an unhandledRejection: this runs from a
 * response `close` event, where nothing is awaiting it and Node would take the process down.
 */
async function closeQuietly(what: string, target: { close: () => Promise<void> }): Promise<void> {
  try {
    await target.close();
  } catch (err) {
    console.error(`[parley] ${what} close failed:`, err);
  }
}

/**
 * How long {@link RemoteHttpServer.close} lets an in-flight request finish before its socket is
 * destroyed. Node's `server.close()` waits for every open connection, and a `parley_fetch_recent`
 * long-poll holds one for its whole `catchup.block_max_ms` budget (60 s by default) — past a
 * `docker stop` grace period, so the process is SIGKILLed mid-teardown while the presence goodbye
 * has already advertised it as gone. The tool layer answers an aborted long-poll with an empty
 * result, so cutting one short is safe.
 */
const CLOSE_GRACE_MS = 250;

/**
 * Host header values accepted when no explicit `allowedHosts` is configured: loopback only, on any
 * port. This is the DNS-rebinding gate — a browser the operator visits can be pointed at
 * 127.0.0.1 by re-resolving an attacker domain, and the request is then same-origin so CORS does
 * not protect it. Only the `Host`/`Origin` the attacker's page carries gives it away.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** The host part of a `Host`/`Origin` header value, port stripped, lowercased. */
function hostnameOf(value: string): string {
  const authority = value.includes('://') ? value.slice(value.indexOf('://') + 3) : value;
  const hostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : (authority.split(':')[0] ?? '');
  return hostname.toLowerCase();
}

export interface RemoteHttpOptions {
  /** Middleware protecting the /mcp route (e.g. requireBearerAuth). Default: FAIL CLOSED (401). */
  protect?: RequestHandler;
  /**
   * Hostnames this app answers to (ports ignored). Requests whose `Host` — or whose `Origin`, when
   * the browser sent one — names anything else get a 403, which is what stops DNS rebinding from
   * reaching the endpoint through a browser the operator visits.
   *
   * Enforced whenever this is set, and by default whenever {@link insecureNoAuth} is on (loopback
   * only). A bearer-protected deployment without this option is not gated here: it is typically
   * reached through a proxy under a public name this layer is not told, and a rebinding page cannot
   * forge the `Authorization` header anyway.
   */
  allowedHosts?: string[];
  /**
   * Explicitly run /mcp with NO auth — dev/loopback only. Named so the insecurity is visible at
   * the call site. Ignored when `protect` is set. Default: false (fail closed).
   */
  insecureNoAuth?: boolean;
  /** Mount extra routers (e.g. the OAuth front door) on the app before /mcp is wired. */
  configureApp?: (app: Express) => void;
  /** MCP endpoint path. Default `/mcp`. */
  mcpPath?: string;
}

export interface RemoteHttpServer {
  app: Express;
  listen(port: number, host?: string): Promise<NodeHttpServer>;
  close(): Promise<void>;
}

/**
 * Create the remote-mode Express app: a Streamable-HTTP MCP endpoint backed by the reactive
 * server. STATELESS — a fresh transport + server per POST, no `mcp-session-id`, no SSE, no server
 * push; GET and DELETE answer 405. The same seam/tools are reused across stdio and HTTP — only
 * this transport/auth layer differs (DESIGN §10).
 */
export function createRemoteHttpApp(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  opts: RemoteHttpOptions = {},
): RemoteHttpServer {
  const app = express();
  app.disable('x-powered-by');
  // Keep these anti-clickjacking / hardening headers on every response, so the browser-facing
  // OAuth /authorize consent page (owner-passphrase form) and /parley/consent stay covered too.
  // Applied app-wide
  // because the whole app is single-purpose. HSTS is ignored by browsers over plain HTTP, so it is
  // safe to send unconditionally and takes effect only on the HTTPS deployment.
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  const allowedHosts =
    opts.allowedHosts ?? (opts.insecureNoAuth === true && opts.protect === undefined ? LOOPBACK_HOSTS : undefined);
  if (allowedHosts !== undefined) {
    const allowed = new Set(allowedHosts.map((h) => hostnameOf(h)));
    // Keep this ahead of configureApp, so that the OAuth consent/authorize routes are covered too.
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      const bad =
        !allowed.has(hostnameOf(req.headers.host ?? '')) ||
        (typeof origin === 'string' && origin.length > 0 && !allowed.has(hostnameOf(origin)));
      if (bad) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Forbidden: host not allowed' },
          id: null,
        });
        return;
      }
      next();
    });
  }

  const mcpPath = opts.mcpPath ?? '/mcp';
  opts.configureApp?.(app);

  // Derive the tool deps ONCE at app scope (config is constant): the allowlist/regexes and tool
  // descriptions are compiled a single time and reused by every per-request reactive server and by
  // the presence loop below — no per-POST recompilation.
  const deps = toolDepsFor(plugin, cfg);

  // The chat bridge is a long-lived participant too: announce presence off the shared plugin
  // (the reactive servers are per-request and stateless, so presence lives at app scope). Keep this
  // armed but NOT fired here — `listen` calls it only once the socket is up, so an app whose bind
  // fails, or which is never listened on, can never advertise itself as reachable.
  let presence: PresenceLoop | undefined;
  const announce = (): void => {
    if (cfg.presence.enabled) {
      presence = startPresenceLoop(plugin, deps.identity, deps.allow, {
        presenceTopic: deps.presenceTopic,
        heartbeatMs: cfg.presence.heartbeat_ms,
      });
    }
  };

  // Keep this fail-CLOSED default. Omitting both `protect` and `insecureNoAuth` yields a 401, not
  // an open endpoint. A no-arg call must never mean "no auth".
  const failClosed: RequestHandler = (_req, res) => {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: no auth middleware configured' },
      id: null,
    });
  };
  const protect: RequestHandler =
    opts.protect ?? (opts.insecureNoAuth ? (_req, _res, next) => next() : failClosed);
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed: stateless reactive server' },
      id: null,
    });
  };

  // STATELESS (DESIGN §10; recommended for reactive-only): a fresh server + transport per POST,
  // torn down on response close. The plugin is shared and long-lived; building a server just
  // re-registers handlers. No session map, no SSE, no server push — chat is request/response only.
  const handlePost: RequestHandler = async (req, res) => {
    try {
      const server = buildReactiveServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void closeQuietly('transport', transport);
        void closeQuietly('reactive server', server);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // Never echo internal error detail to the client; log it for the operator instead.
      console.error('[parley] /mcp request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
    }
  };

  app.post(mcpPath, protect, express.json(), handlePost);
  app.get(mcpPath, protect, methodNotAllowed);
  app.delete(mcpPath, protect, methodNotAllowed);

  let httpServer: NodeHttpServer | undefined;
  return {
    app,
    // Keep rejecting on a bind failure (EADDRINUSE, EACCES, bad host) instead of resolving a
    // never-bound server (address() === null) the composition root cannot detect, retry, or
    // cleanly shut down. Express 5 (`app.listen`) wraps our callback in `once()` and ALSO
    // registers it as `server.once('error', done)` BEFORE we can attach our own listener — so on
    // a bind error our callback is invoked FIRST, with the error as its argument. We must inspect
    // that argument and reject: ignoring it (and only relying on the `s.once('error', reject)`
    // below) resolves the promise on the settle race and leaves reject a no-op. The `s.once` is a
    // belt-and-suspenders for any error path that skips the callback; the success branch removes
    // it so a later runtime error on the live server cannot reject an already-settled promise.
    // `httpServer = s` is set synchronously so close() can still find it.
    listen: (port, host = '127.0.0.1') =>
      new Promise<NodeHttpServer>((resolve, reject) => {
        // Keep a live socket from being orphaned by a second start: overwriting `httpServer` would
        // leave the first one bound forever and its presence loop beating past close(), advertising
        // a shut-down bridge as online. A server that failed to bind is not live, so a failed
        // listen stays retryable.
        if (httpServer?.listening === true) {
          reject(new Error('remote HTTP server already listening'));
          return;
        }
        const s = app.listen(port, host, (err?: Error) => {
          if (err) {
            reject(err);
            return;
          }
          s.off('error', reject);
          announce();
          resolve(s);
        });
        s.once('error', reject);
        httpServer = s;
      }),
    // Keep close() a no-op on a server that is not up — never listened on, bind failed, or already
    // closed — so that a `try { await listen() } finally { await close() }` root, or a signal
    // handler racing an explicit shutdown, cannot turn teardown into a fatal
    // ERR_SERVER_NOT_RUNNING. Dropping the reference is what makes it both idempotent and
    // re-listenable.
    close: async () => {
      await presence?.stop().catch(() => {}); // best-effort goodbye, never blocks the close
      presence = undefined;
      const s = httpServer;
      httpServer = undefined;
      if (s === undefined || !s.listening) return;
      s.closeIdleConnections();
      // Keep this deadline armed: `s.close()` alone resolves only once every in-flight request has
      // finished, and a long-poll's is measured in tens of seconds.
      const cutoff = setTimeout(() => s.closeAllConnections(), CLOSE_GRACE_MS);
      cutoff.unref?.();
      try {
        await new Promise<void>((resolve, reject) => {
          s.close((e) => (e ? reject(e) : resolve()));
        });
      } finally {
        clearTimeout(cutoff);
      }
    },
  };
}
