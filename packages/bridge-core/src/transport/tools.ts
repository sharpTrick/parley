import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

/** The explicit topics as a closed enum list — but only when NO post pattern widens the set. */
function topicEnum(allow: Allowlist): string[] | undefined {
  return allow.patterns().length === 0 ? [...allow.topics()] : undefined;
}

/**
 * A Zod schema for a `topic` field. When the allowlist is closed (no post pattern widens it) the
 * schema is a `z.enum` so the SDK advertises the allowed topics as a JSON-Schema `enum`; when a
 * pattern widens the set — or the closed set is empty — it falls back to `z.string()` (an empty
 * `z.enum([])` is illegal). Runtime membership is still enforced by `allow.assert` in the handler.
 */
function topicSchema(allow: Allowlist, description: string): z.ZodType<string> {
  const en = topicEnum(allow);
  const base =
    en !== undefined && en.length > 0 ? z.enum(en as [string, ...string[]]) : z.string();
  return base.describe(description);
}

/** Alias the SDK's result type so handlers align with the CallTool result exactly. */
type ToolResult = CallToolResult;

/**
 * A tool: its name, description, Zod input shape (the single source of truth — the SDK generates
 * the advertised JSON Schema from it and validates input before the handler runs), and a handler
 * that receives the already-validated, typed args.
 */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  // Args are erased to `never` here so heterogeneous handlers share one array type; each handler
  // is authored with its concrete arg type via {@link defineTool}, and {@link registerTools} casts
  // back to the SDK callback at the single registration site.
  handle: (args: never) => Promise<ToolResult>;
}

/** Bundle a tool's Zod input shape with a handler that receives args typed from that shape. */
function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handle: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
): ToolDef {
  return { name, description, inputSchema, handle };
}

const textResult = (obj: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});

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
 * Build the tool set. The reactive subset (`parley_fetch_recent`, `parley_post`,
 * `parley_list_users`) is what the chat instance uses; `parley_reply` is the channel reply tool —
 * same durable doPost, distinct name/description so Claude surfaces it as a reply (DESIGN §7).
 */
export function buildToolDefs(deps: ToolDeps): ToolDef[] {
  const { allow } = deps;
  return [
    defineTool(
      'parley_fetch_recent',
      'Catch up on recent messages in a topic from the durable backend. Pass `since` (an opaque ' +
        'cursor from a previous call) to get only newer messages. Returns { messages, nextCursor }. ' +
        'Call this on session start for each configured topic, then on demand.' +
        describeAllowed(allow),
      {
        topic: topicSchema(allow, 'Topic to read (must be on the allowlist).'),
        since: z
          .string()
          .optional()
          .describe(
            'Opaque cursor; return only messages strictly after it. Omit for the recent window.',
          ),
        limit: z.number().int().positive().optional().describe('Max messages to return.'),
      },
      async ({ topic, since, limit }) => {
        const t = deps.allow.assert(topic);
        const args: FetchRecentArgs = { topic: t };
        if (since !== undefined) args.since = asCursor(since);
        if (limit !== undefined) args.limit = limit;
        const result = await deps.plugin.fetchRecent(args);
        for (const m of result.messages) deps.seen.markSeen(t, m.backendMsgId);
        return textResult({ messages: result.messages, nextCursor: result.nextCursor });
      },
    ),
    defineTool(
      'parley_post',
      'Publish a message into a topic on the durable backend so humans and other instances see it. ' +
        'Use this for handoffs and output. Returns { backendMsgId }.' +
        describeAllowed(allow),
      {
        topic: topicSchema(allow, 'Topic to post into (must be on the allowlist).'),
        content: z.string().describe('Message body.'),
        in_reply_to: z
          .string()
          .optional()
          .describe('Optional backendMsgId this message threads under.'),
      },
      async ({ topic, content, in_reply_to }) => {
        const id = await doPost(deps, topic, content, in_reply_to);
        return textResult({ backendMsgId: id });
      },
    ),
    defineTool(
      'parley_reply',
      'Reply into the topic a <channel> message arrived from. Pass the same `topic`. The reply is ' +
        'written durably to the backend so it survives restart and appears in the next catch-up — the ' +
        'live channel is only the fast inbound hop, replies always write to the backend. Returns ' +
        `{ backendMsgId }. Subscribed topics: ${allow
          .topics()
          .map((t) => JSON.stringify(t))
          .join(', ')}.`,
      {
        // No enum: a reply targets whatever topic the inbound <channel> arrived from. Runtime
        // membership is still enforced by `allow.assert` in doPost.
        topic: z.string().describe('The topic to reply in (the inbound message’s topic).'),
        content: z.string().describe('The reply body.'),
        in_reply_to: z
          .string()
          .optional()
          .describe('Optional msg_id of the message being replied to.'),
      },
      async ({ topic, content, in_reply_to }) => {
        const id = await doPost(deps, topic, content, in_reply_to);
        return textResult({ backendMsgId: id });
      },
    ),
    defineTool(
      'parley_list_users',
      'List participants currently LIVE on the bus, optionally filtered by a glob over handles ' +
        '(e.g. "claude-*"). Liveness comes from presence heartbeats, so an idle instance that has ' +
        'not posted is still listed — use this to find who is available for hand-off. Each entry ' +
        'reports the topics that instance subscribes to. Pass `topic` to scope to one topic; omit ' +
        'for all configured topics. A human using a plain chat client appears only once they send a ' +
        `message. Returns { live: [{ handle, topics, lastSeenMs }] }. Configured topics: ${allow
          .topics()
          .map((t) => JSON.stringify(t))
          .join(', ')}.`,
      {
        filter: z
          .string()
          .optional()
          .describe('Optional glob over handles, e.g. "claude-*". Omit for all.'),
        topic: z
          .string()
          .optional()
          .describe(
            'Optional topic to scope to. Omit for all configured topics; the default scope is the ' +
              'configured topics.',
          ),
      },
      async ({ filter, topic }) => {
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
    ),
  ];
}

/**
 * Register the reactive MCP tools on the high-level {@link McpServer} (DESIGN §8/§9 — the
 * standard-MCP reactive role). `registerTool` generates the advertised JSON Schema from each tool's
 * Zod shape, validates input, and wraps handler/validation failures as `isError` tool results.
 * Every entry point is allowlist-guarded via {@link doPost}/`allow.assert`.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  for (const t of buildToolDefs(deps)) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      // The handler's args are re-derived from `inputSchema` by registerTool; bridge the erased
      // array type back to the SDK callback here (single cast for the whole set).
      t.handle as unknown as ToolCallback<z.ZodRawShape>,
    );
  }
}
