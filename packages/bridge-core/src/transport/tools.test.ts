import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import type { FetchRecentArgs } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import {
  harness,
  parse,
  postBeat,
  type RosterResult,
  type ToolText,
} from '../testing/tool-cases.js';
import { MAX_FETCH_LIMIT, PRESENCE_FETCH_LIMIT, toolDepsFor } from './tools.js';

/**
 * One subject: the reactive tool surface — which tools are registered, what a call to one does,
 * which topics and argument values it accepts, and what its rendered description advertises. What a
 * tool answers when there is nothing to answer with lives in tool-outcomes.test.ts; the roster tool
 * has its own module and its own suite in list-users-tool.test.ts.
 */

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

  it('parley_fetch_recent block_ms long-polls and returns promptly after a concurrent post', async () => {
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'old' } });
    // Block at the tail; nothing newer than cursor '1' yet, so the call must hold.
    const pending = client.callTool({
      name: 'parley_fetch_recent',
      arguments: { topic: 'ctx', since: '1', block_ms: 3000 },
    });
    // A concurrent writer posts while the fetch is blocked (poll interval is 20ms in the harness).
    await new Promise((r) => setTimeout(r, 40));
    await plugin.post(asTopic('ctx'), asHandle('other'), 'fresh');
    const out = parse(await pending) as { messages: Array<{ content: string }>; nextCursor: string };
    expect(out.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(out.nextCursor).toBe('2');
  });

  it('parley_fetch_recent block_ms returns an empty page at the (clamped) timeout', async () => {
    // block_max_ms clamps the huge request to 40ms — if the clamp were absent this would hang the
    // default test timeout instead of returning empty promptly.
    const { client: c } = await harness({ blockMaxMs: 40, blockPollIntervalMs: 20 });
    await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'old' } });
    const out = parse(
      await c.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', since: '1', block_ms: 10_000_000 },
      }),
    ) as { messages: unknown[]; nextCursor: string };
    expect(out.messages).toEqual([]);
    expect(out.nextCursor).toBe('1'); // stable, replayable
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

  /**
   * A description is shipped to the model in the tool list, so a claim it makes is as load-bearing as
   * the handler — and a claim only prose asserts drifts silently. Pair each one with the behaviour it
   * describes in the SAME case, so neither half can move alone.
   */
  describe('the advertised allowlist matches what the handler accepts', () => {
    it('a pattern advertised as "any topic fully matching" discloses the presence exception', async () => {
      const { client } = await harness({ postPatterns: ['.*'] });
      const { tools } = await client.listTools();
      for (const name of ['parley_post', 'parley_fetch_recent'] as const) {
        const description = tools.find((t) => t.name === name)!.description!;
        expect(description).toContain('any topic fully matching regex ".*"');
        expect(description).toMatch(/reserved presence topic/);
      }
    });

    it('the unscoped roster reaches beyond the configured topics, as its `topic` field now says', async () => {
      const { client, plugin } = await harness({ topics: ['ctx-mine'], postPatterns: ['ctx-.*'] });
      await postBeat(plugin, 'pattern-only-peer', ['ctx-theirs'], 'hello', Date.now());
      const out = parse(
        await client.callTool({ name: 'parley_list_users', arguments: {} }),
      ) as RosterResult;
      // `ctx-theirs` is not a configured topic — only a pattern reaches it — yet the peer is listed.
      expect(out.users.map((u) => u.handle)).toEqual(['pattern-only-peer']);

      const { tools } = await client.listTools();
      const props = tools.find((t) => t.name === 'parley_list_users')!.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
      const topicField = props.topic?.description ?? '';
      expect(topicField).toMatch(/either direction/);
      // The claim the behaviour above contradicts. Its absence is the point of this case.
      expect(topicField).not.toMatch(/default scope is the\s+configured topics/);
    });
  });
});

/**
 * Tool arguments arrive from a model whose context is untrusted inbound message content, so every
 * numeric one needs a server-side ceiling — `block_ms` had one, `limit` did not, and core walks a
 * result twice (serialisation, then the dedup warm-up that can flush the seen-set). Assert against
 * the cap the DESCRIPTION advertises rather than against the constant, so the two cannot drift apart.
 */
