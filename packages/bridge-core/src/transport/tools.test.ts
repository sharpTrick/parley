import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import {
  DEFAULT_PRESENCE_TOPIC,
  encodePresence,
  MAX_RECORD_TOPICS,
  MAX_ROSTER_ENTRIES,
  MAX_TOPIC_LEN,
  type PresenceKind,
} from '../engine/presence.js';
import { FetchAbortedError } from '../engine/blocking-fetch.js';
import { SeenSet } from '../engine/seen-set.js';
import { asBackendMsgId, asCursor, asHandle, asTopic } from '../message.js';
import { NoSuchTopicError, type FetchRecentArgs } from '../seam.js';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import {
  DEFAULT_ROSTER_LIMIT,
  MAX_FETCH_LIMIT,
  PRESENCE_FETCH_LIMIT,
  registerTools,
  toolDepsFor,
} from './tools.js';

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
  blockMaxMs?: number;
  blockPollIntervalMs?: number;
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
    blockMaxMs: opts?.blockMaxMs ?? 60_000,
    blockPollIntervalMs: opts?.blockPollIntervalMs ?? 20,
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

  type Beat = [handle: string, topics: string[], kind: PresenceKind, ago: number, postTopics?: string[]];
  interface Scope {
    topics?: string[];
    postPatterns?: string[];
  }

  /** A harness at a fixed clock, seeded with presence beats `ago` ms before NOW. */
  async function roster(beats: Beat[], scope: Scope = {}) {
    const h = await harness({
      now: () => NOW,
      presenceTtlMs: TTL,
      topics: scope.topics,
      postPatterns: scope.postPatterns,
    });
    for (const [handle, topics, kind, ago, postTopics] of beats) {
      await postBeat(h.plugin, handle, topics, kind, NOW - ago, postTopics ?? []);
    }
    return h;
  }

  async function listed(
    client: Client,
    args: Record<string, unknown>,
  ): Promise<Array<[handle: string, online: boolean]>> {
    const out = parse(await client.callTool({ name: 'parley_list_users', arguments: args })) as RosterResult;
    return out.users.map((u) => [u.handle, u.online]);
  }

  /**
   * The roster is a function of (beats x options), and every option interacts with the sort: each row
   * therefore pins ORDER as well as membership, so the most-recently-seen-first sort is falsifiable
   * rather than riding along. The final three rows are option PAIRS that no case covered — where a
   * regression would land in the gap between two green single-option tests.
   */
  const ROWS: Array<
    [name: string, beats: Beat[], args: Record<string, unknown>, expected: Array<[string, boolean]>, scope?: Scope]
  > = [
    ['an online peer needs no real post', [['claude-a', ['ctx'], 'hello', 1_000]], {}, [['claude-a', true]]],
    [
      'the glob filter selects by handle',
      [['claude-a', ['ctx'], 'heartbeat', 1_000], ['human-x', ['ctx'], 'heartbeat', 1_000]],
      { filter: 'claude-*' },
      [['claude-a', true]],
    ],
    [
      'a beat past the TTL is listed as offline, after the online peers',
      [['stale', ['ctx'], 'heartbeat', TTL + 1], ['fresh', ['ctx'], 'heartbeat', 1_000]],
      {},
      [['fresh', true], ['stale', false]],
    ],
    [
      'online_only drops the offline peer',
      [['stale', ['ctx'], 'heartbeat', TTL + 1], ['fresh', ['ctx'], 'heartbeat', 1_000]],
      { online_only: true },
      [['fresh', true]],
    ],
    [
      'a peer that said goodbye is offline but still reachable',
      [['awake', ['ctx'], 'heartbeat', 1_000], ['napping', ['ctx'], 'goodbye', 5_000]],
      {},
      [['awake', true], ['napping', false]],
    ],
    [
      'since_ms bounds how far back offline peers are included',
      [['recent', ['ctx'], 'goodbye', 10_000], ['ancient', ['ctx'], 'goodbye', 5_000_000]],
      { since_ms: 60_000 },
      [['recent', false]],
    ],
    [
      'limit caps the roster AFTER the most-recently-seen-first sort',
      [
        ['a', ['ctx'], 'heartbeat', 3_000],
        ['b', ['ctx'], 'heartbeat', 1_000],
        ['c', ['ctx'], 'heartbeat', 2_000],
      ],
      { limit: 2 },
      [['b', true], ['c', true]],
    ],
    [
      'a peer advertising only topics I do not subscribe to is excluded',
      [['stranger', ['some-other-ctx'], 'hello', 1_000]],
      {},
      [],
    ],
    [
      'a peer I can reach only through my own post pattern is included',
      [['peer', ['ctx-theirs'], 'hello', 1_000]],
      {},
      [['peer', true]],
      { topics: ['ctx-mine'], postPatterns: ['ctx-.*'] },
    ],
    [
      'a peer whose advertised pattern reaches a topic I subscribe to is included',
      [['peer', ['ctx-theirs'], 'hello', 1_000, ['ctx-.*']]],
      {},
      [['peer', true]],
      { topics: ['ctx-mine'] },
    ],
    [
      'a peer with no shared channel in either direction is excluded',
      [['stranger', ['other'], 'hello', 1_000, ['unrelated-.*']]],
      {},
      [],
      { topics: ['ctx'] },
    ],
    [
      'topic scopes the roster to that topic',
      [['claude-a', ['ctx'], 'hello', 1_000], ['claude-b', ['ctx-reviews'], 'hello', 1_000]],
      { topic: 'ctx' },
      [['claude-a', true]],
    ],
    [
      'a pattern-allowed topic is a valid scope',
      [['claude-a', ['ctx-adhoc'], 'hello', 1_000]],
      { topic: 'ctx-adhoc' },
      [['claude-a', true]],
      { postPatterns: ['ctx-.*'] },
    ],
    [
      'a scope includes peers who can POST there, not only its subscribers',
      [['poster', ['elsewhere'], 'hello', 1_000, ['ctx-.*']], ['subber', ['ctx-adhoc'], 'hello', 1_000]],
      { topic: 'ctx-adhoc' },
      [['poster', true], ['subber', true]], // equal lastSeenMs ⇒ handle-ascending tiebreak
      { postPatterns: ['ctx-.*'] },
    ],
    [
      'online_only x since_ms: the window cannot resurrect an offline peer',
      [
        ['fresh', ['ctx'], 'heartbeat', 1_000],
        ['recently-gone', ['ctx'], 'heartbeat', TTL + 1],
        ['ancient', ['ctx'], 'goodbye', 5_000_000],
      ],
      { online_only: true, since_ms: 5_000_000 },
      [['fresh', true]],
    ],
    [
      'filter x limit: the cap applies to the FILTERED roster',
      [
        ['claude-a', ['ctx'], 'heartbeat', 3_000],
        ['claude-b', ['ctx'], 'heartbeat', 1_000],
        ['human-x', ['ctx'], 'heartbeat', 2_000],
      ],
      { filter: 'claude-*', limit: 1 },
      [['claude-b', true]],
    ],
    [
      'scope x online_only: both narrow, neither overrides the other',
      [
        ['on-scope-live', ['ctx'], 'heartbeat', 1_000],
        ['on-scope-stale', ['ctx'], 'heartbeat', TTL + 1],
        ['off-scope-live', ['ctx-reviews'], 'heartbeat', 500],
      ],
      { topic: 'ctx', online_only: true },
      [['on-scope-live', true]],
    ],
  ];

  it.each(ROWS)('%s', async (_name, beats, args, expected, scope) => {
    const { client } = await roster(beats, scope);
    expect(await listed(client, args)).toEqual(expected);
  });

  it("surfaces a peer's full entry: handle, online, topics, postTopics, lastSeenMs", async () => {
    const { client } = await roster([['claude-a', ['ctx'], 'hello', 1_000, ['ctx-.*']]], { topics: ['ctx'] });
    const out = parse(await client.callTool({ name: 'parley_list_users', arguments: {} })) as RosterResult;
    expect(out).toEqual({
      users: [
        { handle: 'claude-a', online: true, topics: ['ctx'], postTopics: ['ctx-.*'], lastSeenMs: NOW - 1_000 },
      ],
      truncated: false,
    });
  });

  it('flags truncated when the scanned presence history fills the page', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    // Fill the fetch page so older offline peers could be clipped.
    for (let i = 0; i < PRESENCE_FETCH_LIMIT; i++) {
      await postBeat(plugin, 'flood', ['ctx'], 'heartbeat', NOW - 1_000 - i);
    }
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.truncated).toBe(true);
  });

  it('ignores real-topic senders (the presence stream is isolated)', async () => {
    const { client, plugin } = await roster([]);
    await plugin.post(asTopic('ctx'), asHandle('chatty'), 'a real message'); // NOT a presence beat
    expect(await listed(client, {})).toEqual([]);
  });

  it('ignores an un-compilable / over-long peer post-pattern without crashing (untrusted input)', async () => {
    // A hostile beat: a broken regex source plus a huge one. Neither should reach me, and the call
    // must not throw — the peer has no subscribed overlap and no valid pattern that covers 'ctx'.
    const { client } = await roster([['hostile', ['other'], 'hello', 1_000, ['(', 'x'.repeat(10_000)]]], {
      topics: ['ctx'],
    });
    expect(await listed(client, {})).toEqual([]);
  });

  /**
   * A hostile peer plants the maximum 64 catastrophic-backtracking regex sources on the presence
   * topic (a raw backend write, outside the tool allowlist), then the reader calls list_users. On
   * unscreened code the `.test` loop never returns; the WALL-CLOCK bound, not a green suite, is the
   * proof. Both shapes are here because the second slipped the screen the first one motivated:
   * `{40}` has no unbounded outer quantifier, yet V8 unrolls it into 40 sequential `*`-bodies.
   */
  it.each([
    ['an unbounded nested quantifier', '((([a-z-]+)+)+)+[0-9]'],
    ['a BOUNDED exact-count nested quantifier', '([a-z-]*){40}[0-9]'],
  ])('a beat of 64 postTopics carrying %s does not hang list_users', async (_label, evil) => {
    const { client } = await roster(
      [['attacker', ['some-other-ctx'], 'hello', 1_000, Array<string>(64).fill(evil)]],
      { topics: ['ctx'] },
    );
    const t0 = performance.now();
    expect(await listed(client, {})).toEqual([]); // no shared channel ⇒ the pathological peer is excluded
    expect(performance.now() - t0).toBeLessThan(1_000); // unfixed: never returns
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
    // collapse into a healthy `{ users: [], truncated: false }` the agent would trust.
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
 * `block_ms` is the one tool argument whose description used to describe a DIFFERENT behaviour than
 * the handler's: core blocks out the whole budget on any empty window, with or without a `since`
 * (pinned in blocking-fetch.test.ts), while the text told the agent blocking was `since`-relative and
 * that a bare call "returns immediately". An agent that believes the text issues an unqualified
 * `block_ms` for a quick peek and stalls for a minute. Assert the two together: the behaviour of each
 * cell, and that the rendered description does not contradict it.
 */
describe('the fetch_recent description says what the handler does', () => {
  async function fetchRecentTool(client: Client) {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'parley_fetch_recent')!;
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    return { summary: tool.description ?? '', block: props.block_ms?.description ?? '', limit: props.limit?.description ?? '' };
  }

  it('describes blocking as window-driven, not `since`-driven', async () => {
    const { client } = await harness();
    const { summary, block } = await fetchRecentTool(client);
    const text = `${summary} ${block}`;
    expect(text).toContain('whether or not you passed `since`');
    // The claims the handler contradicts. Their absence is the whole point of this case.
    expect(text).not.toContain('nothing is newer than `since`');
    expect(text).not.toContain('with a `since` at the tail');
  });

  it.each([
    ['no since, topic has messages', false, true, 'at once'],
    ['no since, topic is empty', false, false, 'blocks'],
    ['a since at the tail', true, false, 'blocks'],
  ] as Array<[string, boolean, boolean, 'at once' | 'blocks']>)(
    '%s → %s',
    async (_name, withSince, seeded, expectation) => {
      const { client, plugin } = await harness({ blockMaxMs: 120, blockPollIntervalMs: 20 });
      if (seeded) await plugin.post(asTopic('ctx'), asHandle('bob'), 'old');
      const args: Record<string, unknown> = { topic: 'ctx', block_ms: 10_000 };
      if (withSince) args.since = '1';
      const t0 = performance.now();
      await client.callTool({ name: 'parley_fetch_recent', arguments: args });
      const elapsed = performance.now() - t0;
      if (expectation === 'at once') expect(elapsed).toBeLessThan(100);
      else expect(elapsed).toBeGreaterThanOrEqual(100); // held the (clamped) budget
    },
  );
});

/**
 * Tool arguments arrive from a model whose context is untrusted inbound message content, so every
 * numeric one needs a server-side ceiling — `block_ms` had one, `limit` did not, and core walks a
 * result twice (serialisation, then the dedup warm-up that can flush the seen-set). Assert against
 * the cap the DESCRIPTION advertises rather than against the constant, so the two cannot drift apart.
 */
describe('every numeric tool argument is bounded before it reaches the backend', () => {
  const VALUES = [1, 100, 10_000, Number.MAX_SAFE_INTEGER];

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
    const seen: FetchRecentArgs[] = [];
    const orig = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (a: FetchRecentArgs) => {
      seen.push(a);
      return orig(a);
    };
    await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: asked } });
    expect(seen.map((c) => c.limit)).toEqual([expected]);
  });

  it.each(VALUES)('parley_fetch_recent with limit=%d and block_ms=%d', async (value) => {
    const { client, plugin } = await harness({ blockMaxMs: 40, blockPollIntervalMs: 20 });
    const seen: FetchRecentArgs[] = [];
    const orig = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (a: FetchRecentArgs) => {
      seen.push(a);
      return orig(a);
    };
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
    const seen: FetchRecentArgs[] = [];
    const orig = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (a: FetchRecentArgs) => {
      seen.push(a);
      return orig(a);
    };

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

/**
 * The seam's absence sentinel has to mean the same thing at every tool entry point, not only at the
 * one where it was first noticed. Table each agent-facing call site against BOTH rejection kinds:
 * the sentinel degrades to a normal, empty result; a generic failure is surfaced as an error rather
 * than faked into an empty one.
 */
describe('every tool honours NoSuchTopicError identically', () => {
  const sentinel = (): never => {
    throw new NoSuchTopicError('ctx');
  };
  const generic = (): never => {
    throw new Error('backend on fire');
  };

  async function callWith(
    tool: string,
    args: Record<string, unknown>,
    seam: 'fetchRecent' | 'post',
    fail: () => never,
  ): Promise<ToolText> {
    const { client, plugin } = await harness();
    plugin[seam] = async () => fail();
    return (await client.callTool({ name: tool, arguments: args })) as ToolText;
  }

  it.each([
    ['parley_fetch_recent', { topic: 'ctx' }, 'fetchRecent'],
    ['parley_fetch_recent (long-poll)', { topic: 'ctx', since: '0', block_ms: 500 }, 'fetchRecent'],
    ['parley_list_users', {}, 'fetchRecent'],
  ] as const)('%s degrades to an empty result on the sentinel', async (name, args, seam) => {
    const res = await callWith(name.split(' ')[0]!, args, seam, sentinel);
    expect(res.isError).toBeFalsy();
    const out = parse(res) as { messages?: unknown[]; users?: unknown[] };
    expect(out.messages ?? out.users).toEqual([]);
  });

  it.each([
    ['parley_fetch_recent', { topic: 'ctx' }, 'fetchRecent'],
    ['parley_fetch_recent (long-poll)', { topic: 'ctx', since: '0', block_ms: 500 }, 'fetchRecent'],
    ['parley_list_users', {}, 'fetchRecent'],
    ['parley_post', { topic: 'ctx', content: 'x' }, 'post'],
    ['parley_reply', { topic: 'ctx', content: 'x' }, 'post'],
  ] as const)('%s surfaces a generic backend failure as an error', async (name, args, seam) => {
    const res = await callWith(name.split(' ')[0]!, args, seam, generic);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('backend on fire');
  });

  // A write to a topic the backend cannot represent genuinely FAILED — reporting it as an empty
  // success would tell the agent its hand-off landed when nothing was written.
  it.each([
    ['parley_post', { topic: 'ctx', content: 'x' }],
    ['parley_reply', { topic: 'ctx', content: 'x' }],
  ])('%s reports the sentinel as an error — a write that did not happen is not a success', async (name, args) => {
    const res = await callWith(name, args, 'post', sentinel);
    expect(res.isError).toBe(true);
  });

  /**
   * A long-poll the client cancelled before any page landed cannot carry a cursor (core never mints
   * one), so the wrapper raises {@link FetchAbortedError}. That is a cancellation, not a backend
   * failure: the handler must answer it like any other empty window rather than an isError.
   */
  it('a cancelled long-poll is reported as an empty window, not an error', async () => {
    const { client, plugin } = await harness();
    plugin.fetchRecent = async () => {
      throw new FetchAbortedError();
    };
    const res = (await client.callTool({
      name: 'parley_fetch_recent',
      arguments: { topic: 'ctx', block_ms: 500 },
    })) as ToolText;
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ messages: [] });
  });

  it('an absent topic hands back a replayable position, not an invented cursor', async () => {
    const { client, plugin } = await harness();
    plugin.fetchRecent = async () => sentinel();
    const withSince = parse(
      await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', since: 'c-7' },
      }),
    ) as { messages: unknown[]; nextCursor?: string; topicAbsent?: boolean };
    expect(withSince).toEqual({ messages: [], nextCursor: 'c-7', topicAbsent: true });

    const coldStart = parse(
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } }),
    ) as { messages: unknown[]; nextCursor?: string; topicAbsent?: boolean };
    expect(coldStart).toEqual({ messages: [], topicAbsent: true });
  });
});

