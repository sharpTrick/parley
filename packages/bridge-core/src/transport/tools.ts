import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allowlistFor, type Allowlist } from '../allowlist.js';
import type { ParleyConfig } from '../config.js';
import { fetchRecentBlocking, isFetchAbortedError } from '../engine/blocking-fetch.js';
import { computeRoster, filterReachable } from '../engine/presence.js';
import type { SeenSet } from '../engine/seen-set.js';
import { filterHandles, MAX_GLOB_LEN } from '../identity-filter.js';
import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  type BackendMsgId,
  type Handle,
  type Topic,
} from '../message.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
import type { BackendPlugin, FetchRecentArgs } from '../seam.js';

/**
 * How many recent presence messages to scan when building the roster. At the default 10-min
 * heartbeat / 30-min TTL this covers well over a hundred concurrent instances' TTL windows. It also
 * bounds the OFFLINE lookback: a `since_ms` reaching further back than this many beats can silently
 * under-report older peers — the handler flags that with `truncated: true` when the page is full.
 */
export const PRESENCE_FETCH_LIMIT = 500;

/**
 * Default offline lookback for `parley_list_users` (24h): how far back a peer can have last been
 * seen and still surface as `online: false`. Bounded in practice by {@link PRESENCE_FETCH_LIMIT}.
 */
const DEFAULT_ROSTER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Server-side ceiling on `parley_fetch_recent`'s `limit`. The value arrives from a model whose
 * context is untrusted inbound message content, and core then walks the whole result twice
 * (serialisation, then the dedup warm-up that can flush the seen-set), so an unbounded page is a
 * denial-of-service knob. Clamped rather than refused, exactly as `block_ms` is.
 */
export const MAX_FETCH_LIMIT = 1_000;

