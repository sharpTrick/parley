import {
  asCursor, type Cursor, type Message, type MessageHandler, type Topic,
} from '@sharptrick/parley-core';
import type { ZulipConnection } from './connection.js';
import { readDeadlineMs } from './pacing.js';
import {
  asArray, MAX_MESSAGES_PER_FETCH, pageAnchor, type ZulipMessage, zulipToMessage,
} from './wire.js';

/**
 * Messages a single gap-fill history read asks for. Exported so a test's dead-window sizes stay
 * derived from it and cannot stop straddling a page boundary if it changes.
 */
export const GAP_FILL_PAGE = 500;

/**
 * Records the pre-subscribe watermark probe reads. Keep it a WINDOW rather than a single record, so
 * that an unusable newest record cannot hide the topic's real tail: the probe would then have to
 * navigate past it by that record's own bad id, land nowhere, and read an empty topic — arming a
 * gap-fill that replays the entire history through the live handler.
 */
export const TAIL_PROBE_PAGE = 100;

/**
 * What a narrowed history read is bound to. Every read carries a generation, so that a paginated one
 * cannot fetch its later pages from whatever server the plugin is connected to by then — the pages
 * would be one window in two id spaces.
 */
export interface ReadOpts {
  generation: number;
  signal?: AbortSignal;
  deadline?: number;
}

/**
 * `since` is made strictly exclusive server-side by `include_anchor=false`, and Zulip answers
 * ascending by id, so no client-side reordering is needed. Paginates so the seam's `limit` stays
 * honest: Zulip rejects `num_before + num_after > 5000` outright, so a larger caller limit is served
 * as successive pages rather than propagated as a 400.
 *
 * `sawRecords` reports whether the server showed any record AT ALL — which an empty message list
 * cannot tell you, because every record it showed may have been unusable. `navigable` reports WHY
 * the walk stopped: `true` when the window was filled or history ran out, `false` when no id the
 * page showed could name where to continue from. Keep the two apart, so that a caller replaying a
 * gap cannot read a walk that stopped dead as a gap that closed.
 */
export async function readWindow(
  conn: ZulipConnection, topic: Topic, since: Cursor | undefined, limit: number, opts: ReadOpts,
): Promise<{ messages: Message[]; sawRecords: boolean; navigable: boolean }> {
  const signal = opts.signal;
  const deadlineMs = opts.deadline === undefined ? undefined : readDeadlineMs(opts.deadline);
  const narrow = JSON.stringify([
    { operator: 'stream', operand: conn.cfg.stream },
    { operator: 'topic', operand: conn.wireTopic(topic) },
  ]);
  const backwards = since === undefined;
  const want = Math.max(0, limit);
  const out: Message[] = [];
  let sawRecords = false;
  let navigable = true;
  let widen = 0;
  let anchor = backwards ? 'newest' : String(since);
  let includeAnchor = backwards;
  while (out.length < want) {
    // Widen by what the next page will RE-READ: an anchor that had to step inward past an unusable
    // record serves that record again before it reaches anything new, and the caller's window must
    // not be spent on it.
    const page = Math.min(want - out.length + widen, MAX_MESSAGES_PER_FETCH);
    const query: Record<string, string> = {
      narrow,
      anchor,
      include_anchor: String(includeAnchor),
      num_before: backwards ? String(page) : '0',
      num_after: backwards ? '0' : String(page),
      apply_markdown: 'false', // raw content, not rendered HTML
    };
    // Keep the check on BOTH sides of the request, so that a read resumed after a reconnect — a
    // blocking fetch's re-read, a gap-fill's next page — cannot put the connection it addressed's
    // narrow and anchor on the wire to whatever server replaced it.
    conn.assertGeneration(opts.generation);
    const res = await conn.rest.request('GET', '/api/v1/messages', { query, signal, deadlineMs });
    const raw = asArray(((await res.json()) as { messages?: ZulipMessage[] } | null)?.messages);
    conn.assertGeneration(opts.generation);
    sawRecords ||= raw.length > 0;
    const got: Message[] = []; // Zulip returns ascending by id

    let firstUsable = -1;
    let lastUsable = -1;
    for (const [i, record] of raw.entries()) {
      const m = zulipToMessage(topic, record);
      if (m === undefined) continue;
      if (firstUsable < 0) firstUsable = i;
      lastUsable = i;
      got.push(m);
    }
    if (got.length < raw.length) {
      console.warn(
        `[parley-zulip] dropped ${raw.length - got.length} of ${raw.length} records read from ` +
          `topic ${JSON.stringify(topic)}: no usable message id, so neither the dedup key nor ` +
          'the cursor can be derived',
      );
    }
    // Keep the unshift: pages from the newest anchor walk BACKWARDS, so appending would
    // return the window in descending page order.
    if (backwards) out.unshift(...got);
    else out.push(...got);
    // Keep the window at the caller's limit: a widened page can serve more usable records than the
    // window still had room for, and the surplus is its FAR side, not its edge.
    if (out.length > want) {
      if (backwards) out.splice(0, out.length - want);
      else out.length = want;
    }
    // Keep the termination on the RAW page, so that dropping records — even every record of a page
    // — cannot be mistaken for the end of history and silently truncate the window a caller asked
    // for.
    if (raw.length < page) break;
    if (out.length >= want) break;
    const stop = (): void => {
      navigable = false;
      console.warn(
        `[parley-zulip] history read on topic ${JSON.stringify(topic)} stopped at anchor ` +
          `${anchor}: no record on the page it answered with carries an id that moves the read on, ` +
          'so whatever is behind that page cannot be reached',
      );
    };
    // The next anchor is the outermost record the page let us NAME — never the raw edge's own id.
    // Keep it off an id `zulipToMessage` refused, so that a mangled one cannot be navigated by: it
    // is not a position in this server's history, and asking from it lands somewhere unrelated
    // (`0` and a negative walk off the start; `1e18` never moves). Stepping inward instead makes
    // the next page re-read what was stepped over, which `widen` pays for.
    const inward = backwards ? got[0] : got.at(-1);
    if (inward !== undefined) {
      const next = pageAnchor(Number(inward.backendMsgId), anchor, backwards);
      if (next === undefined) {
        stop();
        break;
      }
      anchor = next;
      includeAnchor = false;
      widen = backwards ? firstUsable : raw.length - 1 - lastUsable;
    } else if (page < MAX_MESSAGES_PER_FETCH) {
      // A full page with nothing nameable on it: no id it carries can measure how far the
      // obstruction runs, so ask the SAME anchor for as much as the server will ever serve. One
      // request either clears it or settles that nothing can.
      widen = MAX_MESSAGES_PER_FETCH;
    } else {
      stop();
      break;
    }
  }
  return { messages: out, sawRecords, navigable };
}

