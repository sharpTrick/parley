import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchRecentBlocking, isFetchAbortedError } from '../engine/blocking-fetch.js';
import { asBackendMsgId, asCursor, type BackendMsgId } from '../message.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
import type { FetchRecentArgs } from '../seam.js';
import type { ToolDeps } from './tool-deps.js';
import { describeAllowed, textResult, topicList, topicSchema } from './tool-schema.js';

export * from './tool-deps.js';

/**
 * Server-side ceiling on `parley_fetch_recent`'s `limit`. The value arrives from a model whose
 * context is untrusted inbound message content, and core then walks the whole result twice
 * (serialisation, then the dedup warm-up that can flush the seen-set), so an unbounded page is a
 * denial-of-service knob. Clamped rather than refused, exactly as `block_ms` is.
 */
export const MAX_FETCH_LIMIT = 1_000;

/**
 * The prose core ships to the model, for each tool and for each argument that carries one — the
 * whole of it except the per-deployment allowlist sentence appended at registration.
 *
 * Exported as a VALUE because a backend README that adds sentences of its own about a core-owned
 * tool (`block_ms`, the `since` convention, the absent-topic answer) has to be gradable against
 * what core actually sends. The alternative a plugin's suite reached for was a regex over
 * `bridge-core/src/transport/tools.ts` read by relative path, which reddens that plugin when this
 * file moves and reports the failure against the wrong package.
 */
/**
 * The terminal condition of the catch-up loop, in the words every artifact that teaches the loop
 * ships. `TOOL_TEXT.fetch_recent` interpolates it; `skills/chat-handoff/SKILL.md` and
 * `docs/CONVENTIONS.md` are graded against it by `skill-safety.test.ts`, so a correction here
 * cannot be applied to the tool and left behind in the two documents an agent actually executes.
 *
 * Measured on live Synapse: an agent that stopped on the first EMPTY page reached 0 of the 3
 * messages it had missed, and the same run reached all 3 once only cursor progress ended the loop.
 */
export const CATCH_UP_TERMINAL_CONDITION =
  'keep calling with the `nextCursor` you are handed until it STOPS ADVANCING — the same cursor ' +
  'twice, or none handed back at all. An EMPTY page does not mean you are done: a backend whose ' +
  "history read is coarser than one topic hands back a page of other topics' messages, which " +
  'reaches you as an empty page whose cursor moved on, and stopping there leaves everything ' +
  'behind it unread.';

export const TOOL_TEXT = {
  fetch_recent:
    'Catch up on recent messages in a topic from the durable backend. Pass `since` (an opaque ' +
    'cursor from a previous call) to get only newer messages. Omit `since` and a bridge that keeps ' +
    'a read position for you resumes from it, so a session that was down comes back to the OLDEST ' +
    'message it has not seen; a bridge that keeps none — and a first-ever read of a topic — ' +
    'answers with the most recent page instead. Either way, ' +
    CATCH_UP_TERMINAL_CONDITION +
    ' Pass back only a ' +
    '`nextCursor` a previous page gave you: another cursor is read from, but does not move where ' +
    'this session resumes. Returns { messages, nextCursor } — ' +
    'nextCursor is omitted only when the read had no position to hand back at all: a since-less ' +
    'read of a topic this bridge has never read and the backend does not have. ' +
    'Call this on session start for each configured topic, then on demand. A topic that does not ' +
    'exist on the backend yet returns an empty page with `topicAbsent: true` rather than an error. ' +
    'Pass `block_ms` to long-poll: if the queried window is empty — whether or not you passed ' +
    '`since` — the call holds until a message arrives or the timeout elapses (capped ' +
    'server-side), so a polling agent burns tokens per message, not per tick. A cancelled ' +
    'long-poll answers like any other empty window, echoing back the position it read from. ' +
    'Not every backend can park on a wait: one that cannot REFUSES `block_ms` with an ' +
    'error naming itself, so retry without it and poll on your own cadence. ' +
    'Pass `from: "recent"` when you want what is happening NOW rather than everything you ' +
    'missed — a session away for a month reads the newest page instead of paging a month forward ' +
    'to reach it. It leaves where this session resumes from untouched, so the backlog is still ' +
    'there when you come back for it.',
  fetch_recent_from:
    'Where a read with no `since` STARTS. "position" (the default) resumes from where this ' +
    'instance last read, so nothing you missed is skipped. "recent" asks for the backend\'s newest ' +
    'page instead, and does NOT move where this session resumes from — the backlog stays reachable ' +
    'by a later "position" read. Ignored when you pass `since`, which names its own start.',
  /**
   * Appended to {@link TOOL_TEXT.fetch_recent_from} by a bridge that keeps NO read position — the
   * remote HTTP root, which is stateless by design. `fetch_recent` hedges its since-less clause for
   * exactly this deployment; `fetch_recent_from` states the same claim unconditionally, and without
   * this it advertises a control that half of cannot mean what it says.
   */
  fetch_recent_from_stateless:
    ' THIS bridge keeps no read position, so both values read the backend’s newest page: ' +
    'nothing here resumes from anywhere, and there is no backlog for a "position" read to return to.',
  fetch_recent_since:
    'Opaque cursor; return only messages strictly after it. Omit to resume from where this ' +
    'instance last read, or — if it keeps no read position, or has never read this topic — from ' +
    'the recent window.',
  fetch_recent_block_ms:
    'Long-poll budget in ms. If the queried window is empty — whether or not you passed ' +
    '`since` — hold up to this long for a new message before returning (possibly empty). ' +
    'Clamped server-side. 0 / omit = return the window at once, empty or not. A backend with no ' +
    'read primitive to park on refuses this argument rather than ignoring it.',
  post:
    'Publish a message into a topic on the durable backend so humans and other instances see it. ' +
    'Use this for handoffs and output. Returns { backendMsgId }.',
  reply:
    'Reply into the topic a <channel> message arrived from. Pass the same `topic`. The reply is ' +
    'written durably to the backend so it survives restart and appears in the next catch-up — the ' +
    'live channel is only the fast inbound hop, replies always write to the backend. Returns ' +
    '{ backendMsgId }.',
} as const;

