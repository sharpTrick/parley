import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchRecentBlocking, isFetchAbortedError } from '../engine/blocking-fetch.js';
import { asBackendMsgId, asCursor, type BackendMsgId } from '../message.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
import type { FetchRecentArgs } from '../seam.js';
import { registerListUsersTool } from './list-users-tool.js';
import type { ToolDeps } from './tool-deps.js';
import { describeAllowed, textResult, topicList, topicSchema } from './tool-schema.js';

export * from './tool-deps.js';
export { DEFAULT_ROSTER_LIMIT, PRESENCE_FETCH_LIMIT } from './list-users-tool.js';

/**
 * Server-side ceiling on `parley_fetch_recent`'s `limit`. The value arrives from a model whose
 * context is untrusted inbound message content, and core then walks the whole result twice
 * (serialisation, then the dedup warm-up that can flush the seen-set), so an unbounded page is a
 * denial-of-service knob. Clamped rather than refused, exactly as `block_ms` is.
 */
export const MAX_FETCH_LIMIT = 1_000;

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

  server.registerTool(
    'parley_fetch_recent',
    {
      description:
        'Catch up on recent messages in a topic from the durable backend. Pass `since` (an opaque ' +
        'cursor from a previous call) to get only newer messages. Returns { messages, nextCursor } — ' +
        'nextCursor is omitted when you passed no `since` and the read produced no page (the topic ' +
        'does not exist yet, or the long-poll was cancelled); re-issue without `since` in that case. ' +
        'Call this on session start for each configured topic, then on demand. Pass `block_ms` to ' +
        'long-poll: if the queried window is empty — whether or not you passed `since` — the call ' +
        'holds until a message arrives or the timeout elapses (capped server-side), so a polling ' +
        'agent burns tokens per message, not per tick. A topic that does not exist on the backend ' +
        'yet returns an empty page with `topicAbsent: true` rather than an error.' +
        describeAllowed(allow),
      inputSchema: {
        topic: topicSchema(allow, 'Topic to read (must be on the allowlist).'),
        since: z
          .string()
          .optional()
          .describe(
            'Opaque cursor; return only messages strictly after it. Omit for the recent window.',
          ),
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
          .describe(
            'Long-poll budget in ms. If the queried window is empty — whether or not you passed ' +
              '`since` — hold up to this long for a new message before returning (possibly empty). ' +
              'Clamped server-side. 0 / omit = return the window at once, empty or not.',
          ),
      },
    },
    async ({ topic, since, limit, block_ms }, extra) => {
      const t = deps.allow.assert(topic);
      const args: FetchRecentArgs = { topic: t };
      if (since !== undefined) args.since = asCursor(since);
      if (limit !== undefined) args.limit = Math.min(limit, MAX_FETCH_LIMIT);
      const blockMs = block_ms !== undefined ? Math.min(block_ms, deps.blockMaxMs) : 0;
      let result;
      try {
        result =
          blockMs > 0
            ? await fetchRecentBlocking(deps.plugin, args, {
                blockMs,
                pollIntervalMs: deps.blockPollIntervalMs,
                now: deps.now,
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
      for (const m of result.messages) deps.seen?.markSeen(t, m.backendMsgId);
      return textResult({ messages: result.messages, nextCursor: result.nextCursor });
    },
  );

  server.registerTool(
    'parley_post',
    {
      description:
        'Publish a message into a topic on the durable backend so humans and other instances see it. ' +
        'Use this for handoffs and output. Returns { backendMsgId }.' +
        describeAllowed(allow),
      inputSchema: {
        topic: topicSchema(allow, 'Topic to post into (must be on the allowlist).'),
        content: z.string().describe('Message body.'),
        in_reply_to: z
          .string()
          .optional()
          .describe('Optional backendMsgId this message threads under.'),
      },
    },
    async ({ topic, content, in_reply_to }) => {
      const id = await doPost(deps, topic, content, in_reply_to);
      return textResult({ backendMsgId: id });
    },
  );

  server.registerTool(
    'parley_reply',
    {
      description:
        'Reply into the topic a <channel> message arrived from. Pass the same `topic`. The reply is ' +
        'written durably to the backend so it survives restart and appears in the next catch-up — the ' +
        'live channel is only the fast inbound hop, replies always write to the backend. Returns ' +
        `{ backendMsgId }. Subscribed topics: ${topicList(allow)}.`,
      inputSchema: {
        // No enum: a reply targets whatever topic the inbound <channel> arrived from. Runtime
        // membership is still enforced by `allow.assert` in doPost.
        topic: z.string().describe('The topic to reply in (the inbound message’s topic).'),
        content: z.string().describe('The reply body.'),
        in_reply_to: z
          .string()
          .optional()
          .describe('Optional msg_id of the message being replied to.'),
      },
    },
    async ({ topic, content, in_reply_to }) => {
      const id = await doPost(deps, topic, content, in_reply_to);
      return textResult({ backendMsgId: id });
    },
  );

  registerListUsersTool(server, deps);
}