/**
 * The tool DESCRIPTION is the whole contract an agent reads. It promised `{ messages, nextCursor }`
 * unconditionally while two handler paths return no cursor at all (JSON.stringify drops `undefined`),
 * so an agent doing `since = res.nextCursor` re-issues a since-less read and re-reads the whole recent
 * window — duplicate content in the session, caused by the doc rather than by the code. Core must not
 * mint a cursor here (DESIGN §6), so the shape and the sentence have to be pinned TOGETHER: every cell
 * that omits `nextCursor` also requires the description to say so.
 */
describe('parley_fetch_recent returns the key set its description promises', () => {
  const DISCLOSES_OMISSION = 'nextCursor is omitted';

  const OUTCOMES = {
    'a normal read': (_plugin: FakePlugin) => ({}),
    'an absent topic': (plugin: FakePlugin) => {
      plugin.fetchRecent = async (): Promise<never> => {
        throw new NoSuchTopicError('ctx');
      };
      return { topicAbsent: true };
    },
    'a cancelled long-poll': (plugin: FakePlugin) => {
      plugin.fetchRecent = async (): Promise<never> => {
        throw new FetchAbortedError();
      };
      return { block_ms: 200 };
    },
  } as const;

  const KEYS: Record<keyof typeof OUTCOMES, Record<'with a since' | 'without a since', string[]>> = {
    'a normal read': {
      'with a since': ['messages', 'nextCursor'],
      'without a since': ['messages', 'nextCursor'],
    },
    'an absent topic': {
      'with a since': ['messages', 'nextCursor', 'topicAbsent'],
      'without a since': ['messages', 'topicAbsent'],
    },
    'a cancelled long-poll': {
      'with a since': ['messages', 'nextCursor'],
      'without a since': ['messages'],
    },
  };

  for (const outcome of Object.keys(OUTCOMES) as Array<keyof typeof OUTCOMES>) {
    it.each(['with a since', 'without a since'] as const)(`${outcome}, %s`, async (start) => {
      const { client, plugin } = await harness();
      const extra = OUTCOMES[outcome](plugin) as Record<string, unknown>;
      const args = { topic: 'ctx', ...(start === 'with a since' ? { since: 'c-7' } : {}), ...extra };
      const res = await client.callTool({ name: 'parley_fetch_recent', arguments: args });
      const expected = KEYS[outcome][start];
      expect(Object.keys(parse(res) as object).sort()).toEqual([...expected].sort());

      // The description and the handler cannot drift apart: a cell that omits the cursor is only
      // legitimate while the description warns the agent about it.
      const { tools } = await client.listTools();
      const description = tools.find((t) => t.name === 'parley_fetch_recent')!.description!;
      expect(description).toContain('Returns { messages, nextCursor }');
      if (!expected.includes('nextCursor')) expect(description).toContain(DISCLOSES_OMISSION);
    });
  }
});

