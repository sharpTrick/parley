import {
  Allowlist,
  type Cursor,
  registerTools,
  SeenSet,
  type Topic,
  type ToolDeps,
} from '@sharptrick/parley-core';
import { expect, it } from 'vitest';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';

/**
 * How many messages arrive while the session is away. Above `TOOL_PAGE` by more than one page, so
 * the newest page is not the whole backlog and a reader that answers with it is short by a
 * measurable amount rather than by a rounding error.
 */
const TOOL_BACKLOG = 12;

/** The page an agent asks for. Small, so the backlog above spans several of them. */
const TOOL_PAGE = 5;

/** The shape a tool handler answers in — `registerTools` builds it, the MCP SDK serialises it. */
type ToolAnswer = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolAnswer>;

/**
 * The tools a bridge registers, captured by the call `registerTools` makes on its server.
 *
 * Driven through the registered HANDLER rather than through a JSON-RPC round trip, so this package
 * needs no MCP SDK of its own: the handler is the whole of what core contributes to a
 * `parley_fetch_recent`, and the defect this case exists for — a since-less read that answers with
 * the backend's newest page instead of resuming from where the instance read to — lives in it.
 */
const toolsOf = (deps: ToolDeps): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();
  const collector = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler): void => {
      handlers.set(name, handler);
    },
  };
  registerTools(collector as unknown as Parameters<typeof registerTools>[0], deps);
  return handlers;
};

/** A read position held in memory: what a bridge persists per instance, minus the file. */
const position = (): NonNullable<ToolDeps['readState']> => {
  const at = new Map<Topic, Cursor>();
  return {
    get: (topic) => at.get(topic),
    set: (topic, cursor) => {
      at.set(topic, cursor);
    },
  };
};

const answerOf = (a: ToolAnswer): { messages: Array<{ content: string }>; nextCursor?: string } =>
  JSON.parse(a.content[0]!.text) as { messages: Array<{ content: string }>; nextCursor?: string };

/**
 * The catch-up procedure `docs/CONVENTIONS.md` ships into other repos, run verbatim: call
 * `parley_fetch_recent` with no cursor, then keep calling with the `nextCursor` it hands back until
 * a page comes back empty. Bounded, so a backend whose cursor never advances fails this case
 * instead of spinning until the harness kills it with a timeout that names no clause.
 */
const catchUpAsAnAgentWould = async (
  fetchRecent: ToolHandler,
  topic: Topic,
): Promise<string[]> => {
  const got: string[] = [];
  let since: string | undefined;
  for (let page = 0; page <= TOOL_BACKLOG; page++) {
    const args: Record<string, unknown> = { topic: String(topic), limit: TOOL_PAGE };
    if (since !== undefined) args.since = since;
    const answer = answerOf(await fetchRecent(args));
    if (answer.messages.length === 0) return got;
    got.push(...answer.messages.map((m) => m.content));
    if (answer.nextCursor === undefined || answer.nextCursor === since) return got;
    since = answer.nextCursor;
  }
  return got;
};

/**
 * The seam's promise as an AGENT meets it. Every other case here drives `plugin.fetchRecent`
 * directly, which is not what a session calls: core's `parley_fetch_recent` sits in between, and
 * the reconciliation the whole lossy-push contract rests on — "what push leaves out, the next
 * `parley_fetch_recent` returns" — is only true through that tool. Measured before this case
 * existed: a session down while 250 messages arrived reached 100 of them on five certified
 * backends, in its second session and in every session after it, while the suite stayed green
 * because the suite never called the tool.
 */
export function toolSurfaceCases(ctx: ConformanceContext): void {
  it('the fetch_recent tool hands a resuming session everything it missed', async () => {
    const topic = ctx.freshTopic();
    const readState = position();
    const deps: ToolDeps = {
      plugin: ctx.plugin,
      identity: SENDER,
      allow: new Allowlist([String(topic)]),
      seen: new SeenSet(),
      readState,
      blockMaxMs: 60_000,
      blockPollIntervalMs: 20,
    };
    const fetchRecent = toolsOf(deps).get('parley_fetch_recent')!;

    // Session one: the agent reads the topic, and the position that read establishes is the whole
    // of what it takes to come back to the right place.
    const before = 'read-in-session-one';
    await ctx.plugin.post(topic, SENDER, before);
    expect(await catchUpAsAnAgentWould(fetchRecent, topic)).toEqual([before]);

    // …and it is away while more arrives than one page holds.
    const missed = Array.from({ length: TOOL_BACKLOG }, (_unused, i) => `missed-${i}`);
    for (const content of missed) await ctx.plugin.post(topic, SENDER, content);

    expect(
      await catchUpAsAnAgentWould(fetchRecent, topic),
      'the agent ran the documented catch-up procedure and did not reach everything it missed. ' +
        'A page short at the OLD end is a session answered with the backend’s newest window ' +
        'rather than resumed from its own position; one short at the NEW end, or one that stops ' +
        'early, is a cursor that does not carry the reader forward. Either way the gap is ' +
        'permanent: the next call asks from further on still',
    ).toEqual(missed);

    // A session that has caught up is not handed the same backlog again on the next start.
    expect(await catchUpAsAnAgentWould(fetchRecent, topic)).toEqual([]);
  });
}