/** Dependencies the reactive/reply tools close over. */
export interface ToolDeps {
  plugin: BackendPlugin;
  /** This instance's handle — the identity all posts are written as. */
  identity: Handle;
  allow: Allowlist;
  /**
   * Push-loop dedup set, shared with the live `fetch_recent` tool. Only the stdio bridge (which owns
   * the push loop) supplies it; the reactive HTTP path has no push loop, so it is optional.
   */
  seen?: SeenSet;
  /** The shared presence topic `parley_list_users` reads (`presence.topic`). */
  presenceTopic: Topic;
  /** Liveness window (ms) for `parley_list_users` — a handle is live if its last beat is within it. */
  presenceTtlMs: number;
  /** Server-side cap (ms) on `parley_fetch_recent`'s `block_ms` long-poll. */
  blockMaxMs: number;
  /** Poll cadence (ms) for core's generic long-poll fallback. */
  blockPollIntervalMs: number;
  /** Clock source; injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * The single place both composition roots (stdio bridge + remote HTTP) derive {@link ToolDeps} from
 * config, so a new tool dependency is a one-file change (this factory + the interface) instead of a
 * lockstep edit across both roots. Imports only core-internal helpers (`asHandle`/`asTopic`,
 * `allowlistFor`), so there is no import cycle.
 *
 * `extras.seen` is supplied ONLY by the stdio bridge, which owns the live push loop and shares its
 * dedup set with the reactive `fetch_recent` tool; the reactive HTTP path has no push loop and omits
 * it (the roster/read tools work without a `SeenSet`).
 */
export function toolDepsFor(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  extras?: { seen?: SeenSet },
): ToolDeps {
  return {
    plugin,
    identity: asHandle(cfg.identity.handle),
    allow: allowlistFor(cfg),
    presenceTopic: asTopic(cfg.presence.topic),
    presenceTtlMs: cfg.presence.ttl_ms,
    blockMaxMs: cfg.catchup.block_max_ms,
    blockPollIntervalMs: cfg.catchup.block_poll_interval_ms,
    seen: extras?.seen,
  };
}

/**
 * The configured (explicit) topics as a JSON.stringified, comma-joined list — the shared fragment
 * interpolated into tool descriptions so an agent discovers the allowlist from the tool list. Names
 * are JSON.stringified to stay quote/backslash-safe.
 */
function topicList(allow: Allowlist): string {
  return allow.topics().map((t) => JSON.stringify(t)).join(', ');
}

/**
 * Human-readable summary of what topics a tool may target, interpolated into descriptions so an
 * agent discovers the allowlist from the tool list — no extra call. Names/patterns are
 * JSON.stringified to stay quote/backslash-safe.
 */
function describeAllowed(allow: Allowlist): string {
  const topics = allow.topics();
  let s = topics.length > 0 ? ` Configured topics: ${topicList(allow)}.` : '';
  const pats = allow.patterns();
  if (pats.length > 0) {
    s += ` Also allowed (post/fetch only): any topic fully matching regex ${pats
      .map((p) => JSON.stringify(p))
      .join(', ')} — except the reserved presence topic, which is refused even when a pattern covers it.`;
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
 * Register the reactive MCP tools on the high-level {@link McpServer} (DESIGN §8/§9 — the
 * standard-MCP reactive role). `registerTool` generates the advertised JSON Schema from each tool's
 * Zod `inputSchema`, validates input, infers the handler's arg types from that schema, and wraps
 * handler/validation failures as `isError` tool results. Every entry point is allowlist-guarded via
 * {@link doPost}/`allow.assert`.
 *
 * The reactive subset (`parley_fetch_recent`, `parley_post`, `parley_list_users`) is what the chat
 * instance uses; `parley_reply` is the channel reply tool — same durable {@link doPost}, distinct
 * name/description so Claude surfaces it as a reply (DESIGN §7). Each tool is registered directly so
 * the SDK infers its handler args from the Zod `inputSchema` — no type-erasing indirection, no cast.
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

  server.registerTool(
    'parley_list_users',
    {
      description:
        'List participants reachable on the bus for hand-off — a REACHABILITY roster, not just who is ' +
        'awake this instant. Includes peers seen recently but currently offline (agents are ephemeral ' +
        'sessions; a post to an offline peer’s topic lands durably and it catches up on next ' +
        'start), each tagged `online: true|false`, most-recently-seen first. Each entry reports the ' +
        'topics that peer subscribes to and the post-only topics it can reach. Pass `topic` to scope ' +
        'to peers on that topic (subscribed to it, or able to post to it); omit for everyone you share ' +
        'a channel with — anyone you can post to, or who can post to a topic you subscribe to. ' +
        '`online_only: true` returns only live peers; `since_ms` bounds how far back offline peers are ' +
        'included (default 24h); `limit` caps the result; `filter` is a glob over handles (e.g. ' +
        '"claude-*"). A human using a plain chat client appears only once they send a message. Returns ' +
        '{ users: [{ handle, online, topics, postTopics, lastSeenMs }], truncated } (truncated=true ' +
        'when the scanned presence history was full, so peers may be missing — a peer that beats far ' +
        'more often than the rest can fill that history on its own and hide quieter ones, so treat a ' +
        'truncated roster as incomplete rather than as the whole bus). Configured ' +
        `topics: ${topicList(allow)}.`,
      inputSchema: {
        filter: z
          .string()
          .max(MAX_GLOB_LEN) // keep this cap, so an unbounded glob never reaches the matcher
          .optional()
          .describe('Optional glob over handles, e.g. "claude-*". Omit for all.'),
        topic: z
          .string()
          .optional()
          .describe(
            'Optional topic to scope the roster to peers on that topic (subscribed to it, or able ' +
              'to post to it). Omit for everyone you share a channel with in either direction — ' +
              'which includes peers on topics you only reach through a post pattern, not just the ' +
              'configured ones.',
          ),
        online_only: z
          .boolean()
          .optional()
          .describe('Only peers online right now (skip offline-but-recently-seen). Default false.'),
        since_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How far back (ms) to include offline peers. Default 24h.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max peers to return (after the most-recently-seen-first sort).'),
      },
    },
    async ({ filter, topic, online_only, since_ms, limit }) => {
      const now = deps.now ?? Date.now;
      // A pattern-allowed topic is a valid scope: a peer may advertise a topic we only match, not list.
      const scope = topic !== undefined ? deps.allow.assert(topic) : undefined;
      const sinceMs = since_ms ?? DEFAULT_ROSTER_WINDOW_MS;

      let page;
      try {
        page = await deps.plugin.fetchRecent({
          topic: deps.presenceTopic,
          limit: PRESENCE_FETCH_LIMIT,
        });
      } catch (e) {
        if (isNoSuchTopicError(e)) {
          return textResult({ users: [], truncated: false }); // presence topic genuinely absent ⇒ nobody seen
        }
        throw e; // real backend failure — surface it, don't fake an empty roster
      }
      // A full page means older presence history was clipped — offline coverage is best-effort.
      const truncated = page.messages.length >= PRESENCE_FETCH_LIMIT;
      // `limit` is a maximum the seam only asks for: a plugin may hand back MORE (nonconformant.ts
      // models it), and every extra beat is another entry in agent-facing output. Fold the freshest.
      const beats =
        page.messages.length > PRESENCE_FETCH_LIMIT
          ? page.messages.slice(-PRESENCE_FETCH_LIMIT)
          : page.messages;

      const roster = computeRoster(beats, now(), {
        ttlMs: deps.presenceTtlMs,
        sinceMs,
      });
      // The pure reachability predicate (engine/presence): scoped ⇒ on that topic; unscoped ⇒ a
      // viable channel in EITHER direction. Untrusted peer patterns are compiled defensively there.
      let users = filterReachable(roster, {
        scope,
        canPostTo: (t) => deps.allow.has(t),
        mySubscribedTopics: deps.allow.topics(),
      });
      if (online_only === true) users = users.filter((e) => e.online);
      // computeRoster already sorts most-recently-seen first; filter/slice preserve that order.
      users = filterHandles(users, filter);
      if (limit !== undefined) users = users.slice(0, limit);
      return textResult({ users, truncated });
    },
  );
}