/**
 * The roster is rebuilt from ONE fixed page of the presence topic, so occupancy of that page is a
 * shared resource: a peer beating far more often than the rest fills it on its own and every quieter
 * peer disappears from hand-off discovery. The seam cannot page BACKWARD (`fetchRecent` takes a
 * `since`, not a `before`), so core cannot recover them — which makes the tool description the control,
 * and an undisclosed silent gap the actual defect. Pin both halves: the flag the handler raises, and
 * the sentence that tells the agent what a raised flag means.
 */
describe('a noisy presence emitter is disclosed, not silently hidden', () => {
  const PRESENCE_PAGE = 500; // the handler's PRESENCE_FETCH_LIMIT

  it('a flooder that fills the presence page marks the roster truncated', async () => {
    const { client, plugin } = await harness();
    const now = Date.now();
    // A real backend answers with the MOST RECENT window, so model that rather than FakePlugin's
    // oldest-first slice: the quiet peer's single beat is the one that falls off the page.
    await postBeat(plugin, 'quiet-peer', ['ctx'], 'hello', now - 1_000, [], 'quiet-1');
    for (let i = 0; i < PRESENCE_PAGE; i++) {
      await postBeat(plugin, 'flooder', ['ctx'], 'heartbeat', now - 500, [], `flood-${i}`);
    }
    const all = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (args) => {
      const page = await all({ ...args, limit: 10_000 });
      const limit = args.limit ?? page.messages.length;
      const messages = page.messages.slice(-limit);
      return { messages, nextCursor: messages.at(-1)?.cursor ?? page.nextCursor };
    };

    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as { users: Array<{ handle: string }>; truncated: boolean };

    expect(out.truncated).toBe(true); // the only signal the caller gets
    expect(out.users.map((u) => u.handle)).toEqual(['flooder']);
    expect(out.users.map((u) => u.handle)).not.toContain('quiet-peer');

    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'parley_list_users')!.description!;
    expect(description).toContain('truncated=true');
    // Saying "older offline peers may be missing" would understate it: a LIVE peer can be missing too.
    expect(description).toMatch(/beats far more often|hide quieter/);
  });

  /**
   * `limit` is what the handler ASKS for, not what it gets — nonconformant.ts models a longer page as
   * a shape core must survive — and every extra beat is another roster entry going verbatim into the
   * agent's context. Fold at most one page's worth however many the plugin hands back.
   */
  it('an over-delivering presence page still yields a bounded roster', async () => {
    const { client, plugin } = await harness();
    const now = Date.now();
    const OVER = PRESENCE_PAGE * 4;
    plugin.fetchRecent = async () => {
      const messages = Array.from({ length: OVER }, (_unused, i) => ({
        topic: PRESENCE_TOPIC,
        senderHandle: asHandle(`peer-${i}`),
        content: encodePresence({
          v: 2 as const,
          kind: 'heartbeat' as const,
          at: now - 1_000,
          topics: ['ctx'],
          postTopics: [],
          instanceId: `inst-${i}`,
        }),
        timestamp: new Date(i * 1000).toISOString(),
        backendMsgId: asBackendMsgId(String(i)),
        cursor: asCursor(String(i)),
        mentions: [],
      }));
      return { messages, nextCursor: asCursor(String(OVER)) };
    };

    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as { users: unknown[]; truncated: boolean };

    expect(out.users.length).toBeLessThanOrEqual(PRESENCE_PAGE);
    expect(out.users.length).toBeGreaterThan(0); // bounded, not emptied
    expect(out.truncated).toBe(true);
  });
});

