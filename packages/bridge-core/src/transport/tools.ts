import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Allowlist } from '../allowlist.js';
import type { SeenSet } from '../engine/seen-set.js';
import { asBackendMsgId, asCursor, type BackendMsgId, type Handle } from '../message.js';
import type { BackendPlugin, FetchRecentArgs } from '../seam.js';

/** Dependencies the reactive/reply tools close over. */
export interface ToolDeps {
  plugin: BackendPlugin;
  /** This instance's handle — the identity all posts are written as. */
  identity: Handle;
  allow: Allowlist;
  seen: SeenSet;
}

/** Alias the SDK's result type so handlers align with the ServerResult union exactly. */
type ToolResult = CallToolResult;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: Record<string, unknown>): Promise<ToolResult>;
}

const textResult = (obj: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});
const errorResult = (msg: string): ToolResult => ({
  content: [{ type: 'text', text: msg }],
  isError: true,
});
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const fetchRecentArgs = z.object({
  topic: z.string(),
  since: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
const postArgs = z.object({
  topic: z.string(),
  content: z.string(),
  in_reply_to: z.string().optional(),
});

/** Shared durable write path for both `parley_post` and (P-4) `parley_reply`. */
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

const fetchRecentTool = (deps: ToolDeps): ToolDef => ({
  name: 'parley_fetch_recent',
  description:
    'Catch up on recent messages in a topic from the durable backend. Pass `since` (an opaque ' +
    'cursor from a previous call) to get only newer messages. Returns { messages, nextCursor }. ' +
    'Call this on session start for each configured topic, then on demand.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic to read (must be on the allowlist).' },
      since: {
        type: 'string',
        description: 'Opaque cursor; return only messages strictly after it. Omit for the recent window.',
      },
      limit: { type: 'number', description: 'Max messages to return.' },
    },
    required: ['topic'],
    additionalProperties: false,
  },
  async handle(raw) {
    const { topic, since, limit } = fetchRecentArgs.parse(raw);
    const t = deps.allow.assert(topic);
    const args: FetchRecentArgs = { topic: t };
    if (since !== undefined) args.since = asCursor(since);
    if (limit !== undefined) args.limit = limit;
    const result = await deps.plugin.fetchRecent(args);
    for (const m of result.messages) deps.seen.markSeen(t, m.backendMsgId);
    return textResult({ messages: result.messages, nextCursor: result.nextCursor });
  },
});

const postTool = (deps: ToolDeps): ToolDef => ({
  name: 'parley_post',
  description:
    'Publish a message into a topic on the durable backend so humans and other instances see it. ' +
    'Use this for handoffs and output. Returns { backendMsgId }.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic to post into (must be on the allowlist).' },
      content: { type: 'string', description: 'Message body.' },
      in_reply_to: { type: 'string', description: 'Optional backendMsgId this message threads under.' },
    },
    required: ['topic', 'content'],
    additionalProperties: false,
  },
  async handle(raw) {
    const { topic, content, in_reply_to } = postArgs.parse(raw);
    const id = await doPost(deps, topic, content, in_reply_to);
    return textResult({ backendMsgId: id });
  },
});

const replyTool = (deps: ToolDeps): ToolDef => ({
  name: 'parley_reply',
  description:
    'Reply into the topic a <channel> message arrived from. Pass the same `topic`. The reply is ' +
    'written durably to the backend so it survives restart and appears in the next catch-up — the ' +
    'live channel is only the fast inbound hop, replies always write to the backend. Returns ' +
    '{ backendMsgId }.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The topic to reply in (the inbound message’s topic).' },
      content: { type: 'string', description: 'The reply body.' },
      in_reply_to: { type: 'string', description: 'Optional msg_id of the message being replied to.' },
    },
    required: ['topic', 'content'],
    additionalProperties: false,
  },
  async handle(raw) {
    const { topic, content, in_reply_to } = postArgs.parse(raw);
    const id = await doPost(deps, topic, content, in_reply_to);
    return textResult({ backendMsgId: id });
  },
});

/**
 * Build the tool set. The reactive subset (`parley_fetch_recent`, `parley_post`) is what the
 * chat instance uses; `parley_reply` (P-4) is the channel reply tool — same durable doPost,
 * distinct name/description so Claude surfaces it as a reply (DESIGN §7).
 */
export function buildToolDefs(deps: ToolDeps): ToolDef[] {
  return [fetchRecentTool(deps), postTool(deps), replyTool(deps)];
}

/**
 * Register the reactive MCP tools on a low-level Server (DESIGN §8/§9 — the standard-MCP
 * reactive role). One ListTools handler + one CallTool dispatcher; every entry point is
 * allowlist-guarded via {@link doPost}/`allow.assert`. Errors are returned as `isError`
 * tool results rather than thrown protocol errors.
 */
export function registerTools(server: Server, deps: ToolDeps): void {
  const tools = buildToolDefs(deps);

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (tool === undefined) return errorResult(`unknown tool: ${req.params.name}`);
    try {
      return await tool.handle(req.params.arguments ?? {});
    } catch (err) {
      return errorResult(errMessage(err));
    }
  });
}