/** Shared durable write path for both `parley_post` and `parley_reply`. */
async function doPost(
  deps: ToolDeps,
  topicStr: string,
  content: string,
  inReplyTo?: string,
): Promise<BackendMsgId> {
  const topic = deps.allow.assert(topicStr);
  return deps.plugin.post(
    topic,
    deps.identity,
    content,
    inReplyTo !== undefined ? { inReplyTo: asBackendMsgId(inReplyTo) } : undefined,
  );
}

/**
 * Register the reactive MCP tools on the high-level {@link McpServer} (DESIGN §8/§9 — the
 * standard-MCP reactive role). Every entry point is allowlist-guarded via {@link doPost} or
 * `allow.assert`. `parley_reply` is the channel reply tool — the same durable {@link doPost} under a
 * distinct name/description so Claude surfaces it as a reply (DESIGN §7).
 *
 * Keep each tool registered directly, so that the SDK keeps inferring its handler args from the Zod
 * `inputSchema` — a table-driven loop erases those types and needs a cast.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { allow } = deps;

  const fetchRecentInput = {
    topic: topicSchema(allow, 'Topic to read (must be on the allowlist).'),
    since: z
      .string()
      .optional()
      .describe(TOOL_TEXT.fetch_recent_since),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max messages to return in this page (capped server-side at ${MAX_FETCH_LIMIT}).`),
    block_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(TOOL_TEXT.fetch_recent_block_ms),
    from: z
      .enum(['position', 'recent'])
      .optional()
      .describe(
        TOOL_TEXT.fetch_recent_from +
          (deps.readState === undefined ? TOOL_TEXT.fetch_recent_from_stateless : ''),
      ),
  };

  server.registerTool(
    'parley_fetch_recent',
    {
      description: TOOL_TEXT.fetch_recent + describeAllowed(allow),
      inputSchema: z.object(fetchRecentInput).strict(),
    },
    async ({ topic, since, limit, block_ms, from }, extra) => {
      const t = deps.allow.assert(topic);
      const args: FetchRecentArgs = { topic: t };
      // A caller with no cursor of its own resumes from the position THIS instance last read to.
      // Without it a since-less read answers with the backend's recent window whatever happened
      // while the session was away, so everything older than that window — however much of it the
      // session had never been handed — is unreachable: the agent's next call asks for the recent
      // window again, and the window has only moved forward.
      //
      // `from: 'recent'` asks for that window ON PURPOSE, so the backlog it skipped stays reachable.
      const readsHead = since === undefined && from === 'recent';
      const resumeFrom = readsHead
        ? undefined
        : since !== undefined
          ? asCursor(since)
          : deps.readState?.get(t);
      if (resumeFrom !== undefined) args.since = resumeFrom;
      if (limit !== undefined) args.limit = Math.min(limit, MAX_FETCH_LIMIT);
      const blockMs = block_ms !== undefined ? Math.min(block_ms, deps.blockMaxMs) : 0;
      let result;
      try {
        result =
          blockMs > 0
            ? await fetchRecentBlocking(deps.plugin, args, {
                blockMs,
                pollIntervalMs: deps.blockPollIntervalMs,
                signal: extra?.signal,
              })
            : await deps.plugin.fetchRecent(args);
      } catch (e) {
        // A long-poll the client cancelled is not a failure: answer it like any other empty window,
        // so that a routine cancellation is never rendered to the agent as a tool error.
        if (isFetchAbortedError(e)) return textResult({ messages: [], nextCursor: args.since });
        if (!isNoSuchTopicError(e)) throw e;
        // Echo the caller's position back: replaying it once the topic exists reads from where
        // they were, and omitting it (no `since` given) reads the recent window.
        return textResult({ messages: [], nextCursor: args.since, topicAbsent: true });
      }
      // Bound the PAGE, not only the request. The seam lets a plugin hand back more than `limit`
      // asked for (test-support/nonconformant.ts ships that shape), and everything past the cap is both
      // agent-facing context and one more write into a per-topic dedup window small enough that a
      // single oversized page flushes it — after which the push loop re-delivers what was just
      // pulled. Re-derive the cursor from the last message KEPT, so that the remainder is paged on
      // the next call rather than skipped forever.
      //
      // Cut the page down to the topic that was ASKED for. `m.topic` is plugin-supplied and a
      // backend's HISTORY read can be coarser than a topic exactly as its subscribe primitive can (a
      // NATS wildcard subject, a Matrix room carrying several logical topics), so this is the same
      // trust boundary `startPushLoop` applies on the live path — without it an unallowed topic
      // reaches the agent's context through the pull path instead, and
      // a foreign `backendMsgId` is recorded against THIS topic's dedup window, suppressing a
      // genuine live push that later collides with it.
      const own = result.messages.filter((m) => m.topic === t);
      if (own.length < result.messages.length) {
        // Count only, once per call: the topics dropped are untrusted strings, and naming them here
        // would put plugin-chosen text into the operator's log on every page.
        console.error(
          `[parley] dropped ${result.messages.length - own.length} fetched message(s) on topics other ` +
            'than the one requested; the backend plugin is reading history beyond that topic',
        );
      }
      const cap = Math.min(limit ?? MAX_FETCH_LIMIT, MAX_FETCH_LIMIT);
      const kept = own.length > cap ? own.slice(0, cap) : own;
      const nextCursor = kept.length < own.length ? kept.at(-1)!.cursor : result.nextCursor;
      // Advance the instance's position to exactly what this page COVERED, so the next since-less
      // call starts where this one stopped — but ONLY when the read really resumed from that
      // position, which is a compare-and-set against a fresh read rather than a check of the value
      // this call opened with. A caller may pass any cursor it likes: one AHEAD of the stored
      // position drags the position past a region the agent was never handed, and everything in
      // between is then unreachable by resume. One BEHIND is safe and still does not move it — a
      // rewind costs duplicates, which the seen-set absorbs. The documented paging loop always
      // satisfies the condition: its first call is since-less, and every later one carries the
      // cursor this branch just wrote.
      //
      // Skipped when the position has not moved, so an idle agent polling a quiet topic does not
      // rewrite the state file once per tick for a cursor that never changed.
      //
      // Keep this BEFORE the dedup warm-up, so that a cursor the store refuses takes the whole call
      // down without first recording these ids as delivered — a page the agent never received but
      // the push loop will now suppress is lost on both paths at once.
      //
      // A head read never satisfies it, whatever the store holds. `resumeFrom` is absent there
      // because the call asked to start from NOWHERE, and on a topic this instance has never read
      // the position is absent too — two absent values are not the same claim, and treating them as
      // agreement drags the position to the head of a backlog the agent was never handed.
      const readState = deps.readState;
      if (readState !== undefined && nextCursor !== undefined && !readsHead) {
        const stored = readState.get(t);
        if (resumeFrom === stored && nextCursor !== stored) readState.set(t, nextCursor);
      }
      for (const m of kept) deps.seen?.markSeen(t, m.backendMsgId);
      return textResult({ messages: kept, nextCursor });
    },
  );

  server.registerTool(
    'parley_post',
    {
      description: TOOL_TEXT.post + describeAllowed(allow),
      inputSchema: z
        .object({
          topic: topicSchema(allow, 'Topic to post into (must be on the allowlist).'),
          content: z.string().describe('Message body.'),
          in_reply_to: z
            .string()
            .optional()
            .describe('Optional backendMsgId this message threads under.'),
        })
        .strict(),
    },
    async ({ topic, content, in_reply_to }) => {
      const id = await doPost(deps, topic, content, in_reply_to);
      return textResult({ backendMsgId: id });
    },
  );

  server.registerTool(
    'parley_reply',
    {
      description: `${TOOL_TEXT.reply} Subscribed topics: ${topicList(allow)}.`,
      inputSchema: z
        .object({
          // No enum: a reply targets whatever topic the inbound <channel> arrived from. Runtime
          // membership is still enforced by `allow.assert` in doPost.
          topic: z.string().describe('The topic to reply in (the inbound message’s topic).'),
          content: z.string().describe('The reply body.'),
          in_reply_to: z
            .string()
            .optional()
            .describe('Optional msg_id of the message being replied to.'),
        })
        .strict(),
    },
    async ({ topic, content, in_reply_to }) => {
      const id = await doPost(deps, topic, content, in_reply_to);
      return textResult({ backendMsgId: id });
    },
  );
}