/**
 * Every byte of a roster entry is untrusted self-reported text going verbatim into the agent's
 * context, and an entry is bounded but not small — MAX_RECORD_TOPICS topics AND post-patterns, each
 * up to MAX_TOPIC_LEN. So the entry COUNT decides the size of that context, and the handle a beat
 * declares is as cheap to mint as a message: one writer fills the page with distinct peers. An
 * omitted `limit` therefore has to mean a bounded page rather than "however many a stranger
 * advertised". Grade the answer the AGENT receives — its serialized size, its entry count, and
 * whether `truncated` admits the roster was cut — across the limits a caller can ask for.
 */
describe('parley_list_users bounds the roster it hands the agent', () => {
  /** One maximal entry's legal serialization: topics AND postTopics, capped in count and in length. */
  const ENTRY_BYTES = 2 * MAX_RECORD_TOPICS * (MAX_TOPIC_LEN + 8) + 512;
  const filler = (tag: string): string => tag.padEnd(MAX_TOPIC_LEN, 'y');

  /** One credential, PRESENCE_FETCH_LIMIT distinct self-reported peers, each maximally verbose. */
  async function floodDistinctPeers(plugin: FakePlugin): Promise<void> {
    const at = Date.now();
    const topics = ['ctx', ...Array.from({ length: MAX_RECORD_TOPICS - 1 }, (_u, j) => filler(`t-${j}-`))];
    const postTopics = Array.from({ length: MAX_RECORD_TOPICS }, (_u, j) => filler(`p-${j}-`));
    for (let i = 0; i < PRESENCE_FETCH_LIMIT; i++) {
      await plugin.post(
        PRESENCE_TOPIC,
        asHandle('one-credential'),
        encodePresence({
          v: 2,
          kind: 'heartbeat',
          at,
          handle: `peer-${i}`,
          topics,
          postTopics,
          instanceId: `inst-${i}`,
        }),
      );
    }
  }

  it.each([
    ['no limit asked for', undefined, DEFAULT_ROSTER_LIMIT],
    ['a limit below the default', 5, 5],
    ['a limit above the roster cap', 10_000, MAX_ROSTER_ENTRIES],
  ])('%s', async (_name, limit, expectedMax) => {
    const { client, plugin } = await harness({ topics: ['ctx'] });
    await floodDistinctPeers(plugin);
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: limit === undefined ? {} : { limit },
    })) as ToolText;
    const text = res.content[0]!.text;
    const out = JSON.parse(text) as RosterResult;

    expect(out.users.length).toBeGreaterThan(0); // bounded, never emptied
    expect(out.users.length).toBeLessThanOrEqual(expectedMax);
    expect(text.length).toBeLessThan((expectedMax + 1) * ENTRY_BYTES);
    expect(out.truncated).toBe(true);
  });

  it('a limit that cuts a roster the page could hold in full still says truncated', async () => {
    const { client, plugin } = await harness({ topics: ['ctx'] });
    for (const handle of ['claude-a', 'claude-b', 'claude-c']) {
      await postBeat(plugin, handle, ['ctx'], 'heartbeat', Date.now());
    }
    const full = parse(await client.callTool({ name: 'parley_list_users', arguments: {} })) as RosterResult;
    expect(full.users).toHaveLength(3);
    expect(full.truncated).toBe(false); // nothing was cut — the flag is not simply always on

    const cut = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { limit: 2 } }),
    ) as RosterResult;
    expect(cut.users).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });

  it('the description states the default the handler applies', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'parley_list_users')!.description!;
    expect(description).toContain(`default ${DEFAULT_ROSTER_LIMIT}`);
  });
});
