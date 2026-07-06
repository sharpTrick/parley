import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { DEFAULT_PRESENCE_TOPIC, encodePresence, type PresenceKind } from '../engine/presence.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import { NoSuchTopicError } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { registerTools } from './tools.js';

interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
const parse = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]!.text);

const PRESENCE_TOPIC = asTopic(DEFAULT_PRESENCE_TOPIC);

async function harness(opts?: {
  now?: () => number;
  presenceTtlMs?: number;
  topics?: string[];
  postPatterns?: string[];
}) {
  const plugin = new FakePlugin();
  await plugin.connect({});
  const server = new McpServer(
    { name: 'parley', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    plugin,
    identity: asHandle('alice'),
    allow: new Allowlist(opts?.topics ?? ['ctx', 'ctx-reviews'], {
      postPatterns: opts?.postPatterns,
      reserved: [DEFAULT_PRESENCE_TOPIC],
    }),
    seen: new SeenSet(),
    presenceTopic: PRESENCE_TOPIC,
    presenceTtlMs: opts?.presenceTtlMs ?? 90_000,
    now: opts?.now,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { plugin, client };
}

/** Post a presence beat straight to the shared presence topic (as the emitter would). */
function postBeat(
  plugin: FakePlugin,
  handle: string,
  topics: string[],
  kind: PresenceKind,
  at: number,
  postTopics: string[] = [],
  instanceId = '',
): Promise<unknown> {
  return plugin.post(
    PRESENCE_TOPIC,
    asHandle(handle),
    encodePresence({ v: 2, kind, at, topics, postTopics, instanceId }),
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
    // Closed allowlist → `topic` is a z.enum, so the SDK rejects a disallowed topic at the schema
    // layer (Invalid enum value) before the handler's allow.assert would run. When a post pattern
    // widens the set the schema is a plain string and allow.assert produces "topic not allowed"
    // (see the pattern cases below). Either path is an isError result, never a crash.
    expect(res.content[0]!.text).toMatch(/invalid enum value|topic not allowed/i);
  });

  it('reports an unknown tool as an error result', async () => {
    const res = (await client.callTool({ name: 'nope', arguments: {} })) as ToolText;
    expect(res.isError).toBe(true);
    // McpServer surfaces an unknown tool as an isError result (text "Tool <name> not found"),
    // matching the previous manual dispatcher's behavior of not throwing a protocol error.
    expect(res.content[0]!.text).toContain('not found');
  });
});

interface RosterResult {
  users: Array<{
    handle: string;
    online: boolean;
    topics: string[];
    postTopics: string[];
    lastSeenMs: number;
  }>;
  truncated: boolean;
}

