import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BLOCK_MS, parseConfig } from '../config.js';
import { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  type Cursor,
  type Message,
  type Topic,
} from '../message.js';
import { BlockingFetchUnsupportedError } from '../blocking-unsupported.js';
import type { BackendPlugin, FetchRecentArgs } from '../seam.js';
import { FakePlugin } from '../test-support/fake-plugin.js';
import {
  memoryReadState,
  NONCONFORMANT_SHAPES,
  NONCONFORMANT_SHAPE_NAMES,
} from '../test-support/nonconformant.js';
import { harness, parse, type ToolText } from '../test-support/tool-harness.js';
import { MAX_FETCH_LIMIT, TOOL_TEXT, toolDepsFor } from './tools.js';

/**
 * One subject: the reactive tool surface — which tools are registered, what a call to one does,
 * which topics and argument values it accepts, and what its rendered description advertises. What a
 * tool answers when there is nothing to answer with lives in tool-outcomes.test.ts.
 */

describe('reactive MCP tools (real Server↔Client path)', () => {
  let client: Client;
  let plugin: FakePlugin;
  beforeEach(async () => {
    ({ client, plugin } = await harness());
  });

  it('advertises fetch_recent, post, and reply', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
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

describe('post_topics regex patterns', () => {
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

  /**
   * A description is shipped to the model in the tool list, so a claim it makes is as load-bearing as
   * the handler — and a claim only prose asserts drifts silently. Pair each one with the behaviour it
   * describes in the SAME case, so neither half can move alone.
   */
  describe('the advertised allowlist matches what the handler accepts', () => {
    it('a broad pattern is advertised as the "any topic fully matching" set it opens', async () => {
      const { client } = await harness({ postPatterns: ['.*'] });
      const { tools } = await client.listTools();
      for (const name of ['parley_post', 'parley_fetch_recent'] as const) {
        const description = tools.find((t) => t.name === name)!.description!;
        expect(description).toContain('any topic fully matching regex ".*"');
      }
      const res = (await client.callTool({
        name: 'parley_post',
        arguments: { topic: 'anything-at-all', content: 'x' },
      })) as ToolText;
      expect(res.isError).toBeFalsy();
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

  // The ceiling is a shipped default no caller can override, and every case around it derives its
  // probe from the constant — so a silent shrink would move the whole table with it. Pin it by VALUE
  // as well, and grade the cap AT its boundary rather than only above it: a one-sided "<= cap" is
  // satisfied by a handler that clamps everything to 1.
  it('pins the shipped ceiling', () => {
    expect(MAX_FETCH_LIMIT).toBe(1_000);
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

});

/**
 * `limit` bounds what core ASKS a plugin for; it does not bound what comes back. The seam is
 * explicit that a longer page is legal — test-support/nonconformant.ts ships it as a shape core must
 * survive — and the returned page is the number that decides how much untrusted text enters the
 * agent's context and how many ids are written into a per-topic dedup window of SEEN_MAX_PER_TOPIC
 * entries. `parley_fetch_recent` forwarded whatever it was handed, so a 5000-message answer to
 * `limit: 1` both filled the context and flushed
 * the topic's dedup window, after which the push loop re-delivered what had just been pulled.
 *
 * Drive it from the shared shapes rather than from a hand-written over-deliverer, and DERIVE which
 * of them over-deliver instead of naming them, so a shape added there is graded here the day it lands.
 */
describe('a result-returning tool bounds the page it hands back, not only the one it asks for', () => {
  const T = asTopic('ctx');
  const overDelivering = NONCONFORMANT_SHAPE_NAMES.filter(
    (name) => NONCONFORMANT_SHAPES[name]!.serve({ topic: T, limit: 3 }, 0).messages.length > 3,
  );

  it('finds over-delivering shapes to check (guards against a table that grades nothing)', () => {
    expect(overDelivering.length).toBeGreaterThan(1);
  });

  // Pin the tools whose result carries a caller-visible list: a third one joins this table rather
  // than shipping with its page unbounded.
  it('pins the tools that return a list', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    expect(
      tools
        .filter((t) => /Returns \{ messages/.test(t.description ?? ''))
        .map((t) => t.name)
        .sort(),
    ).toEqual(['parley_fetch_recent']);
  });

  it.each(
    overDelivering.flatMap((shape) =>
      [undefined, 1, MAX_FETCH_LIMIT * 2].map((limit) => [shape, limit] as const),
    ),
  )('parley_fetch_recent × %s × limit=%s', async (shape, limit) => {
    const { client, plugin, deps } = await harness();
    const { serve } = NONCONFORMANT_SHAPES[shape]!;
    let call = 0;
    plugin.fetchRecent = (args) => Promise.resolve(serve(args, call++));

    const out = parse(
      await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', ...(limit === undefined ? {} : { limit }) },
      }),
    ) as { messages: Array<{ backendMsgId: string; cursor: string }>; nextCursor?: string };

    const cap = Math.min(limit ?? MAX_FETCH_LIMIT, MAX_FETCH_LIMIT);
    expect(out.messages.length).toBeLessThanOrEqual(cap);
    // The cursor has to name what was DELIVERED, or the truncated remainder is skipped forever.
    const served = serve({ topic: T, limit: cap }, 0).messages;
    if (out.messages.length < served.length) expect(out.nextCursor).toBe(out.messages.at(-1)!.cursor);
    // The dedup window still holds the FIRST id of the page: an oversized warm-up evicts it.
    expect(deps.seen!.has(T, asBackendMsgId(out.messages[0]!.backendMsgId))).toBe(true);

    // …and the position this instance RESUMES from is the same cursor, not the one the plugin
    // handed back over rows core trimmed off the page. Writing the pre-trim cursor leaves the page
    // itself correct and the remainder unreachable for good: nothing the agent can do reaches
    // rows behind a position it never asked to be at.
    expect(
      String(deps.readState!.get(T)),
      'the stored read position covers rows this page did not deliver. The next since-less call ' +
        'opens PAST the remainder core just trimmed, so those messages are unreachable by resume ' +
        'forever — the page is right and the position is a lie',
    ).toBe(out.nextCursor);

    const follow = parse(
      await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', ...(limit === undefined ? {} : { limit }) },
      }),
    ) as { messages: Array<{ backendMsgId: string }> };
    const remainder = serve({ topic: T, since: asCursor(out.nextCursor!), limit: cap }, 1).messages;
    expect(
      follow.messages.map((m) => m.backendMsgId),
      'the since-less call after a trimmed page did not open on the trimmed remainder',
    ).toEqual(remainder.slice(0, cap).map((m) => String(m.backendMsgId)));
  });
});

/**
 * The reconciliation the catch-up-on-start convention promises, at the surface an agent actually
 * calls. `subscribe` is lossy by contract and what it leaves out is "returned by the next
 * `parley_fetch_recent`" — but a since-less call used to answer with the backend's RECENT WINDOW,
 * so a session away while more than a window arrived could never reach the older part of it: the
 * on-start driver paged over the backlog and every call the agent made asked for the newest page of
 * a topic that had moved on. Measured through the documented procedure on five backends, a session
 * down for 250 messages saw 100 and missed 150, in session two and in every session after it.
 */
describe('parley_fetch_recent resumes from where this instance last read', () => {
  const T = asTopic('ctx');
  const bob = asHandle('bob');
  /** Well past what one page carries, so the newest page is not the whole backlog. */
  const MISSED = 12;
  const PAGE = 5;

  /**
   * The procedure CONVENTIONS.md ships: no cursor first, then the one handed back, until that
   * cursor stops advancing. An EMPTY page is not the stop — core filters a page to the requested
   * topic after the plugin applied `limit`, so a coarse history read answers an all-foreign page as
   * empty with its cursor moved on, and a loop that returned there would strand everything behind
   * it.
   */
  const drainAsAnAgentWould = async (client: Client): Promise<string[]> => {
    const got: string[] = [];
    let since: string | undefined;
    for (let page = 0; page <= MISSED; page++) {
      const args: Record<string, unknown> = { topic: 'ctx', limit: PAGE };
      if (since !== undefined) args.since = since;
      const out = parse(await client.callTool({ name: 'parley_fetch_recent', arguments: args })) as {
        messages: Array<{ content: string }>;
        nextCursor?: string;
      };
      got.push(...out.messages.map((m) => m.content));
      if (out.nextCursor === undefined || out.nextCursor === since) return got;
      since = out.nextCursor;
    }
    return got;
  };

  /**
   * The loop an agent runs if it reads "stop when a page comes back empty" — the control the
   * comparison needs. A backlog that stops producing an all-foreign page lets the loop above pass
   * for the wrong reason, and only running both over the same backlog tells those apart.
   */
  const stopOnTheFirstEmptyPage = async (client: Client): Promise<string[]> => {
    const got: string[] = [];
    let since: string | undefined;
    for (let page = 0; page <= MISSED; page++) {
      const args: Record<string, unknown> = { topic: 'ctx', limit: PAGE };
      if (since !== undefined) args.since = since;
      const out = parse(await client.callTool({ name: 'parley_fetch_recent', arguments: args })) as {
        messages: Array<{ content: string }>;
        nextCursor?: string;
      };
      if (out.messages.length === 0) return got;
      got.push(...out.messages.map((m) => m.content));
      if (out.nextCursor === undefined || out.nextCursor === since) return got;
      since = out.nextCursor;
    }
    return got;
  };

  /**
   * One row per CALLER INTENT the tool description names, with the argument spelling that expresses
   * it. A capability whose intent has no spelling fails its row rather than disappearing quietly:
   * "the newest page" was reachable by omitting `since` until a since-less read was redefined to
   * resume from the stored position, and nothing anywhere asked whether the intent still had one.
   *
   * Judged on WHICH END of the backlog comes back, so an intent answered by the wrong one — the
   * commonest way one of these silently becomes an alias of another — fails. Driven through the
   * real client, so a spelling the `.strict()` schema does not accept fails here too.
   */
  const INTENTS: ReadonlyArray<
    readonly [
      intent: string,
      spell: (cursorFromAPreviousPage: string) => Record<string, unknown>,
      holds: (got: string[], missed: string[]) => void,
    ]
  > = [
    ['resume where I left off', () => ({}), (got, missed) => expect(got[0]).toBe(missed[0])],
    [
      'everything since cursor C',
      (cursor) => ({ since: cursor }),
      (got, missed) => expect(got[0]).toBe(missed[0]),
    ],
    ['the newest page', () => ({ from: 'recent' }), (got, missed) => expect(got.at(-1)).toBe(missed.at(-1))],
  ];

  const read = async (client: Client, args: Record<string, unknown>): Promise<string[]> =>
    (
      parse(await client.callTool({ name: 'parley_fetch_recent', arguments: args })) as {
        messages: Array<{ content: string }>;
      }
    ).messages.map((m) => m.content);

  /**
   * A session that read this topic `priorReads` times, then was away while more than one page
   * arrived. `priorReads` is a PARAMETER and `0` is a real value: catch-up-on-start deliberately
   * leaves the read position alone, so a never-read topic is the state every fresh boot produces on
   * every topic, not an edge case. A fixture that always performs an opening read hides every
   * defect that needs the stored position to be ABSENT — which is what this one used to do.
   */
  const awayAfterReading = async (
    opts: { priorReads?: number; populated?: boolean } = {},
  ): Promise<{
    client: Client;
    readState: ReturnType<typeof memoryReadState>;
    cursor: string;
    missed: string[];
  }> => {
    const priorReads = opts.priorReads ?? 1;
    const populated = opts.populated !== false;
    const readState = memoryReadState();
    const { client, plugin } = await harness({ readState });
    let cursor: string | undefined;
    for (let r = 0; r < priorReads; r++) {
      if (populated) await plugin.post(T, bob, `read-in-session-${r}`);
      const opening = parse(
        await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: PAGE } }),
      ) as { nextCursor?: string };
      cursor = opening.nextCursor;
    }
    const missed = populated
      ? Array.from({ length: MISSED }, (_unused, i) => `missed-${i}`)
      : [];
    for (const content of missed) await plugin.post(T, bob, content);
    return { client, readState, cursor: cursor!, missed };
  };

  it.each(
    [1, 2].flatMap((priorReads) =>
      INTENTS.map(([intent, spell, holds]) => [`${intent} (after ${priorReads} read(s))`, priorReads, spell, holds] as const),
    ),
  )('an agent can spell the intent: %s', async (_name, priorReads, spell, holds) => {
    const { client, cursor, missed } = await awayAfterReading({ priorReads });
    holds(await read(client, { topic: 'ctx', limit: PAGE, ...spell(cursor) }), missed);
  });

  /**
   * The newest page is a READ, not a seek: an agent that asks what is happening now must not lose
   * the backlog by asking, since the stored position is the only thing that keeps it reachable.
   *
   * Parameterised over the PRIOR-READ state because the guard that enforces it is a comparison
   * against the stored position, and a comparison whose two operands are both ABSENT collapses into
   * agreement — which is the never-read topic, the state catch-up leaves behind at every boot.
   * Graded on byte-identity of the position across the call, so "it wrote the same value back" and
   * "it wrote a value where there was none" both fail.
   */
  it.each(
    [0, 1, 2].flatMap((priorReads) =>
      ([
        ['a topic with a backlog', true],
        ['an empty topic', false],
      ] as const).flatMap(([population, populated]) =>
        ([
          ['from: recent', { from: 'recent' }],
          ['from: recent with a limit', { from: 'recent', limit: PAGE }],
          ['from: recent while long-polling', { from: 'recent', limit: PAGE, block_ms: 1 }],
        ] as const).map(
          ([spelling, args]) =>
            [`${spelling}, ${priorReads} prior read(s), ${population}`, priorReads, populated, args] as const,
        ),
      ),
    ),
  )('a newest-page read moves nothing: %s', async (_name, priorReads, populated, args) => {
    // The control is the SAME session without the head read, so what an agent may reach is read
    // off the tool rather than restated here — a cold start legitimately reaches only the newest
    // window, and hard-coding that number would make this case agree with whatever core does.
    const control = await awayAfterReading({ priorReads, populated });
    const reachableWithoutTheHeadRead = await drainAsAnAgentWould(control.client);

    const { client, readState } = await awayAfterReading({ priorReads, populated });
    const before = readState.get(T);
    await read(client, { topic: 'ctx', ...args });
    expect(
      readState.get(T),
      'a read of the newest page moved where this session resumes from. On a topic it has never ' +
        'read there is no position to agree with, so the backlog it skipped is now unreachable ' +
        'by resuming — which is every topic at every fresh boot, since catch-up leaves the ' +
        'position alone on purpose',
    ).toBe(before);
    expect(
      await drainAsAnAgentWould(client),
      'a read of the newest page dragged the stored position past the backlog, so everything ' +
        'between the two is now unreachable by resuming',
    ).toEqual(reachableWithoutTheHeadRead);
  });

  it('a session that was down reaches every message it missed, oldest first', async () => {
    const readState = memoryReadState();
    const { client, plugin } = await harness({ readState });
    await plugin.post(T, bob, 'read-in-session-one');
    expect(await drainAsAnAgentWould(client)).toEqual(['read-in-session-one']);

    for (let i = 0; i < MISSED; i++) await plugin.post(T, bob, `missed-${i}`);

    const missed = Array.from({ length: MISSED }, (_unused, i) => `missed-${i}`);
    expect(
      await drainAsAnAgentWould(client),
      'the agent followed the documented procedure and never reached the oldest of what it ' +
        'missed: a since-less read answered with the newest page instead of resuming from this ' +
        "instance's own position, and every page after it only moved further from the gap",
    ).toEqual(missed);
    // …and a session that has caught up is not handed it all a second time.
    expect(await drainAsAnAgentWould(client)).toEqual([]);
  });

  it('a fetch with no read position still answers with the recent window', async () => {
    const { client, plugin, deps } = await harness({ readState: undefined });
    expect(
      deps.readState,
      'this case grades the branch a bridge with NO read-state store takes — the shipped remote ' +
        'HTTP root — and the harness handed it one anyway, so it graded the empty-POSITION branch ' +
        'instead. Naming a dependency `undefined` is how a case asks for it to be absent',
    ).toBeUndefined();
    for (let i = 0; i < MISSED; i++) await plugin.post(T, bob, `m${i}`);
    const out = parse(
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: PAGE } }),
    ) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
  });

  it('advances the position to what the page COVERED, and leaves it alone when it has not moved', async () => {
    const writes: string[] = [];
    const inner = memoryReadState();
    const readState = {
      get: (t: Topic): Cursor | undefined => inner.get(t),
      set: (t: Topic, c: Cursor): void => {
        writes.push(String(c));
        inner.set(t, c);
      },
    };
    const { client, plugin } = await harness({ readState });
    for (let i = 0; i < 3; i++) await plugin.post(T, bob, `m${i}`);

    await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: 2 } });
    expect(readState.get(T)).toBe('3');

    for (let idle = 0; idle < 3; idle++) {
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
    }
    expect(
      writes,
      'a read that covered nothing new rewrote the position anyway — an idle agent polling a quiet ' +
        'topic pays a state-file rewrite per tick for a position that never moved',
    ).toEqual(['3']);

    await plugin.post(T, bob, 'fresh');
    await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
    expect(writes).toEqual(['3', '4']);
  });

  /**
   * A cursor the CALLER supplies is not evidence of anything: `since` is an argument the model
   * fills in, and the model's context is untrusted inbound message content. One AHEAD of the
   * stored position drags that position over a region the agent was never handed — measured at
   * a position of `q-4`, one call carrying `q-19` moved it to `q-24` and the next since-less page
   * opened at `q-25`, so `q-5…q-19` were unreachable by resume for good. One BEHIND is harmless
   * (a rewind costs duplicates, which the seen-set absorbs) and still must not move it, because
   * the position records what the agent has been handed and a re-read hands it nothing new.
   *
   * So the position advances only on a read that really RESUMED from it — which is what the
   * documented paging loop does on every call, and what an arbitrary `since` does not.
   */
  it.each([
    ['ahead of', 19],
    ['behind', 2],
  ])('a since %s the stored position does not move it', async (_where, since) => {
    const readState = memoryReadState();
    const { client, plugin } = await harness({ readState });
    for (let i = 0; i < 25; i++) await plugin.post(T, bob, `q-${i}`);
    readState.set(T, asCursor('5'));

    const jumped = parse(
      await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', since: String(since), limit: PAGE },
      }),
    ) as { messages: Array<{ content: string }> };
    expect(jumped.messages.length).toBeGreaterThan(0);

    expect(
      String(readState.get(T)),
      "a cursor the caller chose moved this instance's read position. Ahead of it that strands " +
        'every message in between — the next since-less read opens past them and nothing ever ' +
        'asks for them again',
    ).toBe('5');

    // …and the resume still opens exactly where the agent left off.
    const resumed = parse(
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', limit: PAGE } }),
    ) as { messages: Array<{ content: string }> };
    expect(resumed.messages.map((m) => m.content)).toEqual(['q-5', 'q-6', 'q-7', 'q-8', 'q-9']);
  });

  /**
   * The documented loop over a backend whose HISTORY read is COARSER than a topic — Matrix in
   * `shared_room`, a NATS wildcard subject, a Slack channel doubling as two. Core filters a page
   * down to the topic that was asked for AFTER the plugin applied `limit`, so a page holding only
   * other topics' rows reaches the agent as `{ messages: [], nextCursor: <advanced> }`.
   *
   * The terminal condition is therefore the CURSOR STANDING STILL, never an empty page. Measured on
   * live Synapse against a room holding one on-topic message, sixty foreign ones and three more
   * on-topic: a loop that returned on the first empty page reached 0 of the 3 it had missed, and
   * the same run against the same server reached all 3 once only cursor progress ended it.
   */
  it('reaches everything behind a page that holds only other topics’ messages', async () => {
    const FOREIGN_RUN = 20;
    const missed = Array.from({ length: 3 }, (_unused, i) => `missed-${i}`);
    const entries: Message[] = [];
    const add = (topic: string, content: string): void => {
      entries.push({
        topic: asTopic(topic),
        senderHandle: bob,
        content,
        timestamp: '1970-01-01T00:00:00.000Z',
        backendMsgId: asBackendMsgId(String(entries.length + 1)),
        cursor: asCursor(String(entries.length + 1)),
        mentions: [],
      });
    };
    add('ctx', 'read-in-session-one');

    const plugin = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
      post: () => Promise.resolve(asBackendMsgId('0')),
      resolveIdentity: (handle: unknown) => Promise.resolve({ handle, backendRef: 'ref' }),
      // A page of `limit` ROWS, whatever topics they sit on — the read is coarse, not the filter.
      fetchRecent: (args: FetchRecentArgs) => {
        const from = args.since === undefined ? entries.length - (args.limit ?? 10) : Number(args.since);
        const page = entries.filter((m) => Number(m.cursor) > Math.max(from, 0)).slice(0, args.limit ?? 10);
        return Promise.resolve({ messages: page, nextCursor: page.at(-1)?.cursor ?? args.since });
      },
    } as unknown as BackendPlugin;

    const readState = memoryReadState();
    const { client } = await harness({ plugin, readState });
    expect(await drainAsAnAgentWould(client)).toEqual(['read-in-session-one']);

    // …and the session is away while the room fills with other topics' traffic, then with its own.
    for (let i = 0; i < FOREIGN_RUN; i++) add('secret-ops', `not-mine-${i}`);
    for (const content of missed) add('ctx', content);

    // The empty-page stop runs FIRST, so the documented loop resumes from exactly where it left the
    // position — the same session, over the same backlog, continuing the same catch-up.
    const stopped = await stopOnTheFirstEmptyPage(client);
    const reached = await drainAsAnAgentWould(client);

    expect(
      [...stopped, ...reached],
      'the documented catch-up loop stopped on a page that held only other topics’ messages. ' +
        'That page is not the end of the topic — its cursor moved on — so everything behind it is ' +
        'unread, and the next call opens further along still',
    ).toEqual(missed);
    expect(
      stopped,
      'the empty-page stop reached something here, so this backlog no longer produces the page ' +
        'that holds only other topics’ rows and the comparison above proves nothing',
    ).toEqual([]);
  });

  it('the documented loop advances it, because every page resumes from where the last stopped', async () => {
    const readState = memoryReadState();
    const { client, plugin } = await harness({ readState });
    for (let i = 0; i < 25; i++) await plugin.post(T, bob, `q-${i}`);
    readState.set(T, asCursor('5'));
    expect(await drainAsAnAgentWould(client)).toEqual(
      Array.from({ length: 20 }, (_unused, i) => `q-${i + 5}`),
    );
    expect(readState.get(T)).toBe('25');
  });

  /**
   * The seam's TYPE is no guarantee: a JS plugin, or a TS one returning a value typed away, can
   * omit `nextCursor` or spell it as something no cursor can be. The position a restart resumes
   * from is the only thing between the agent and a cold re-read, so a page core cannot record has
   * to fail on the page that produced it rather than erase the position — and it must fail BEFORE
   * the dedup warm-up, or the ids of a page the agent never received are suppressed on the push
   * path too.
   */
  it.each([
    // `delete` rather than a `{}` override: `{ ...page, ...{} }` is the IDENTITY, so the row
    // labelled "no nextCursor at all" served a page WITH one. Made an absent nextCursor fatal in
    // production and it stayed green — the identity case wearing the label of the one shape
    // nothing else here covers.
    ['no nextCursor at all', 'kept', (page: Record<string, unknown>) => delete page.nextCursor],
    ['a null nextCursor', 'refused', (page: Record<string, unknown>) => (page.nextCursor = null)],
    ['a numeric nextCursor', 'refused', (page: Record<string, unknown>) => (page.nextCursor = 7)],
    ['an empty-string nextCursor', 'refused', (page: Record<string, unknown>) => (page.nextCursor = '')],
  ])('a page carrying %s is %s without moving the stored position', async (_label, outcome, spoil) => {
    const readState = new ReadStateStore(join(mkdtempSync(join(tmpdir(), 'parley-tools-')), 'rs.json'));
    readState.set(T, asCursor('42'));
    const { client, plugin, deps } = await harness({ readState });
    const kept = await plugin.post(T, bob, 'body');
    const served: Record<string, unknown>[] = [];
    plugin.fetchRecent = async (args) => {
      const page: Record<string, unknown> = {
        ...(await FakePlugin.prototype.fetchRecent.call(plugin, args)),
      };
      spoil(page);
      served.push(page);
      return page as never;
    };

    const res = (await client.callTool({
      name: 'parley_fetch_recent',
      arguments: { topic: 'ctx' },
    })) as ToolText;
    // The page this row actually SERVED, graded outside the plugin so the diagnostic survives: a
    // `{ ...page, ...over }` spread with an empty override is the IDENTITY, and the row labelled
    // "no nextCursor at all" served a page WITH one — the one shape nothing else here covers,
    // wearing the label of the case above it.
    expect(
      served.map((page) => 'nextCursor' in page && page.nextCursor !== undefined),
      'this row did not build the page shape its label names, so it grades the shape another row ' +
        'already covers',
    ).toEqual(served.map(() => outcome === 'refused'));
    expect(served.length).toBeGreaterThan(0);
    expect(res.isError === true).toBe(outcome === 'refused');
    expect(readState.get(T)).toBe('42');
    if (outcome === 'refused') {
      expect(
        deps.seen!.has(T, kept),
        'a page the caller never received was recorded as delivered, so the push loop will drop ' +
          'it too — the read is lost on both paths at once',
      ).toBe(false);
    }
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
    // Matches the fields the stdio bridge used to spell out inline (identity/allow/block bounds).
    expect(deps.identity).toBe(asHandle(cfg.identity.handle));
    expect(deps.allow.topics()).toEqual(['ctx', 'ctx-reviews']);
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
 * The blocking surface is THREE things that must move as one: `block_ms` on the advertised schema,
 * the sentence in the description that tells the model to send it, and something behind it that
 * either long-polls or REFUSES. A deployment showing any two of the three lies to the agent — the
 * worst arrangement being an argument on the schema that the server silently drops, which a caller
 * cannot tell from a long-poll that timed out empty and so answers by burning a turn per tick
 * believing it is parked.
 *
 * `block_ms` is offered UNIFORMLY, on every deployment: there is no declaration to read, so the two
 * arms below are what a backend DOES with the budget, not what it says about itself.
 */
describe('the block_ms surface', () => {
  /** A backend with nowhere to park a budget: the eight shipped ones that refuse. */
  const refusing = (inner: FakePlugin): BackendPlugin => ({
    connect: (c) => inner.connect(c),
    disconnect: () => inner.disconnect(),
    subscribe: (t, h) => inner.subscribe(t, h),
    post: (t, i, c, o) => inner.post(t, i, c, o),
    fetchRecent: (a) =>
      a.blockMs !== undefined && a.blockMs > 0
        ? Promise.reject(new BlockingFetchUnsupportedError('parley-fake'))
        : inner.fetchRecent(a),
    resolveIdentity: (h) => inner.resolveIdentity(h),
  });

  const fetchTool = async (plugin?: BackendPlugin): Promise<{ client: Client; tool: Tool }> => {
    const { client } = await harness(plugin === undefined ? {} : { plugin });
    const { tools } = await client.listTools();
    return { client, tool: tools.find((t) => t.name === 'parley_fetch_recent')! };
  };

  it('offers block_ms on the advertised schema', async () => {
    const { tool } = await fetchTool();
    const props = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(props).toContain('topic');
    expect(props).toContain('block_ms');
  });

  it('tells the model to send it, and that a backend may refuse it', async () => {
    const { tool } = await fetchTool();
    expect(tool.description).toContain(TOOL_TEXT.fetch_recent);
    expect(TOOL_TEXT.fetch_recent).toContain('long-poll');
    expect(TOOL_TEXT.fetch_recent).toContain('REFUSES `block_ms`');
  });

  it('long-polls a block_ms argument on a backend that parks', async () => {
    const inner = new FakePlugin();
    const { client } = await fetchTool(inner);
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'old' } });
    const pending = client.callTool({
      name: 'parley_fetch_recent',
      arguments: { topic: 'ctx', since: '1', block_ms: 3000 },
    });
    await new Promise((r) => setTimeout(r, 40));
    await inner.post(asTopic('ctx'), asHandle('other'), 'fresh');
    const out = parse(await pending) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['fresh']);
  });

  /**
   * The refusal reaches the caller AS a refusal. Nothing between the plugin and the model may turn
   * it into a page: an empty page is what a long-poll that timed out looks like, and the agent then
   * polls on believing the wait happened.
   */
  it("propagates a refusing backend's error rather than answering with a page", async () => {
    const { client } = await fetchTool(refusing(new FakePlugin()));
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'old' } });
    const refused = (await client.callTool({
      name: 'parley_fetch_recent',
      arguments: { topic: 'ctx', since: '1', block_ms: 3000 },
    })) as ToolText;
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('parley-fake');
    expect(refused.content[0]!.text).toContain('block_ms');
    expect(refused.content[0]!.text).not.toContain('"messages"');
  });

  /**
   * CLASS: no ceiling the config admits may silently disable the contract. The clamp is a
   * `Math.min`, so a `block_max_ms` of 0 clamped every caller's budget to zero: no plugin was ever
   * handed one, no backend could refuse one, and this tool answered a 30 s long poll at once with an
   * empty page and no error — the exact outcome the refusal exists to make impossible, reachable
   * from a documented key with no code change. Rows are the ceilings the SCHEMA still admits, tried
   * against it rather than listed, so a bound widened back to zero arrives here as a live row.
   */
  describe('every ceiling the config admits still reaches the plugin as a budget', () => {
    const admits = (blockMaxMs: number): boolean => {
      try {
        parseConfig({ identity: { handle: 'p' }, topics: ['ctx'], catchup: { block_max_ms: blockMaxMs } });
        return true;
      } catch {
        return false;
      }
    };
    const CANDIDATES = [0, 1, 2, 250, 60_000, MAX_BLOCK_MS];
    const admitted = CANDIDATES.filter(admits);

    it('rejects at least one candidate at load, so the rows below are not the whole domain', () => {
      expect(admitted.length).toBeGreaterThan(2);
      expect(CANDIDATES.filter((c) => !admits(c))).not.toEqual([]);
    });

    it.each(admitted)('block_max_ms %i still lets a refusing backend refuse', async (blockMaxMs) => {
      const { client } = await harness({ plugin: refusing(new FakePlugin()), blockMaxMs });
      const answer = (await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx', block_ms: 30_000 },
      })) as ToolText;
      expect(
        answer.isError,
        `with catchup.block_max_ms = ${blockMaxMs} the tool answered a 30s block_ms without the ` +
          'backend ever seeing a budget, so the refusal never happened and the caller is handed a ' +
          'page it cannot tell from a long poll that timed out empty',
      ).toBe(true);
      expect(answer.content[0]!.text).toContain('block_ms');
    });
  });

  // The refusal is for the WAIT, not for the topic: the ordinary catch-up read a refusing backend
  // is left with must still work through the same tool.
  it('still serves a plain fetch_recent on a refusing backend', async () => {
    const { client } = await fetchTool(refusing(new FakePlugin()));
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'old' } });
    const out = parse(
      await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } }),
    ) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['old']);
  });
});

