import type { Cursor, FetchRecentResult, Message, Topic } from '@sharptrick/parley-core';
import { cursorPastForeignBlock, emptyWindowCursor, STREAM_CURSOR_PREFIX } from './cursor.js';
import { MatrixSession } from './session.js';
import {
  eventToMessage, isMessageEvent, type MatrixEvent, type MessageEvent,
} from './wire.js';

/** Real per-sync timeline cap for the incremental `/sync` filter. */
export const INCREMENTAL_TIMELINE_LIMIT = 100;
/**
 * Pace between `/sync` calls that came back far sooner than the long-poll they asked for. A
 * conforming homeserver blocks server-side; keep the pace, so that a degenerate one cannot hot-spin
 * a loop that has no deadline to stop it.
 */
export const SYNC_IDLE_PACE_MS = 25;

/**
 * Keep the pace floor as well as the half-timeout test, so that a SMALL `sync_timeout_ms` — for
 * which half the timeout is already shorter than a round-trip — cannot make the guard unreachable
 * and reopen the hot spin.
 */
export const returnedTooFast = (startedAt: number, timeoutMs: number): boolean =>
  Date.now() - startedAt < Math.max(timeoutMs / 2, SYNC_IDLE_PACE_MS);

/** Bound on forward catch-up pagination so an all-foreign timeline terminates instead of spinning. */
const MAX_FORWARD_PAGES = 50;
/** Bound on recent-window pagination so a backward walk terminates. */
const MAX_BACKWARD_PAGES = 50;
/** Server-side filter, so reactions, edits and membership churn cost no client page budget. */
const MESSAGES_ONLY_FILTER = encodeURIComponent(JSON.stringify({ types: ['m.room.message'] }));

type MessagesPage = { chunk: MatrixEvent[]; start?: string; end?: string };