describe('parley_list_users (presence-derived reachability roster)', () => {
  const NOW = 1_000_000;
  const TTL = 90_000;

  it('lists an online participant from presence beats, with no real post needed', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'claude-a', ['ctx'], 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out).toEqual({
      users: [
        { handle: 'claude-a', online: true, topics: ['ctx'], postTopics: [], lastSeenMs: NOW - 1_000 },
      ],
      truncated: false,
    });
  });

  it('applies the glob filter over handles', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'claude-a', ['ctx'], 'heartbeat', NOW - 1_000);
    await postBeat(plugin, 'human-x', ['ctx'], 'heartbeat', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { filter: 'claude-*' } }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['claude-a']);
  });

  it('lists a beyond-TTL handle as offline (reachability), and online_only hides it', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    await postBeat(plugin, 'stale', ['ctx'], 'heartbeat', NOW - TTL - 1); // past TTL ⇒ offline
    await postBeat(plugin, 'fresh', ['ctx'], 'heartbeat', NOW - 1_000); //   within TTL ⇒ online
    const all = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(all.users.map((u) => [u.handle, u.online])).toEqual([
      ['fresh', true],
      ['stale', false],
    ]);
    const onlyLive = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { online_only: true } }),
    ) as RosterResult;
    expect(onlyLive.users.map((u) => u.handle)).toEqual(['fresh']);
  });

  it('includes an offline-but-recently-seen peer, tagged online:false and sorted after online peers', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    await postBeat(plugin, 'awake', ['ctx'], 'heartbeat', NOW - 1_000);
    await postBeat(plugin, 'napping', ['ctx'], 'goodbye', NOW - 5_000); // departed ⇒ offline, still recent
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users.map((u) => [u.handle, u.online])).toEqual([
      ['awake', true],
      ['napping', false],
    ]);
  });

  it('since_ms bounds how far back offline peers are included', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    await postBeat(plugin, 'recent', ['ctx'], 'goodbye', NOW - 10_000);
    await postBeat(plugin, 'ancient', ['ctx'], 'goodbye', NOW - 5_000_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { since_ms: 60_000 } }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['recent']); // 'ancient' is beyond the 60s window
  });

  it('limit caps the roster after the most-recently-seen-first sort', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    await postBeat(plugin, 'a', ['ctx'], 'heartbeat', NOW - 3_000);
    await postBeat(plugin, 'b', ['ctx'], 'heartbeat', NOW - 1_000); // freshest
    await postBeat(plugin, 'c', ['ctx'], 'heartbeat', NOW - 2_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { limit: 2 } }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['b', 'c']); // top-2 most recent
  });

  it('flags truncated when the scanned presence history fills the page', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    // Fill the fetch page (PRESENCE_FETCH_LIMIT = 500) so older offline peers could be clipped.
    for (let i = 0; i < 500; i++) {
      await postBeat(plugin, 'flood', ['ctx'], 'heartbeat', NOW - 1_000 - i);
    }
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.truncated).toBe(true);
  });

  it('ignores real-topic senders (presence stream is isolated)', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await plugin.post(asTopic('ctx'), asHandle('chatty'), 'a real message'); // NOT a presence beat
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users).toEqual([]);
  });

  it('excludes a handle advertising only topics we do not subscribe to', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'stranger', ['some-other-ctx'], 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users).toEqual([]);
  });

  it('includes a peer subscribed to a topic I can POST to via my post pattern (the fresh-onboard case)', async () => {
    // I subscribe only to my own unique topic — no subscribed-topic overlap with anyone — but my
    // post pattern reaches the peer's topic, so it IS a viable hand-off target. (msg-2539 fix.)
    const { client, plugin } = await harness({
      now: () => NOW,
      presenceTtlMs: TTL,
      topics: ['ctx-mine'],
      postPatterns: ['ctx-.*'],
    });
    await postBeat(plugin, 'peer', ['ctx-theirs'], 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['peer']);
  });

  it('includes a peer whose advertised post-pattern can reach a topic I subscribe to (inbound reach)', async () => {
    // I have no post patterns, so I cannot reach the peer's topic; but the peer advertises it can
    // post to ctx-.*, which covers my subscribed topic — a one-way channel INTO me still counts.
    const { client, plugin } = await harness({
      now: () => NOW,
      presenceTtlMs: TTL,
      topics: ['ctx-mine'],
    });
    await postBeat(plugin, 'peer', ['ctx-theirs'], 'hello', NOW - 1_000, ['ctx-.*']);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['peer']);
  });

  it('excludes a peer with no shared channel in either direction', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    // Peer subscribes elsewhere and can only post to unrelated topics — neither can reach the other.
    await postBeat(plugin, 'stranger', ['other'], 'hello', NOW - 1_000, ['unrelated-.*']);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users).toEqual([]);
  });

  it("surfaces a peer's advertised postTopics in its roster entry", async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    await postBeat(plugin, 'claude-a', ['ctx'], 'hello', NOW - 1_000, ['ctx-.*']);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users).toEqual([
      { handle: 'claude-a', online: true, topics: ['ctx'], postTopics: ['ctx-.*'], lastSeenMs: NOW - 1_000 },
    ]);
  });

  it('ignores an un-compilable / over-long peer post-pattern without crashing (untrusted input)', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    // A hostile beat: a broken regex source plus a huge one. Neither should reach me, and the call
    // must not throw — the peer has no subscribed overlap and no valid pattern that covers 'ctx'.
    await postBeat(plugin, 'hostile', ['other'], 'hello', NOW - 1_000, ['(', 'x'.repeat(10_000)]);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.users).toEqual([]);
  });

  it('scopes to a single topic when `topic` is given', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    await postBeat(plugin, 'claude-a', ['ctx'], 'hello', NOW - 1_000);
    await postBeat(plugin, 'claude-b', ['ctx-reviews'], 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { topic: 'ctx' } }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['claude-a']);
  });

  it('scopes by a pattern-allowed topic (a peer may advertise a topic we only match)', async () => {
    const { client, plugin } = await harness({
      now: () => NOW,
      presenceTtlMs: TTL,
      postPatterns: ['ctx-.*'],
    });
    await postBeat(plugin, 'claude-a', ['ctx-adhoc'], 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { topic: 'ctx-adhoc' } }),
    ) as RosterResult;
    expect(out.users.map((u) => u.handle)).toEqual(['claude-a']);
  });

  it('scopes to peers who can POST to the topic, not only its subscribers', async () => {
    const { client, plugin } = await harness({
      now: () => NOW,
      presenceTtlMs: TTL,
      postPatterns: ['ctx-.*'], // makes 'ctx-adhoc' a valid scope for me to query
    });
    // 'poster' does not subscribe to ctx-adhoc but advertises it can post there; 'subber' subscribes.
    await postBeat(plugin, 'poster', ['elsewhere'], 'hello', NOW - 1_000, ['ctx-.*']);
    await postBeat(plugin, 'subber', ['ctx-adhoc'], 'hello', NOW - 1_000);
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { topic: 'ctx-adhoc' } }),
    ) as RosterResult;
    // Same lastSeenMs ⇒ handle-ascending tiebreak.
    expect(out.users.map((u) => u.handle)).toEqual(['poster', 'subber']);
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

  it('surfaces an arbitrary backend failure as an isError result, not a fake-empty roster', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    // A real outage (connection loss, auth expiry, DB error) rejects fetchRecent — it must NOT
    // collapse into a healthy `{ users: [], truncated: false }` the agent would trust (BUG-13).
    plugin.fetchRecent = async () => {
      throw new Error('backend down');
    };
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: {},
    })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('backend down');
  });

  it('maps an explicit NoSuchTopicError to an empty roster (presence topic genuinely absent)', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    // Only NoSuchTopicError means "topic not present yet" ⇒ nobody seen; this is a normal result.
    plugin.fetchRecent = async () => {
      throw new NoSuchTopicError(DEFAULT_PRESENCE_TOPIC);
    };
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: {},
    })) as ToolText;
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ users: [], truncated: false });
  });
});