/**
 * Strictness over the REGISTERED SURFACE, not per tool. `.strict()` landed on `parley_fetch_recent`
 * alone, and the two siblings — both of which perform a DURABLE WRITE — went on silently dropping
 * unknown keys: a model emitting `inReplyTo` (the seam's own TS field name) instead of `in_reply_to`
 * got back a successful `{backendMsgId}` for a post that was never threaded, with no signal at all.
 *
 * Driven off `listTools`, so a fourth tool is graded the day it is registered rather than the day
 * someone remembers to add a row.
 */
describe('every registered tool refuses an argument it did not advertise', () => {
  const argumentsFor: Record<string, Record<string, unknown>> = {
    parley_fetch_recent: { topic: 'ctx' },
    parley_post: { topic: 'ctx', content: 'body' },
    parley_reply: { topic: 'ctx', content: 'body' },
  };

  const registered = async (): Promise<Tool[]> => {
    const { client } = await harness();
    return (await client.listTools()).tools;
  };

  it('has an accepted call for every registered tool', async () => {
    const names = (await registered()).map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(argumentsFor).sort());
  });

  it.each(Object.keys(argumentsFor))('%s advertises additionalProperties: false', async (name) => {
    const tool = (await registered()).find((t) => t.name === name)!;
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it.each(Object.keys(argumentsFor))('%s refuses one unadvertised key', async (name) => {
    const { client } = await harness();
    const accepted = (await client.callTool({
      name,
      arguments: argumentsFor[name]!,
    })) as ToolText;
    expect(accepted.isError, `${name} refused the arguments this row calls it with`).toBeFalsy();

    const refused = (await client.callTool({
      name,
      arguments: { ...argumentsFor[name], inReplyTo: 'camelCased' },
    })) as ToolText;
    expect(
      refused.isError,
      `${name} accepted \`inReplyTo\` — an unadvertised key it silently dropped, which on a ` +
        'durable write returns a successful id for a message that was never threaded',
    ).toBe(true);
    expect(refused.content[0]!.text).toContain('inReplyTo');
  });
});
