import type { BackendMsgId, Cursor, Message, Topic } from '../message.js';
import type { SeenSet } from './seen-set.js';

/**
 * Where this process's live era begins on one topic. Everything up to `last` was on the backend when
 * on-start catch-up paged the topic, so a reconciling read that hands it over says nothing about
 * push, which owes only the post-subscribe tail (seam.ts clause 3).
 */
interface LiveBoundary {
  /** The newest message catch-up saw on the topic. Absent when it saw none: the whole topic is live-era. */
  last: BackendMsgId | undefined;
  /** Cursors known to sit at or past `last`. Cursors are opaque, so this is the only way a read that never passes `last` can be placed. */
  cursors: Cursor[];
}

/**
 * Bounded so the set cannot grow with the agent's paging. Only the cursor the agent's next read
 * starts from matters, and losing one under-counts — which leans to `no-traffic`, never to a verdict.
 */
const MAX_LIVE_CURSORS = 16;

/**
 * Keyed on the dedup window because it is the one object catch-up and the reconciling read already
 * share, and a root with no window cannot compare the counters at all. Entries are made only by
 * catch-up, so the map is bounded by the topics it is run over.
 */
const boundaries = new WeakMap<SeenSet, Map<Topic, LiveBoundary>>();

/**
 * Record where catch-up's warming ended. `atHead` is a cursor a read had just found nothing after,
 * so it is at or past `last` by construction.
 */
export function markLiveBoundary(
  seen: SeenSet,
  topic: Topic,
  last: BackendMsgId | undefined,
  atHead: Cursor | undefined,
): void {
  let topics = boundaries.get(seen);
  if (topics === undefined) boundaries.set(seen, (topics = new Map()));
  topics.set(topic, { last, cursors: atHead !== undefined ? [atHead] : [] });
}

/**
 * The index in `page` from which its messages reached the backend after the boundary — `page.length`
 * when none can be shown to have. A read from a cursor at or past the boundary is live-era
 * throughout; any other read is live-era only past the boundary message itself. A topic catch-up
 * never armed has no boundary, and nothing on it is admitted.
 *
 * Records `nextCursor` as at-or-past the boundary whenever this page reached it, so the agent's next
 * read from where this one stopped is placed without having to pass `last` again.
 */
export function liveEraStart(
  seen: SeenSet,
  topic: Topic,
  from: Cursor | undefined,
  page: readonly Message[],
  nextCursor: Cursor | undefined,
): number {
  const boundary = boundaries.get(seen)?.get(topic);
  if (boundary === undefined) return page.length;
  if (boundary.last === undefined) return 0;
  let start: number;
  if (from !== undefined && boundary.cursors.includes(from)) {
    start = 0;
  } else {
    const at = page.findIndex((m) => m.backendMsgId === boundary.last);
    if (at < 0) return page.length;
    start = at + 1;
  }
  if (nextCursor !== undefined) remember(boundary, nextCursor);
  return start;
}

function remember(boundary: LiveBoundary, cursor: Cursor): void {
  if (boundary.cursors.includes(cursor)) return;
  boundary.cursors.push(cursor);
  if (boundary.cursors.length > MAX_LIVE_CURSORS) boundary.cursors.shift();
}
