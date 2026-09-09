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
 * The range the backlog a session misses is DRAWN from, per run. Above {@link TOOL_PAGE} by more
 * than one page, so the newest page is not the whole backlog and a reader that answers with it is
 * short by a measurable amount rather than by a rounding error.
 *
 * DRAWN rather than named, for the reason the live floor draws its depth: a read that loses rows
 * only once the reader is far enough behind can read a literal off this package and sit above it.
 * Measured, while this was the literal 12: a plugin that served an honest page until the caller was
 * more than N behind and dropped half of it after that was CERTIFIED 36/36 at N = 12, 13, 20, 50
 * and 200, and caught only at N = 5 — a reach of eleven messages behind, stated here and controlled
 * by the far-edge row of `RESUMED_READ_LOSSES`.
 *
 * {@link TOOL_BACKLOG_MIN} is what every run is guaranteed to reach, so it is also the figure that
 * control sits one below. Exported because a control derived from anything else grades a bound this
 * case does not have.
 */
export const TOOL_BACKLOG_MIN = 12;
const TOOL_BACKLOG_MAX = 16;

/** The page an agent asks for. Small, so the backlog above spans several of them. */
export const TOOL_PAGE = 5;

const between = (low: number, high: number): number =>
  low + Math.floor(Math.random() * (high - low + 1));

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
 * that cursor STOPS ADVANCING. An empty page is not the terminal condition and must not be read as
 * one: core filters a page down to the topic that was asked for AFTER the plugin applied `limit`,
 * so a backend whose history read is coarser than one topic — Matrix in `shared_room`, a NATS
 * wildcard subject — answers a page of foreign rows as `{ messages: [], nextCursor: <advanced> }`.
 * Measured on live Synapse: a loop that stopped there reached 0 of the 3 messages it had missed,
 * and the same run on the same server reached all 3 once only cursor progress ended it.
 *
 * Bounded, so a backend whose cursor never advances fails this case instead of spinning until the
 * harness kills it with a timeout that names no clause.
 */
const catchUpAsAnAgentWould = async (
  fetchRecent: ToolHandler,
  topic: Topic,
  backlog: number,
): Promise<string[]> => {
  const got: string[] = [];
  let since: string | undefined;
  for (let page = 0; page <= backlog; page++) {
    const args: Record<string, unknown> = { topic: String(topic), limit: TOOL_PAGE };
    if (since !== undefined) args.since = since;
    const answer = answerOf(await fetchRecent(args));
    for (const m of answer.messages) got.push(m.content);
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
    const backlog = between(TOOL_BACKLOG_MIN, TOOL_BACKLOG_MAX);
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
    expect(await catchUpAsAnAgentWould(fetchRecent, topic, backlog)).toEqual([before]);

    // …and it is away while more arrives than one page holds.
    const missed = Array.from({ length: backlog }, (_unused, i) => `missed-${i}`);
    for (const content of missed) await ctx.plugin.post(topic, SENDER, content);

    expect(
      await catchUpAsAnAgentWould(fetchRecent, topic, backlog),
      'the agent ran the documented catch-up procedure and did not reach everything it missed. ' +
        'A page short at the OLD end is a session answered with the backend’s newest window ' +
        'rather than resumed from its own position; one short at the NEW end, or one that stops ' +
        'early, is a cursor that does not carry the reader forward. Either way the gap is ' +
        'permanent: the next call asks from further on still',
    ).toEqual(missed);

    // A session that has caught up is not handed the same backlog again on the next start.
    expect(await catchUpAsAnAgentWould(fetchRecent, topic, backlog)).toEqual([]);
  });
}