/** Every read of a room's timeline: the `/messages` pagination that answers a catch-up. */
export abstract class MatrixTimeline extends MatrixSession {
  /**
   * Locate the cursor event and page forward from just after it, returning only belonging messages
   * strictly after `since` plus a monotonic, replayable `nextCursor`.
   */
  protected async fetchSince(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    generation: number,
  ): Promise<FetchRecentResult> {
    // Keep this gate ahead of the `/context` round-trip, so that a read reached after its own
    // generation ended reports the caller's position back rather than asking the homeserver to
    // locate a cursor with a credential the teardown has already dropped.
    if (this.isStale(generation)) return { messages: [], nextCursor: sinceCursor };
    const since = String(sinceCursor);
    if (since.startsWith(STREAM_CURSOR_PREFIX)) {
      const token = since.slice(STREAM_CURSOR_PREFIX.length);
      return this.drainForward(
        roomId,
        topic,
        token || undefined,
        undefined,
        limit,
        sinceCursor,
        generation,
        // A read-state file is editable, truncatable, and survives a `shared_room`/`server_name`
        // change, so this token may be one the homeserver rejects outright (Synapse: 400 M_UNKNOWN
        // "'from' parameter is invalid"). Degrade like the `event_id` branch's 404.
        { startTokenIsUntrusted: true },
      );
    }
    // Keep the `''` branch: read-state files written before {@link STREAM_CURSOR_PREFIX} existed
    // carry that sentinel, and it must not reach `/context` — see STREAM_CURSOR_PREFIX.
    if (since === '') {
      return this.drainForward(roomId, topic, undefined, undefined, limit, sinceCursor, generation);
    }
    // Exclusive `since`: locate the cursor event, then page forward from just after it.
    const ctxRes = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(since)}?limit=0`,
      { allowStatuses: [404] },
    );
    // Keep this fallback rather than throwing on an unresolvable cursor, so that a purged /
    // retention-expired event (or a topic remapped to another room by a `shared_room`/`server_name`
    // change) does not brick startup: `buildBridge` awaits `catchUpAll`, so a throw here fails
    // EVERY restart until the read-state file is hand-edited.
    if (ctxRes.status === 404) {
      return this.recentWindow(roomId, topic, limit, generation, sinceCursor);
    }
    const ctx = (await ctxRes.json()) as { end?: string };
    if (ctx.end === undefined) {
      return { messages: [], nextCursor: sinceCursor };
    }
    return this.drainForward(roomId, topic, ctx.end, since, limit, sinceCursor, generation);
  }

  /**
   * Page FORWARD from `start` (undefined = the first visible event in the room), collecting up to
   * `limit` messages belonging to `topic`. `sinceEventId`, when given, is made strictly exclusive.
   */
  private async drainForward(
    roomId: string,
    topic: Topic,
    start: string | undefined,
    sinceEventId: string | undefined,
    limit: number,
    sinceCursor: Cursor,
    generation: number,
    opts?: { startTokenIsUntrusted?: boolean },
  ): Promise<FetchRecentResult> {
    const messages: Message[] = [];
    let from = start;
    // Keep tracking the last RAW event id of every FULL page, so that `cursorPastForeignBlock` can
    // cross a page-sized block of foreign-topic or non-message events: `/messages` bounds a page
    // BEFORE filtering, so a `nextCursor` pinned at `since` is indistinguishable from "caught up"
    // and masks every later on-topic message forever. Keep the FULL-page condition as well — a
    // short page IS the end of the timeline, and advancing there moves the cursor on foreign
    // traffic alone, breaking the stable-cursor contract for every topic that shares a room.
    let lastRawEventId: string | undefined;
    for (
      let page = 0;
      page < MAX_FORWARD_PAGES && messages.length < limit && !this.isStale(generation);
      page++
    ) {
      const fromParam = from === undefined ? '' : `from=${encodeURIComponent(from)}&`;
      const fwdRes = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${fromParam}dir=f&limit=${limit}&filter=${MESSAGES_ONLY_FILTER}`,
        page === 0 && opts?.startTokenIsUntrusted === true
          ? { allowStatuses: [400, 404] }
          : undefined,
      );
      if (!fwdRes.ok) return this.recentWindow(roomId, topic, limit, generation, sinceCursor);
      const { chunk, end } = (await fwdRes.json()) as MessagesPage;
      if (chunk.length === 0) break; // genuine end of timeline.
      // Keep the `since` event both DROPPED and out of the page-fullness count, so that a
      // homeserver whose `/context` `end` token re-includes it can neither re-deliver it nor make
      // an end-of-timeline page look full and move this topic's cursor on foreign traffic alone.
      const reincluded =
        sinceEventId !== undefined && chunk.some((e) => e.event_id === sinceEventId);
      const rawTail =
        chunk.length - (reincluded ? 1 : 0) >= limit ? chunk.at(-1)?.event_id : undefined;
      if (typeof rawTail === 'string') lastRawEventId = rawTail;
      let events = chunk.filter(isMessageEvent);
      const idx =
        sinceEventId === undefined ? -1 : events.findIndex((e) => e.event_id === sinceEventId);
      if (idx >= 0) events = events.slice(idx + 1);
      events = events.filter((e) => this.belongs(e, topic));
      for (const e of events) messages.push(eventToMessage(topic, e));
      if (end === undefined) break; // no further forward pagination token.
      from = end;
    }
    const trimmed = messages.slice(0, limit);
    return {
      messages: trimmed,
      nextCursor: cursorPastForeignBlock(trimmed, lastRawEventId, sinceCursor),
    };
  }

  /**
   * Most-recent `limit` messages for `topic`, ASCENDING — the default (`since`-less) window AND the
   * fallback when a persisted cursor has expired, whose contract is identical.
   *
   * Pages BACKWARDS until `limit` BELONGING messages are collected: a `dir=b` page is bounded
   * before topic/type filtering, so a single raw page would report a topic sitting behind `limit`
   * foreign-topic, reaction, or membership events as empty — indistinguishable from one never
   * written to.
   */
  protected async recentWindow(
    roomId: string,
    topic: Topic,
    limit: number,
    generation: number,
    sinceCursor: Cursor | undefined,
  ): Promise<FetchRecentResult> {
    const collected: MessageEvent[] = [];
    let from: string | undefined;
    let tailToken: string | undefined;
    let exhaustedTheTimeline = false;
    for (
      let page = 0;
      page < MAX_BACKWARD_PAGES && collected.length < limit && !this.isStale(generation);
      page++
    ) {
      const fromParam = from === undefined ? '' : `from=${encodeURIComponent(from)}&`;
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${fromParam}dir=b&limit=${limit}&filter=${MESSAGES_ONLY_FILTER}`,
      );
      const { chunk, start, end } = (await res.json()) as MessagesPage;
      tailToken ??= start;
      if (chunk.length === 0) {
        exhaustedTheTimeline = true;
        break;
      }
      for (const e of chunk) if (this.belongs(e, topic)) collected.push(e);
      if (end === undefined) {
        exhaustedTheTimeline = true;
        break;
      }
      from = end;
    }
    const stale = this.isStale(generation);
    // Keep a position claimable only when the walk reached one of its OWN stopping conditions — it
    // filled the window, it ran out of timeline, or it spent {@link MAX_BACKWARD_PAGES}. A TEARDOWN
    // has read none of the history it would be claiming to have walked past, and core persists
    // whatever cursor it is handed; hand back nothing and leave the caller on its own position
    // instead, so that history is re-read rather than skipped. Keep the page bound OFF that list —
    // every later call hits the same bound, so nothing a bound-cut walk withholds is ever re-read,
    // while reporting no position mints `@parley-stream:` ("the first visible event in the room")
    // for a since-less read and wedges a since-having one on a cursor already refused once.
    if (collected.length < limit && !exhaustedTheTimeline && stale) {
      return { messages: [], nextCursor: emptyWindowCursor(undefined, sinceCursor, true) };
    }
    const messages = collected.slice(0, limit).reverse().map((e) => eventToMessage(topic, e));
    const nextCursor = messages.at(-1)?.cursor ?? emptyWindowCursor(tailToken, sinceCursor, stale);
    return { messages, nextCursor };
  }
}
