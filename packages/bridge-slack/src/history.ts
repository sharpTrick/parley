import type { Cursor, FetchRecentArgs, FetchRecentResult, Topic } from '@sharptrick/parley-core';
import {
  ABSENT_ON_READ,
  asSeamError,
  HISTORY_PAGE_LIMIT,
  type HistoryResponse,
  MAX_HISTORY_PAGES,
  type SlackApiCall,
  SlackShapeError,
} from './api.js';
import type { SocketHost, SocketModeLink } from './link.js';
import { slackToMessage } from './markup.js';
import {
  compareTs,
  emptyCursor,
  hasUsableTs,
  isPlainMessage,
  type SlackMessage,
} from './messages.js';
import { nextRungIn, withDeadline } from './socket.js';

/** {@link SocketHost}, plus what only a read needs: the topic mapping and the connected guard. */
export interface HistoryHost extends SocketHost {
  channelFor: (topic: Topic) => string;
  requireConnected: () => void;
}

/**
 * `conversations.history` with `oldest` = `since`, exclusive (`inclusive` is NEVER set), plus the
 * native long-poll when `blockMs` is asked for. The aggregate request cost of draining a backlog
 * this way, and the `catchup.limit` that reduces it, are documented in the package README.
 */
export class SlackHistory {
  constructor(
    private readonly api: SlackApiCall,
    private readonly link: SocketModeLink,
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
      const page = (resp.messages as unknown[]).filter(hasUsableTs);
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
      collected.push(...page.filter(isPlainMessage));
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

  /**
   * Hold a blocked `fetchRecent` for the caller's whole budget, parked on the shared Socket Mode
   * stream and re-querying `conversations.history` on the SAME capped ladder the dial cooldown uses.
   * Keep that ladder running whether or not the handshake lands, so that a message already durable
   * in history is delivered on the next rung rather than withheld to the deadline — a completed
   * handshake is not proof the stream serves. Keep the whole wait HERE rather than returning an
   * empty page the moment Socket Mode is unavailable, so that core's generic re-drive cannot turn
   * one blocked `fetch_recent` into one `conversations.history` request per
   * `block_poll_interval_ms` for the whole budget — a tiered method, on one channel.
   */
  async blockForMessage(
    args: FetchRecentArgs,
    since: Cursor,
    deadlineAt: number,
    session: number,
  ): Promise<FetchRecentResult> {
    // A later `connect()` clears `stopped`, so keep every rung gated on the SESSION too: a call
    // retired mid-rung would otherwise resume against the next session's configuration and spend
    // the rest of its budget there — for a caller that has already been torn down.
    const retired = (): boolean => this.host.stopped() || this.host.session() !== session;
    if (retired()) return { messages: [], nextCursor: since };
    const channel = this.host.channelFor(args.topic);
    const startedAt = Date.now();
    // The floor the NEXT rung resumes from. Every re-query that surfaces nothing has still walked
    // the backlog above it to cursor exhaustion, so carrying that position forward turns N rungs
    // over a channel with unsurfaced traffic into one walk plus N-1 single-page reads.
    let floor = since;
    const aborted = (): FetchRecentResult => ({ messages: [], nextCursor: floor });
    while (!retired()) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      // `handshake_timeout_ms` may be far longer than one ladder rung, so bound the wait for it by
      // the rung too, so that a socket which accepts and then says nothing cannot hold the caller
      // past the next history re-query.
      await withDeadline(
        this.link.ensurePollSocket(),
        Math.min(remaining, nextRungIn(Date.now() - startedAt)),
      ).catch(() => undefined);
      // A teardown that landed while the handshake ran leaves nothing to wait on, and `runFetch`
      // below would reject on the disconnected plugin; the caller gets its empty page instead.
      if (retired()) return aborted();
      // Keep the waiter armed BEFORE the re-query, so that a push landing while that query is in
      // flight is caught rather than lost — a lost wakeup here blocks for the whole budget. Keep it
      // a waiter rather than a bare timer, so that `disconnect()` drains it.
      const { wait, wake } = this.link.armWaiter(
        channel,
        String(floor),
        Math.min(deadlineAt - Date.now(), nextRungIn(Date.now() - startedAt)),
      );
      const requeried = await this.runFetch({ ...args, since: floor });
      if (requeried.messages.length > 0) {
        wake();
        return requeried;
      }
      floor = requeried.nextCursor;
      await wait;
    }
    if (retired()) return aborted();
    return this.runFetch({ ...args, since: floor });
  }
}
