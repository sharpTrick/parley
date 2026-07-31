import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeRoster, filterReachable, MAX_ROSTER_ENTRIES } from '../engine/presence.js';
import { filterHandles, MAX_GLOB_LEN } from '../identity-filter.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
import type { ToolDeps } from './tool-deps.js';
import { textResult, topicList } from './tool-schema.js';

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
 * Default cap on the peers `parley_list_users` returns when the caller names none. Every field of an
 * entry is untrusted, self-reported text going verbatim into the agent's context, and an entry is
 * bounded but not small, so the entry COUNT is what decides the size of that context. An omitted
 * `limit` must not mean "however many a stranger chose to advertise"; a caller that wants more asks
 * for more, and `truncated` says when the answer was cut.
 */
export const DEFAULT_ROSTER_LIMIT = 25;

/**
 * Register `parley_list_users`: the hand-off REACHABILITY roster over the shared presence topic
 * (DESIGN §7). Reads that one topic through the seam, folds it with `computeRoster`, and keeps only
 * the peers the caller shares a channel with — untrusted peer patterns are compiled defensively in
 * `engine/presence-reach.ts`, never here.
 */
export function registerListUsersTool(server: McpServer, deps: ToolDeps): void {
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
        `included (default 24h); \`limit\` caps the result (default ${DEFAULT_ROSTER_LIMIT}); \`filter\` ` +
        'is a glob over handles (e.g. ' +
        '"claude-*"). A human using a plain chat client appears only once they send a message. Returns ' +
        '{ users: [{ handle, online, topics, postTopics, lastSeenMs }], truncated } (truncated=true ' +
        'when the answer was cut — the scanned presence history was full, the roster hit its entry ' +
        'cap, or `limit` trimmed it — so peers may be missing; a peer that beats far ' +
        'more often than the rest can fill that history on its own and hide quieter ones, so treat a ' +
        'truncated roster as incomplete rather than as the whole bus). Configured ' +
        `topics: ${topicList(deps.allow)}.`,
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
      // `limit` is a maximum the seam only asks for: a plugin may hand back MORE, and every extra
      // beat is another entry in agent-facing output. Fold the freshest.
      const beats =
        page.messages.length > PRESENCE_FETCH_LIMIT
          ? page.messages.slice(-PRESENCE_FETCH_LIMIT)
          : page.messages;

      const roster = computeRoster(beats, now(), { ttlMs: deps.presenceTtlMs, sinceMs });
      let users = filterReachable(roster, {
        scope,
        canPostTo: (t) => deps.allow.has(t),
        mySubscribedTopics: deps.allow.topics(),
      });
      if (online_only === true) users = users.filter((e) => e.online);
      // computeRoster already sorts most-recently-seen first; filter/slice preserve that order.
      users = filterHandles(users, filter);
      const capped = users.slice(0, limit ?? DEFAULT_ROSTER_LIMIT);
      return textResult({
        users: capped,
        truncated: truncated || roster.length >= MAX_ROSTER_ENTRIES || capped.length < users.length,
      });
    },
  );
}
