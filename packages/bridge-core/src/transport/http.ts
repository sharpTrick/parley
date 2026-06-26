import type { Server as NodeHttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type RequestHandler } from 'express';
import { Allowlist } from '../allowlist.js';
import { SeenSet } from '../engine/seen-set.js';
import type { ParleyConfig } from '../config.js';
import { asHandle } from '../message.js';
import type { BackendPlugin } from '../seam.js';
import { registerTools } from './tools.js';

/**
 * Build a REACTIVE-ONLY MCP server (DESIGN §8/§10 remote mode): the post / fetchRecent / reply
 * tools over the same seam, with NO `claude/channel` capability and NO push loop — the chat
 * client cannot receive pushes. The plugin is shared and long-lived; one server is built per
 * HTTP session (cheap; just registers handlers).
 */
export function buildReactiveServer(plugin: BackendPlugin, cfg: ParleyConfig): Server {
  const server = new Server({ name: 'parley', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerTools(server, {
    plugin,
    identity: asHandle(cfg.identity.handle),
    allow: new Allowlist(cfg.topics),
    seen: new SeenSet(),
  });
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
      const server = buildReactiveServer(plugin, cfg);
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
    close: () =>
      new Promise((resolve, reject) => {
        if (httpServer === undefined) {
          resolve();
          return;
        }
        httpServer.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
