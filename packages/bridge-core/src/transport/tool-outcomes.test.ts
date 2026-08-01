import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { FetchAbortedError } from '../engine/blocking-fetch.js';
import { asHandle, asTopic } from '../message.js';
import { NoSuchTopicError } from '../seam.js';
import type { FakePlugin } from '../testing/fake-plugin.js';
import { harness, parse, type ToolText } from '../testing/tool-cases.js';

/**
 * One subject: what a tool answers when it has nothing to answer with. An empty window, a topic
 * that does not exist yet, a long-poll the client hung up on and a backend that genuinely broke all
 * arrive at the handler as "no page" — and they must not look alike to the agent. Every case grades
 * the disposition (hold, degrade, or error), the key set that comes back with it, and the sentence
 * the description promises about that key set.
 */

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
    return { summary: tool.description ?? '', block: props.block_ms?.description ?? '' };
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
