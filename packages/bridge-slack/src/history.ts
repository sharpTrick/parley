import type { FetchRecentArgs, FetchRecentResult, Topic } from '@sharptrick/parley-core';
import {
  ABSENT_ON_READ,
  asSeamError,
  HISTORY_PAGE_LIMIT,
  type HistoryResponse,
  MAX_HISTORY_PAGES,
  type SlackApiCall,
  SlackShapeError,
} from './api.js';
import type { SocketHost } from './link.js';
import { slackToMessage } from './markup.js';
import {
  compareTs,
  emptyCursor,
  hasUsableTs,
  isPlainMessage,
  type SlackMessage,
} from './messages.js';

/** {@link SocketHost}, plus what only a read needs: the topic mapping and the connected guard. */
export interface HistoryHost extends SocketHost {
  channelFor: (topic: Topic) => string;
  requireConnected: () => void;
}

/**
 * `conversations.history` with `oldest` = `since`, exclusive (`inclusive` is NEVER set). The
 * aggregate request cost of draining a backlog this way, and the `catchup.limit` that reduces it,
 * are documented in the package README.
 */
export class SlackHistory {
  constructor(
    private readonly api: SlackApiCall,
    private readonly host: HistoryHost,
  ) {}

  async runFetch(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.host.requireConnected();
    const channel = this.host.channelFor(args.topic);
    // The seam declares `limit?: number` with no floor, and this is the only layer that can keep
    // one: `slice(-0)` is `slice(0)`, so an unfloored 0 returns the WHOLE page a caller asked for
    // none of.
    const asked = Math.trunc(args.limit ?? 100);
    const limit = Number.isNaN(asked) ? 1 : Math.max(1, asked);
    const resumeAfterSince = args.since !== undefined;

    // `since` is the seam's EXCLUSIVE floor, and `conversations.history {oldest}` is the only thing
    // holding it: hosted SaaS, unprobeable, and the one contract in this walk taken on trust while
    // every sibling is checked. Re-cut the window HERE with the plugin's own comparator, so that a
    // server counting the boundary entry as inside it, or ignoring the parameter outright, cannot
    // reach the trim and the slice below — both DISCARD on POSITION, so the page would come back as
    // the OLDEST entries in the channel and `nextCursor` would come to rest at or below the cursor
    // the caller handed in, which no later catch-up can move.
    const aboveSince = (m: SlackMessage): boolean =>
      args.since === undefined || compareTs(m.ts, args.since) > 0;

    // Keep every window decision below counting SURFACED messages, never raw entries, so that a
    // system-subtype-heavy stretch cannot end the walk early or survive the trim as a tail that
    // filters to nothing — an empty page whose `nextCursor` is `since` livelocks the caller.
    const collected: SlackMessage[] = [];
    let newestSeenTs: string | undefined;
    let previousTs: string | undefined;
    let pageCursor: string | undefined;
    const walked = new Set<string>();
    let pages = 0;
    for (;;) {
      const body: Record<string, unknown> = { channel, limit: HISTORY_PAGE_LIMIT };
      if (args.since !== undefined) body.oldest = args.since; // EXCLUSIVE (no `inclusive`)
      if (pageCursor !== undefined) body.cursor = pageCursor;
      const resp = await this.api<HistoryResponse>('conversations.history', body).catch(
        asSeamError(args.topic, ABSENT_ON_READ),
      );
      if (!Array.isArray(resp.messages)) {
        throw new SlackShapeError('conversations.history', 'returned no usable messages array');
      }
      const page = (resp.messages as unknown[]).filter(hasUsableTs).filter(aboveSince);
      for (const m of page) {
        // Keep this a THROW rather than a re-sort, so that a walk which cannot trust position as age
        // refuses instead of answering: the early break and the O(limit) trim below both DISCARD on
        // position, so a mis-ordered walk publishes a `nextCursor` above history it never surfaced —
        // and that span sits below the cursor, where no later catch-up returns for it.
        if (previousTs !== undefined && compareTs(m.ts, previousTs) > 0) {
          throw new SlackShapeError(
            'conversations.history',
            `returned ${m.ts} after ${previousTs}; entries are not newest-first`,
          );
        }
        previousTs = m.ts;
        if (newestSeenTs === undefined || compareTs(m.ts, newestSeenTs) > 0) newestSeenTs = m.ts;
      }
      // Keep this a LOOP rather than a spread, so that a page's cardinality — which the vendor
      // chooses, not the `limit` we sent — cannot reach V8's argument-count ceiling and throw a
      // RangeError naming neither the method nor the plugin, on this catch-up and every later one.
      for (const m of page) if (isPlainMessage(m)) collected.push(m);
      pageCursor = resp.response_metadata?.next_cursor || undefined;

      if (!resumeAfterSince) {
        if (collected.length >= limit) break;
      } else {
        // Keep the resume-after-`since` walk running to cursor exhaustion, so that `nextCursor` can
        // never come to rest above unfetched older history. Entries arrive newest-first — CHECKED
        // above, not assumed — so retaining only the oldest ~`limit + page_size` keeps memory at
        // O(limit) while the walk runs.
        const retain = limit + HISTORY_PAGE_LIMIT;
        if (collected.length > retain) collected.splice(0, collected.length - retain);
      }
      if (pageCursor === undefined) break;

      // Termination of the walk is otherwise entirely the peer's choice. Each guard below ends it
      // with a named error rather than a break — see {@link MAX_HISTORY_PAGES}.
      if (this.host.stopped()) {
        throw new Error(`Slack conversations.history walk on ${channel} aborted — disconnected`);
      }
      if (walked.has(pageCursor)) {
        throw new Error(
          `Slack conversations.history repeated page cursor on ${channel}; the walk is not advancing`,
        );
      }
      walked.add(pageCursor);
      if (++pages >= MAX_HISTORY_PAGES) {
        throw new Error(
          `Slack conversations.history walk on ${channel} exceeded ${MAX_HISTORY_PAGES} pages`,
        );
      }
    }

    const events = collected.sort((a, b) => compareTs(a.ts, b.ts));
    const window = resumeAfterSince ? events.slice(0, limit) : events.slice(-limit);
    const mentionMap = this.host.settings().mentionMap;
    const messages = window.map((m) => slackToMessage(args.topic, m, mentionMap));
    return {
      messages,
      nextCursor: messages.at(-1)?.cursor ?? emptyCursor(args, newestSeenTs),
    };
  }
}
