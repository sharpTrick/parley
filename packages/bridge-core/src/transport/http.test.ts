import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  remote = createRemoteHttpApp(plugin, cfg);
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
    expect(res.content[0]!.text).toContain('topic not allowed');
  });
});
