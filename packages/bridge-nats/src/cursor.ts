import { asCursor } from '@sharptrick/parley-core';
import type { Cursor, FetchRecentArgs, FetchRecentResult, Topic } from '@sharptrick/parley-core';

export const UNKNOWN_INCARNATION = '0';

/** Fold a stream's `created` stamp into an id-safe token identifying THAT incarnation of it. */
export const incarnationToken = (created: string | undefined): string =>
  (created ?? '').replace(/[^0-9A-Za-z]/g, '') || UNKNOWN_INCARNATION;

/**
 * The page a read of a topic with no stream returns. The bare `0` names no incarnation and sits
 * below every sequence, so the catch-up that follows the peer's first `post` starts at the new
 * stream's first message instead of being judged a cursor from a dead incarnation and served the
 * newest window — which would skip everything below it.
 */
const ABSENT_TOPIC_CURSOR = asCursor('0');

export const absentTopicPage = (args: FetchRecentArgs): FetchRecentResult => ({
  messages: [],
  nextCursor: args.since ?? ABSENT_TOPIC_CURSOR,
});

/** A cursor's two halves: which incarnation of the stream minted it, and where in it. */
export interface ParsedCursor {
  /** Absent in the bare-sequence form: a legacy cursor, or {@link ABSENT_TOPIC_CURSOR}. */
  incarnation?: string;
  seq: number;
}

/**
 * A cursor this plugin minted is `<stream incarnation>-<sequence>`; the bare decimal sequence names
 * no incarnation and still parses. Anything else is caller input (`parley_fetch_recent` takes
 * `since` as a free string) and is rejected here rather than coerced by `Number()` into a
 * silently-empty page or an opaque driver error.
 */
export function parseCursor(since: Cursor | undefined): ParsedCursor | undefined {
  if (since === undefined) return undefined;
  const parts = /^(?:([0-9A-Za-z]+)-)?(\d+)$/.exec(since);
  const seq = parts === null ? Number.NaN : Number(parts[2]);
  if (parts === null || !Number.isSafeInteger(seq)) {
    throw new Error(
      `invalid nats cursor ${JSON.stringify(String(since))} — expected a JetStream sequence number`,
    );
  }
  return parts[1] === undefined ? { seq } : { incarnation: parts[1], seq };
}

const DEFAULT_PAGE = 100;

const describeValue = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * A page size below 1 — or one that is not a number at all — makes every window this read computes
 * empty, and an empty page still mints a cursor. Reject it here, before any cursor exists: a
 * `nextCursor` core persists for a page it was never going to be given is silent, permanent loss of
 * everything under it.
 */
export function normalizeLimit(limit: number | undefined, topic: Topic): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `invalid nats limit ${describeValue(limit)} for topic ${JSON.stringify(String(topic))} — ` +
        'expected an integer of at least 1',
    );
  }
  return limit;
}
