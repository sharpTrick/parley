import type { Server as NodeHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type RequestHandler } from 'express';
import type { ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { CORE_VERSION } from '../version.js';
import { startPresenceLoop } from './presence-loop.js';
import { registerTools, toolDepsFor, type ToolDeps } from './tools.js';

/**
 * Build a REACTIVE-ONLY MCP server (DESIGN §8/§10 remote mode): the post / fetchRecent / reply
 * tools over the same seam, with NO `claude/channel` capability and NO push loop — the chat
 * client cannot receive pushes. `deps` is derived ONCE at app scope (see {@link createRemoteHttpApp})
 * and shared across every per-request server, so the allowlist/regexes are compiled a single time,
 * not per POST. No `seen` is passed: without a push loop there is no dedup state to maintain (CX-06).
 */
export function buildReactiveServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'parley', version: CORE_VERSION }, { capabilities: { tools: {} } });
  registerTools(server, deps);
  return server;
}

export interface RemoteHttpOptions {
  /** Middleware protecting the /mcp route (e.g. requireBearerAuth). Default: open (no auth). */
  protect?: RequestHandler;
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
 * server. Session-per-connection (stateful): a new transport + server is created on the
 * initialize request and reused by `mcp-session-id`. The same seam/tools are reused across
 * stdio and HTTP — only this transport/auth layer differs (DESIGN §10).
 */
export function createRemoteHttpApp(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  opts: RemoteHttpOptions = {},
): RemoteHttpServer {
  const app = express();
  app.disable('x-powered-by');
  const mcpPath = opts.mcpPath ?? '/mcp';
  opts.configureApp?.(app);

  // Derive the tool deps ONCE at app scope (config is constant): the allowlist/regexes and tool
  // descriptions are compiled a single time and reused by every per-request reactive server and by
  // the presence loop below — no per-POST recompilation, no duplicate app-scope derivation (CX-09).
  const deps = toolDepsFor(plugin, cfg);

  // The chat bridge is a long-lived participant too: announce presence off the shared plugin
  // (the reactive servers are per-request and stateless, so presence lives at app scope).
  const presence = cfg.presence.enabled
    ? startPresenceLoop(plugin, deps.identity, deps.allow, {
        presenceTopic: deps.presenceTopic,
        heartbeatMs: cfg.presence.heartbeat_ms,
      })
    : undefined;

  const protect: RequestHandler = opts.protect ?? ((_req, _res, next) => next());
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
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
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
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve) => {
        httpServer = app.listen(port, host, () => resolve(httpServer as NodeHttpServer));
      }),
    close: async () => {
      await presence?.stop(); // best-effort goodbye
      await new Promise<void>((resolve, reject) => {
        if (httpServer === undefined) {
          resolve();
          return;
        }
        httpServer.close((e) => (e ? reject(e) : resolve()));
      });
    },
  };
}
