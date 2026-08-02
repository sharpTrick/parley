import type { Cursor, FetchRecentResult, Message, Topic } from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import { syncDeadlineMs } from './config.js';
import { cursorPastForeignBlock, emptyWindowCursor, STREAM_CURSOR_PREFIX } from './cursor.js';
import { MatrixSession } from './session.js';
import {
  eventToMessage, isMessageEvent, type MatrixEvent, type MessageEvent,
  nextBatchOf, positioningBatchOf, syncFilterParam, type SyncResponse,
} from './wire.js';

/** Real per-sync timeline cap for the incremental `/sync` filter and the backfill page size. */
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
/** Bound on backward `limited`-burst recovery pagination so it always terminates. */
const MAX_BACKFILL_PAGES = 50;
/**
 * Server-side filter for the catch-up paths, so reactions, edits and membership churn cost no
 * client page budget. Keep it OFF the `backfill`/`positionBoundary` pair — those match a boundary
 * `event_id` that may itself be a state event, which a filtered page would hide.
 */
const MESSAGES_ONLY_FILTER = encodeURIComponent(JSON.stringify({ types: ['m.room.message'] }));

type MessagesPage = { chunk: MatrixEvent[]; start?: string; end?: string };

/**
 * Every read of a room's timeline: the `/messages` pagination that answers a catch-up, and the
 * dedicated bounded `/sync` a blocking read drives when no subscribe loop covers its room.
 */
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
      page < MAX_BACKFILL_PAGES && collected.length < limit && !this.isStale(generation);
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
    // Keep a position claimable only when the walk stopped for a reason OF ITS OWN — it filled the
    // window, or it ran out of timeline. One a teardown or the page bound cut short has not read the
    // history it would be claiming to have walked past, whether it collected part of a window or
    // none of it, and core persists whatever cursor it is handed; hand back nothing and leave the
    // caller on its own position instead, so that history is re-read rather than skipped.
    if (collected.length < limit && !exhaustedTheTimeline) {
      return {
        messages: [],
        nextCursor: emptyWindowCursor(undefined, sinceCursor, this.isStale(generation)),
      };
    }
    const messages = collected.slice(0, limit).reverse().map((e) => eventToMessage(topic, e));
    const nextCursor =
      messages.at(-1)?.cursor ?? emptyWindowCursor(tailToken, sinceCursor, this.isStale(generation));
    return { messages, nextCursor };
  }

  /**
   * Page BACKWARDS from a `limited` sync's `prev_batch` (newest→oldest) until the last event already
   * delivered (`stopAfter`), the chunk empties, or the page bound trips; returned ASCENDING. `skip`
   * holds the ids already in the current sync batch so a token-boundary overlap can't double-deliver.
   */
  protected async backfill(
    roomId: string,
    topic: Topic,
    prevBatch: string,
    stopAfter: string | undefined,
    skip: Set<unknown>,
  ): Promise<MessageEvent[]> {
    const recovered: MessageEvent[] = [];
    let from = prevBatch;
    const generation = this.generation;
    for (let page = 0; page < MAX_BACKFILL_PAGES && !this.isStale(generation); page++) {
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?from=${encodeURIComponent(from)}&dir=b&limit=${INCREMENTAL_TIMELINE_LIMIT}`,
      );
      const { chunk, end } = (await res.json()) as MessagesPage;
      if (chunk.length === 0) break;
      let reachedBoundary = false;
      for (const e of chunk) {
        if (stopAfter !== undefined && e.event_id === stopAfter) {
          reachedBoundary = true;
          break;
        }
        if (skip.has(e.event_id)) continue; // already in this sync's batch — don't double-deliver.
        if (this.belongs(e, topic)) recovered.push(e);
      }
      if (reachedBoundary || end === undefined) break;
      from = end;
    }
    return recovered.reverse();
  }

  /**
   * Position a dedicated, bounded `/sync` used ONLY while a blocking `fetchRecent` waits on a room
   * that no `subscribe` loop covers. Resolves once the `timeout=0` positioning sync's `next_batch`
   * is in hand (its OWN token — never shared with the live loop), leaving {@link pollBoundedSync}
   * running behind it.
   */
  protected async driveBoundedSync(
    roomId: string,
    topic: Topic,
    blockMs: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const generation = this.generation;
    const deadline = Date.now() + blockMs;
    const initParam = syncFilterParam(roomId, 0);
    let nextBatch: string;
    try {
      const initial = await this.http(
        'GET',
        `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`,
        { signal: controller.signal, deadlineMs: syncDeadlineMs(0) },
      );
      nextBatch = positioningBatchOf(((await initial.json()) as SyncResponse).next_batch);
    } catch {
      return;
    }
    void this.pollBoundedSync(roomId, topic, deadline, nextBatch, generation, controller, wake);
  }

  /**
   * Long-poll a positioned dedicated `/sync` forward until a belonging event appears (→ `wake()`),
   * the `blockMs` budget runs out, or it is aborted (disconnect/wake). Every `/sync` timeout is
   * clamped to the remaining budget so the total wait never exceeds `blockMs`. Best-effort: any
   * error (an abort included) just returns — the `blockMs` timer still resolves the wait.
   */
  private async pollBoundedSync(
    roomId: string,
    topic: Topic,
    deadline: number,
    positionedAt: string,
    generation: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const incParam = syncFilterParam(roomId, INCREMENTAL_TIMELINE_LIMIT);
    let nextBatch = positionedAt;
    try {
      while (!this.isStale(generation) && !controller.signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const timeout = Math.min(remaining, this.syncTimeoutMs);
        const started = Date.now();
        const res = await this.http(
          'GET',
          `/_matrix/client/v3/sync?filter=${incParam}&since=${encodeURIComponent(nextBatch)}&timeout=${timeout}`,
          { signal: controller.signal, deadlineMs: syncDeadlineMs(timeout) },
        );
        const json = (await res.json()) as SyncResponse;
        nextBatch = nextBatchOf(json.next_batch, nextBatch);
        const events = json.rooms?.join?.[roomId]?.timeline?.events ?? [];
        if (events.some((e) => this.belongs(e, topic))) {
          wake();
          return;
        }
        if (returnedTooFast(started, timeout)) {
          await delay(Math.min(remaining, SYNC_IDLE_PACE_MS));
        }
      }
    } catch {
      /* aborted (disconnect/wake) or transient — the blockMs timer still resolves the wait */
    }
  }
}
