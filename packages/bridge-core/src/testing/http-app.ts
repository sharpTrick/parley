import type { AddressInfo } from 'node:net';
import { parseConfig } from '../config.js';
import {
  createRemoteHttpApp,
  type RemoteHttpOptions,
  type RemoteHttpServer,
} from '../transport/http.js';
import { FakePlugin } from './fake-plugin.js';

/**
 * The ONE remote-HTTP app fixture the transport suites run on.
 *
 * Four files used to spell out their own `FakePlugin + parseConfig + createRemoteHttpApp + listen(0)`
 * block, and they had already drifted in the `clientInfo` they sent and in whether they disabled
 * presence — so a case that reads like its neighbour was exercising a different app. Keep the config
 * defaults here and the per-suite variation an explicit override, so that a suite's stance on
 * presence or auth is visible at its call site rather than buried in a copied helper.
 */

/** Headers a Streamable-HTTP MCP client must send on a POST. */
export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** A well-formed `initialize` request body. */
export const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'x', version: '0.0.0' },
  },
});

/** Config overrides for a suite that wants no presence loop beating under its assertions. */
export const NO_PRESENCE = { presence: { enabled: false } };

export function mcpPost(port: number, body: string = INITIALIZE): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: MCP_HEADERS, body });
}

export interface RemoteApp {
  plugin: FakePlugin;
  app: RemoteHttpServer;
  teardown: () => Promise<void>;
}

export interface ServedApp extends RemoteApp {
  port: number;
}

/** A connected plugin and a built-but-unbound app, for a case that drives `listen` itself. */
export async function remoteHttpApp(
  opts: RemoteHttpOptions = {},
  cfgOverrides: Record<string, unknown> = {},
): Promise<RemoteApp> {
  const plugin = new FakePlugin();
  await plugin.connect({});
  const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'], ...cfgOverrides });
  const app = createRemoteHttpApp(plugin, cfg, opts);
  return {
    plugin,
    app,
    teardown: async (): Promise<void> => {
      await app.close();
      await plugin.disconnect();
    },
  };
}

/** The same app, already bound to an ephemeral loopback port. */
export async function serveRemoteHttp(
  opts: RemoteHttpOptions = {},
  cfgOverrides: Record<string, unknown> = {},
): Promise<ServedApp> {
  const built = await remoteHttpApp(opts, cfgOverrides);
  const srv = await built.app.listen(0);
  return { ...built, port: (srv.address() as AddressInfo).port };
}
