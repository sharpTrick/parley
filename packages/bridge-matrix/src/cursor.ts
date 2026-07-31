import { asCursor, type Cursor, type Message } from '@sharptrick/parley-core';

/**
 * Marks an opaque `/messages` pagination token — the position an empty window was read AT, so
 * replaying it returns exactly what has landed since. Never mint `''` instead: an empty cursor 404s
 * on `/context` and decodes as an EXPIRED cursor, silently dropping everything older than the
 * recent window.
 */
export const STREAM_CURSOR_PREFIX = '@parley-stream:';

/**
 * The cursor a forward page must report: the last belonging message's, else the last FULL raw
 * page's position so a page-sized block of foreign-topic or non-message events is crossed rather
 * than replayed forever, else the input `since` — which is what a short, all-foreign tail must
 * report, so that traffic on another topic never moves this topic's cursor.
 */
export const cursorPastForeignBlock = (
  collected: Message[],
  lastRawEventId: string | undefined,
  sinceCursor: Cursor,
): Cursor =>
  collected.at(-1)?.cursor ??
  (lastRawEventId !== undefined ? asCursor(lastRawEventId) : sinceCursor);

/**
 * The cursor an EMPTY read reports: the position it was read AT, else the caller's own.
 *
 * Keep the THROW for a read that observed NEITHER — no page and no `since` — so that a teardown
 * landing before the first page cannot report `@parley-stream:` with no token, which means "the
 * first visible event in the room" and is a position nothing observed. Core's catch-up persists
 * whatever cursor it is handed, so a `disconnect()` racing startup catch-up would otherwise write
 * "beginning of the room" to read-state and re-deliver the whole room on the next start.
 */
export function emptyWindowCursor(
  readAt: string | undefined,
  sinceCursor: Cursor | undefined,
  stale: boolean,
): Cursor {
  if (readAt !== undefined) return asCursor(`${STREAM_CURSOR_PREFIX}${readAt}`);
  if (sinceCursor !== undefined) return sinceCursor;
  if (stale) {
    throw new Error(
      '[parley-matrix] fetchRecent stood down before it read a page and was given no `since`, so ' +
        'it has no read position to report; the plugin disconnected or reconnected mid-call.',
    );
  }
  return asCursor(STREAM_CURSOR_PREFIX);
}