describe('every numeric tool argument is bounded before it reaches the backend', () => {
  const VALUES = [1, 100, 10_000, Number.MAX_SAFE_INTEGER];

  /** Record the args every fetchRecent reaches the plugin with, without changing what it returns. */
  function recordFetches(plugin: FakePlugin): FetchRecentArgs[] {
    const seen: FetchRecentArgs[] = [];
    const orig = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (a: FetchRecentArgs) => {
      seen.push(a);
      return orig(a);
    };
    return seen;
  }

  // Both ceilings are shipped defaults no caller can override, and every case around them derives
  // its probe from the constant — so a silent shrink would move the whole table with it. Pin the
  // two by VALUE as well, and grade the fetch cap AT its boundary rather than only above it: a
  // one-sided "<= cap" is satisfied by a handler that clamps everything to 1.
  it('pins the shipped ceilings', () => {
    expect([MAX_FETCH_LIMIT, PRESENCE_FETCH_LIMIT]).toEqual([1_000, 500]);
  });

  it.each([
    ['one under the cap', MAX_FETCH_LIMIT - 1, MAX_FETCH_LIMIT - 1],
    ['at the cap', MAX_FETCH_LIMIT, MAX_FETCH_LIMIT],
    ['one over the cap', MAX_FETCH_LIMIT + 1, MAX_FETCH_LIMIT],
    ['far over the cap', MAX_FETCH_LIMIT * 1_000, MAX_FETCH_LIMIT],
  ])('parley_fetch_recent limit %s reaches the backend as %i', async (_label, asked, expected) => {
    const { client, plugin } = await harness();
    const seen = recordFetches(plugin);
    await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: asked } });
    expect(seen.map((c) => c.limit)).toEqual([expected]);
  });

  it.each(VALUES)('parley_fetch_recent with limit=%d and block_ms=%d', async (value) => {
    const { client, plugin } = await harness({ blockMaxMs: 40, blockPollIntervalMs: 20 });
    const seen = recordFetches(plugin);
    const { tools } = await client.listTools();
    const props = (tools.find((t) => t.name === 'parley_fetch_recent')!.inputSchema.properties ??
      {}) as Record<string, { description?: string }>;
    const advertised = Number(/capped server-side at (\d+)/.exec(props.limit?.description ?? '')![1]);

    await client.callTool({
      name: 'parley_fetch_recent',
      arguments: { topic: 'ctx', limit: value, block_ms: value },
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.limit).toBeLessThanOrEqual(advertised);
      expect(call.limit).toBeLessThanOrEqual(value); // clamped, never inflated
      expect(call.blockMs ?? 0).toBeLessThanOrEqual(40); // the configured block_max_ms
    }
  });

  it.each(VALUES)('parley_list_users with limit=%d and since_ms=%d', async (value) => {
    const { client, plugin } = await harness({ now: () => 1_000_000, presenceTtlMs: 90_000 });
    await postBeat(plugin, 'claude-a', ['ctx'], 'hello', 999_000);
    const seen = recordFetches(plugin);

    const out = parse(
      await client.callTool({
        name: 'parley_list_users',
        arguments: { limit: value, since_ms: value },
      }),
    ) as RosterResult;

    // The roster's cost is fixed by the presence page, whatever the caller asks for.
    for (const call of seen) expect(call.limit).toBe(PRESENCE_FETCH_LIMIT);
    expect(out.users.length).toBeLessThanOrEqual(Math.min(value, PRESENCE_FETCH_LIMIT));
  });
});

describe('toolDepsFor (single ToolDeps factory)', () => {
  it('derives the exact ToolDeps both roots previously assembled by hand; threads seen only via extras', () => {
    const plugin = new FakePlugin();
    const cfg = parseConfig({ identity: { handle: 'alice' }, topics: ['ctx', 'ctx-reviews'] });
    const seen = new SeenSet();

    // stdio root: passes its shared push-loop `seen`.
    const deps = toolDepsFor(plugin, cfg, { seen });
    expect(deps.plugin).toBe(plugin);
    // Matches the fields the stdio bridge used to spell out inline (identity/allow/presenceTopic/ttl).
    expect(deps.identity).toBe(asHandle(cfg.identity.handle));
    expect(deps.allow.topics()).toEqual(['ctx', 'ctx-reviews']);
    expect(deps.presenceTopic).toBe(asTopic(cfg.presence.topic));
    expect(deps.presenceTtlMs).toBe(cfg.presence.ttl_ms);
    expect(deps.blockMaxMs).toBe(cfg.catchup.block_max_ms);
    expect(deps.blockPollIntervalMs).toBe(cfg.catchup.block_poll_interval_ms);
    expect(deps.seen).toBe(seen);

    // reactive HTTP root: omits extras ⇒ no SeenSet is threaded (no push loop, no dedup state).
    expect(toolDepsFor(plugin, cfg).seen).toBeUndefined();
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
