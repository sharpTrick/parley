import { randomUUID } from 'node:crypto';
import type { Server as NodeHttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
  const mcpPath = opts.mcpPath ?? '/mcp';
  opts.configureApp?.(app);

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const protect: RequestHandler = opts.protect ?? ((_req, _res, next) => next());

  const handle: RequestHandler = async (req, res) => {
    try {
      const sid = req.header('mcp-session-id');
      let transport = sid !== undefined ? transports.get(sid) : undefined;

      if (transport === undefined) {
        if (sid !== undefined || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: no valid session for this request' },
            id: null,
          });
          return;
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, created);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });
        const server = buildReactiveServer(plugin, cfg);
        await server.connect(created);
        transport = created;
      }

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

  app.post(mcpPath, protect, express.json(), handle);
  app.get(mcpPath, protect, handle);
  app.delete(mcpPath, protect, handle);

  let httpServer: NodeHttpServer | undefined;
  return {
    app,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve) => {
        httpServer = app.listen(port, host, () => resolve(httpServer as NodeHttpServer));
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const t of transports.values()) void t.close();
        transports.clear();
        if (httpServer === undefined) {
          resolve();
          return;
        }
        httpServer.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
