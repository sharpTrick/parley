import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Allowlist } from '../allowlist.js';
import { computeLive } from '../engine/presence.js';
import type { SeenSet } from '../engine/seen-set.js';
import { filterHandles } from '../identity-filter.js';
import { asBackendMsgId, asCursor, type BackendMsgId, type Handle, type Topic } from '../message.js';
import type { BackendPlugin, FetchRecentArgs } from '../seam.js';

/**
 * How many recent presence messages to scan when building the live roster. At the default 10-min
 * heartbeat / 30-min TTL this covers well over a hundred concurrent instances' TTL windows.
 */
const PRESENCE_FETCH_LIMIT = 500;

/** Dependencies the reactive/reply tools close over. */
export interface ToolDeps {
  plugin: BackendPlugin;
  /** This instance's handle — the identity all posts are written as. */
  identity: Handle;
  allow: Allowlist;
  seen: SeenSet;
  /** The shared presence topic `parley_list_users` reads (`presence.topic`). */
  presenceTopic: Topic;
  /** Liveness window (ms) for `parley_list_users` — a handle is live if its last beat is within it. */
  presenceTtlMs: number;
  /** Clock source; injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Human-readable summary of what topics a tool may target, interpolated into descriptions so an
 * agent discovers the allowlist from the tool list — no extra call. Names/patterns are
 * JSON.stringified to stay quote/backslash-safe.
 */
function describeAllowed(allow: Allowlist): string {
  const topics = allow.topics();
  const topicList = topics.map((t) => JSON.stringify(t)).join(', ');
  let s = topics.length > 0 ? ` Configured topics: ${topicList}.` : '';
  const pats = allow.patterns();
  if (pats.length > 0) {
    s += ` Also allowed (post/fetch only): any topic fully matching regex ${pats
      .map((p) => JSON.stringify(p))
      .join(', ')}.`;
  }
  return s;
}

/** The explicit topics as a JSON-Schema enum — but only when NO post pattern widens the set. */
function topicEnum(allow: Allowlist): string[] | undefined {
  return allow.patterns().length === 0 ? [...allow.topics()] : undefined;
}

/** A `topic` schema property, carrying an enum of allowed topics when the set is closed. */
function topicProperty(allow: Allowlist, description: string): Record<string, unknown> {
  const en = topicEnum(allow);
  return { type: 'string', description, ...(en !== undefined ? { enum: en } : {}) };
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
const listUsersArgs = z.object({
  filter: z.string().optional(),
  topic: z.string().optional(),
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
    'Call this on session start for each configured topic, then on demand.' +
    describeAllowed(deps.allow),
  inputSchema: {
    type: 'object',
    properties: {
      topic: topicProperty(deps.allow, 'Topic to read (must be on the allowlist).'),
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
    'Use this for handoffs and output. Returns { backendMsgId }.' +
    describeAllowed(deps.allow),
  inputSchema: {
    type: 'object',
    properties: {
      topic: topicProperty(deps.allow, 'Topic to post into (must be on the allowlist).'),
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
    `{ backendMsgId }. Subscribed topics: ${deps.allow
      .topics()
      .map((t) => JSON.stringify(t))
      .join(', ')}.`,
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

const listUsersTool = (deps: ToolDeps): ToolDef => ({
  name: 'parley_list_users',
  description:
    'List participants currently LIVE on the bus, optionally filtered by a glob over handles ' +
    '(e.g. "claude-*"). Liveness comes from presence heartbeats, so an idle instance that has ' +
    'not posted is still listed — use this to find who is available for hand-off. Each entry ' +
    'reports the topics that instance subscribes to. Pass `topic` to scope to one topic; omit ' +
    'for all configured topics. A human using a plain chat client appears only once they send a ' +
    `message. Returns { live: [{ handle, topics, lastSeenMs }] }. Configured topics: ${deps.allow
      .topics()
      .map((t) => JSON.stringify(t))
      .join(', ')}.`,
  inputSchema: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'Optional glob over handles, e.g. "claude-*". Omit for all.' },
      topic: {
        type: 'string',
        description:
          'Optional topic to scope to. Omit for all configured topics; the default scope is the ' +
          'configured topics.',
      },
    },
    additionalProperties: false,
  },
  async handle(raw) {
    const { filter, topic } = listUsersArgs.parse(raw);
    const now = deps.now ?? Date.now;
    // A pattern-allowed topic is a valid scope: a peer may advertise a topic we only match, not list.
    const scope = topic !== undefined ? deps.allow.assert(topic) : undefined;

    let messages;
    try {
      const page = await deps.plugin.fetchRecent({
        topic: deps.presenceTopic,
        limit: PRESENCE_FETCH_LIMIT,
      });
      messages = page.messages;
    } catch {
      return textResult({ live: [] }); // presence topic not created yet ⇒ nobody live
    }

    // Default (unscoped) roster = anyone advertising at least one of OUR configured topics.
    const ownTopics = new Set<string>(deps.allow.topics());
    const live = filterHandles(
      computeLive(messages, now(), deps.presenceTtlMs).filter((e) =>
        scope !== undefined ? e.topics.includes(scope) : e.topics.some((t) => ownTopics.has(t)),
      ),
      filter,
    ).sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
    return textResult({ live });
  },
});

/**
 * Build the tool set. The reactive subset (`parley_fetch_recent`, `parley_post`,
 * `parley_list_users`) is what the chat instance uses; `parley_reply` (P-4) is the channel reply
 * tool — same durable doPost, distinct name/description so Claude surfaces it as a reply
 * (DESIGN §7).
 */
export function buildToolDefs(deps: ToolDeps): ToolDef[] {
  return [fetchRecentTool(deps), postTool(deps), replyTool(deps), listUsersTool(deps)];
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