describe('post_topics regex patterns + presence reservation', () => {
  it('posts to and fetches a pattern-matched topic outside the explicit list', async () => {
    const { client, plugin } = await harness({ postPatterns: ['ctx-.*'] });
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'ctx-adhoc', content: 'hi' },
    })) as ToolText;
    expect(res.isError).toBeFalsy();
    const got = await plugin.fetchRecent({ topic: asTopic('ctx-adhoc') });
    expect(got.messages.at(-1)!.content).toBe('hi');
    // and it is fetchable back through the tool
    const fetched = parse(
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx-adhoc' } }),
    ) as { messages: Array<{ content: string }> };
    expect(fetched.messages.map((m) => m.content)).toEqual(['hi']);
  });

  it('still rejects a topic matching no explicit entry and no pattern', async () => {
    const { client } = await harness({ postPatterns: ['ctx-.*'] });
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'other', content: 'x' },
    })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('topic not allowed');
  });

  it('never lets a broad pattern reach the reserved presence topic', async () => {
    const { client } = await harness({ postPatterns: ['.*'] });
    for (const name of ['parley_post', 'parley_fetch_recent'] as const) {
      const res = (await client.callTool({
        name,
        arguments: name === 'parley_post' ? { topic: DEFAULT_PRESENCE_TOPIC, content: 'x' } : { topic: DEFAULT_PRESENCE_TOPIC },
      })) as ToolText;
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('topic not allowed');
    }
  });
});

describe('dynamic tool descriptions', () => {
  it('interpolates configured topics and emits a topic enum when no patterns are set', async () => {
    const { client } = await harness({ topics: ['ctx', 'ctx-reviews'] });
    const { tools } = await client.listTools();
    const post = tools.find((t) => t.name === 'parley_post')!;
    expect(post.description).toContain('Configured topics: "ctx", "ctx-reviews".');
    const postProps = post.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(postProps.topic!.enum).toEqual(['ctx', 'ctx-reviews']);
  });

  it('drops the enum and mentions the patterns when post_topics is set', async () => {
    const { client } = await harness({ topics: ['ctx'], postPatterns: ['ctx-.*'] });
    const { tools } = await client.listTools();
    const fetch = tools.find((t) => t.name === 'parley_fetch_recent')!;
    expect(fetch.description).toContain('fully matching regex "ctx-.*"');
    const fetchProps = fetch.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(fetchProps.topic!.enum).toBeUndefined();
  });
});
