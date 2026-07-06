import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as allowlistMod from '../allowlist.js';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { createRemoteHttpApp, type RemoteHttpServer } from './http.js';

let remote: RemoteHttpServer;
let plugin: FakePlugin;
let client: Client;

beforeEach(async () => {
  plugin = new FakePlugin();
  await plugin.connect({});
  const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
  remote = createRemoteHttpApp(plugin, cfg, { insecureNoAuth: true });
  const srv = await remote.listen(0);
  const port = (srv.address() as AddressInfo).port;
  client = new Client({ name: 'chat-stand-in', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

afterEach(async () => {
  await client.close();
  await remote.close();
  await plugin.disconnect();
});

interface ToolText {
  content: Array<{ text: string }>;
}
const parse = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]!.text);

describe('remote HTTP transport (reactive, unauthenticated)', () => {
  it('connects over HTTP and lists the reactive tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
      'parley_list_users',
      'parley_post',
      'parley_reply',
    ]);
  });

  it('post + fetch_recent round-trip over HTTP', async () => {
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'hello over http' } });
    const res = await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
    const out = parse(res) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['hello over http']);
  });

  it('is reactive-only — does NOT advertise the claude/channel capability', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.['claude/channel']).toBeUndefined();
    expect(caps?.tools).toBeDefined();
  });

  it('rejects a topic outside the allowlist (isError, not a crash)', async () => {
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'secret', content: 'x' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    // Closed allowlist → `topic` is a z.enum, so the SDK rejects a disallowed topic at the schema
    // layer (Invalid enum value); with a post pattern it would be allow.assert's "topic not
    // allowed". Either way it is an isError result, not a crash.
    expect(res.content[0]!.text).toMatch(/invalid enum value|topic not allowed/i);
  });
});

// CX-06: the reactive HTTP path builds a fresh MCP server PER POST but must NOT recompile the
// allowlist (nor allocate a dead per-request SeenSet). The allowlist is derived once at app scope
// via toolDepsFor and reused by every per-request reactive server. A grep already confirms `new
// SeenSet` is gone from http.ts; this proves the allowlist compiles exactly once across N POSTs.
describe('reactive HTTP: allowlist compiled once per app, not per POST (CX-06)', () => {
  it('derives the allowlist a single time at app scope regardless of request count', async () => {
    const spy = vi.spyOn(allowlistMod, 'allowlistFor');
    const plugin2 = new FakePlugin();
    await plugin2.connect({});
    // Presence off: keep this focused on the request path (a presence loop reuses deps.allow anyway).
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(plugin2, cfg, { insecureNoAuth: true });
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const c = new Client({ name: 'x', version: '0.0.0' }, { capabilities: {} });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      // Several POSTs, each building a brand-new reactive server + transport …
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'a' } });
      await c.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
      await c.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
      // … yet the allowlist (and its regex compilation) was built exactly once, at app scope.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await c.close();
      await app.close();
      await plugin2.disconnect();
      spy.mockRestore();
    }
  });
});

// SEC-17: createRemoteHttpApp must FAIL CLOSED. Omitting BOTH `protect` and `insecureNoAuth` is not
// "no auth" — it 401s (JSON-RPC -32001). Only the explicit, named `insecureNoAuth: true` opt-in
// restores the open dev/loopback endpoint. Proves the behavior flips both ways.
describe('reactive HTTP: fail closed by default (SEC-17)', () => {
  const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'x', version: '0.0.0' },
    },
  });
  const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  async function appOn(opts?: Parameters<typeof createRemoteHttpApp>[2]) {
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(p, cfg, opts);
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    return { p, app, port, teardown: async () => (await app.close(), await p.disconnect()) };
  }

  it('401s /mcp when neither protect nor insecureNoAuth is set (no-arg ≠ no-auth)', async () => {
    const { port, teardown } = await appOn(); // no auth option → fail CLOSED
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: HEADERS, body: INIT });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32001);
    } finally {
      await teardown();
    }
  });

  it('serves /mcp (200) once insecureNoAuth: true is set explicitly', async () => {
    const { port, teardown } = await appOn({ insecureNoAuth: true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: HEADERS, body: INIT });
      expect(res.status).toBe(200);
    } finally {
      await teardown();
    }
  });
});

// SEC-14: the stateless /mcp 500 path must return the generic `message: 'internal error'` (never
// err.message) to the client, and write the real error to stderr for the operator. Force a
// transport-level throw so the catch fires deterministically.
describe('reactive HTTP: 500 path hides internal detail, logs it (SEC-14)', () => {
  it('returns generic "internal error" and console.errors the real error', async () => {
    const SECRET = 'SECRET /var/lib/parley.db backend driver detail';
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(p, cfg, { insecureNoAuth: true });
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const handleSpy = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
      .mockRejectedValue(new Error(SECRET));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe('internal error'); // generic, not err.message
      expect(JSON.stringify(body)).not.toContain('SECRET'); // no internal detail leaked to client
      // … while the real error reached the operator via stderr.
      const logged = errSpy.mock.calls.some((call) =>
        call.some((arg) => arg instanceof Error && arg.message === SECRET),
      );
      expect(logged).toBe(true);
    } finally {
      handleSpy.mockRestore();
      errSpy.mockRestore();
      await app.close();
      await p.disconnect();
    }
  });
});