/**
 * The id the live path may treat as already delivered: the newest USABLE message on `topic`, `0`
 * when the server showed no record at all, and `undefined` when it showed only records carrying
 * no usable id — a tail that cannot be established, and so one nothing may be replayed from.
 */
export async function probeTail(
  conn: ZulipConnection, topic: Topic, opts: ReadOpts,
): Promise<number | undefined> {
  const { messages, sawRecords } = await readWindow(conn, topic, undefined, TAIL_PROBE_PAGE, opts);
  const newest = messages.at(-1);
  if (newest !== undefined) return Number(newest.backendMsgId);
  return sawRecords ? undefined : 0;
}

/**
 * Replay everything after `sinceId` through `handler`; returns the new last delivered id.
 * `onProgress` is invoked with the last delivered id after EACH page lands, so a caller retrying
 * a throwing gap-fill can resume past already-delivered pages instead of re-delivering them (the
 * history read at the top of the loop may throw on any non-2xx/network blip — the caller retries).
 *
 * A walk that stopped because it could not navigate ({@link readWindow}'s `navigable`) THROWS
 * rather than returning. Keep it on the throwing path, so that a gap nothing can cross is retried
 * under the caller's backoff and stays reported, instead of a short page being read as a gap that
 * closed and everything behind the obstruction being dropped silently and never retried.
 */
export async function gapFill(
  conn: ZulipConnection, topic: Topic, sinceId: number,
  deliver: MessageHandler, onProgress: (id: number) => void, opts: ReadOpts,
): Promise<number> {
  const page = GAP_FILL_PAGE;
  let cursor = asCursor(String(sinceId));
  for (;;) {
    // May throw (non-2xx / network blip / teardown) → the caller retries from `onProgress`.
    const { messages, navigable } = await readWindow(conn, topic, cursor, page, opts);
    for (const m of messages) deliver(m);
    const last = messages.at(-1);
    if (last !== undefined) {
      cursor = last.cursor; // advance so a retry resumes past this delivered page
      onProgress(Number(cursor)); // report per-page progress — durable across a later throw
    }
    if (!navigable) {
      throw new Error(
        `gap-fill for topic ${JSON.stringify(topic)} cannot read past the page after cursor ` +
          `${String(cursor)}: no record on it carries an id the read can continue from, so the ` +
          'gap is not closed.',
      );
    }
    if (last === undefined || messages.length < page) return Number(cursor);
  }
}
