import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { encodePresence, presenceTopicFor, type PresenceKind } from '../engine/presence.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { registerTools } from './tools.js';

interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
const parse = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]!.text);

async function harness(opts?: { now?: () => number; presenceTtlMs?: number }) {
  const plugin = new FakePlugin();
  await plugin.connect({});
  const server = new Server(
    { name: 'parley', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    plugin,
    identity: asHandle('alice'),
    allow: new Allowlist(['ctx', 'ctx-reviews']),
    seen: new SeenSet(),
    presenceTtlMs: opts?.presenceTtlMs ?? 90_000,
    now: opts?.now,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { plugin, client };
}

/** Post a presence beat straight to a topic's isolated presence stream (as the emitter would). */
function postBeat(
  plugin: FakePlugin,
  handle: string,
  realTopic: string,
  kind: PresenceKind,
  at: number,
): Promise<unknown> {
  return plugin.post(
    presenceTopicFor(asTopic(realTopic)),
    asHandle(handle),
    encodePresence({ v: 1, kind, at }),
  );
}

describe('reactive MCP tools (real Server↔Client path)', () => {
  let client: Client;
  let plugin: FakePlugin;
  beforeEach(async () => {
    ({ client, plugin } = await harness());
  });

  it('advertises fetch_recent, post, reply, and list_users', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
      'parley_list_users',
      'parley_post',
      'parley_reply',
    ]);
  });

  it('parley_reply writes durably (same path as post)', async () => {
    await client.callTool({
      name: 'parley_reply',
      arguments: { topic: 'ctx', content: 'ack', in_reply_to: '1' },
    });
    const got = await plugin.fetchRecent({ topic: 'ctx' as never });
    expect(got.messages.at(-1)!.content).toBe('ack');
  });

  it('parley_post writes durably and returns a backendMsgId', async () => {
    const res = await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'ctx', content: 'hello @bob' },
    });
    const out = parse(res) as { backendMsgId: string };
    expect(out.backendMsgId).toBe('1');
    // visible via fetchRecent
    const got = await plugin.fetchRecent({ topic: 'ctx' as never });
    expect(got.messages[0]!.content).toBe('hello @bob');
    expect(got.messages[0]!.mentions).toEqual(['bob']);
  });

  it('parley_fetch_recent returns messages + nextCursor and honors since', async () => {
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'a' } });
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'b' } });
    const first = parse(
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } }),
    ) as { messages: unknown[]; nextCursor: string };
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBe('2');

    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'c' } });
    const since = parse(
      await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', since: '2' },
      }),
    ) as { messages: Array<{ content: string }>; nextCursor: string };
    expect(since.messages.map((m) => m.content)).toEqual(['c']);
    expect(since.nextCursor).toBe('3');
  });

  it('rejects a topic outside the allowlist (isError, not a crash)', async () => {
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'secret', content: 'x' },
    })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('topic not allowed');
  });

  it('reports an unknown tool as an error result', async () => {
    const res = (await client.callTool({ name: 'nope', arguments: {} })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('unknown tool');
  });
});

interface LiveResult {
  live: Array<{ handle: string; topics: string[]; lastSeenMs: number }>;
}

describe('parley_list_users (presence-derived liveness)', () => {
  const NOW = 1_000_000;
  const TTL = 90_000;

  it('lists a live participant from presence beats, with no real post needed', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'claude-a', 'ctx', 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as LiveResult;
    expect(out.live).toEqual([{ handle: 'claude-a', topics: ['ctx'], lastSeenMs: NOW - 1_000 }]);
  });

  it('applies the glob filter over handles', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'claude-a', 'ctx', 'heartbeat', NOW - 1_000);
    await postBeat(plugin, 'human-x', 'ctx', 'heartbeat', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { filter: 'claude-*' } }),
    ) as LiveResult;
    expect(out.live.map((l) => l.handle)).toEqual(['claude-a']);
  });

  it('excludes a handle whose latest beat is older than the TTL', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'stale', 'ctx', 'heartbeat', NOW - TTL - 1);
    await postBeat(plugin, 'fresh', 'ctx', 'heartbeat', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as LiveResult;
    expect(out.live.map((l) => l.handle)).toEqual(['fresh']);
  });

  it('ignores real-topic senders (presence stream is isolated)', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await plugin.post(asTopic('ctx'), asHandle('chatty'), 'a real message'); // NOT a presence beat
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as LiveResult;
    expect(out.live).toEqual([]);
  });

  it('scopes to a single topic when `topic` is given', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'claude-a', 'ctx', 'hello', NOW - 1_000);
    await postBeat(plugin, 'claude-b', 'ctx-reviews', 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { topic: 'ctx' } }),
    ) as LiveResult;
    expect(out.live.map((l) => l.handle)).toEqual(['claude-a']);
  });

  it('rejects a topic outside the allowlist', async () => {
    const { client } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: { topic: 'secret' },
    })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('topic not allowed');
  });
});
