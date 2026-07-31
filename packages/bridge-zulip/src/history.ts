import {
  asCursor, type Cursor, type Message, type MessageHandler, type Topic,
} from '@sharptrick/parley-core';
import type { ZulipConnection } from './connection.js';
import { budgetedDeadlineMs } from './pacing.js';
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
 * as successive pages rather than propagated as a 400. `sawRecords` reports whether the server
 * showed any record AT ALL — which an empty message list cannot tell you, because every record it
 * showed may have been unusable.
 */
export async function readWindow(
  conn: ZulipConnection, topic: Topic, since: Cursor | undefined, limit: number, opts: ReadOpts,
): Promise<{ messages: Message[]; sawRecords: boolean }> {
  const signal = opts.signal;
  const deadlineMs = opts.deadline === undefined ? undefined : budgetedDeadlineMs(opts.deadline);
  const narrow = JSON.stringify([
    { operator: 'stream', operand: conn.cfg.stream },
    { operator: 'topic', operand: conn.wireTopic(topic) },
  ]);
  const out: Message[] = [];
  let sawRecords = false;
  let remaining = Math.max(0, limit);
  let anchor = since === undefined ? 'newest' : String(since);
  let includeAnchor = since === undefined;
  while (remaining > 0) {
    const page = Math.min(remaining, MAX_MESSAGES_PER_FETCH);
    const query: Record<string, string> = {
      narrow,
      anchor,
      include_anchor: String(includeAnchor),
      num_before: since === undefined ? String(page) : '0',
      num_after: since === undefined ? '0' : String(page),
      apply_markdown: 'false', // raw content, not rendered HTML
    };
    const res = await conn.rest.request('GET', '/api/v1/messages', { query, signal, deadlineMs });
    const raw = asArray(((await res.json()) as { messages?: ZulipMessage[] } | null)?.messages);
    conn.assertGeneration(opts.generation);
    sawRecords ||= raw.length > 0;
    const got = raw.flatMap((m) => zulipToMessage(topic, m) ?? []); // Zulip returns ascending by id
    if (got.length < raw.length) {
      console.warn(
        `[parley-zulip] dropped ${raw.length - got.length} of ${raw.length} records read from ` +
          `topic ${JSON.stringify(topic)}: no usable message id, so neither the dedup key nor ` +
          'the cursor can be derived',
      );
    }
    // Keep the unshift: pages from the newest anchor walk BACKWARDS, so appending would
    // return the window in descending page order.
    if (since === undefined) out.unshift(...got);
    else out.push(...got);
    remaining -= got.length;
    // Keep BOTH the termination and the next anchor on the RAW page, so that dropping records —
    // even every record of a page — cannot be mistaken for the end of history and silently
    // truncate the window a caller asked for.
    if (raw.length < page) break;
    const next = pageAnchor(since === undefined ? raw[0] : raw.at(-1), anchor, since === undefined);
    if (next === undefined) break;
    anchor = next;
    includeAnchor = false;
  }
  return { messages: out, sawRecords };
}

/**
 * The id the live path may treat as already delivered: the newest USABLE message on `topic`, `0`
 * when the server showed no record at all, and `undefined` when it showed only records carrying
 * no usable id — a tail that cannot be established, and so one nothing may be replayed from.
 */
export async function probeTail(
  conn: ZulipConnection, topic: Topic, generation: number,
): Promise<number | undefined> {
  const { messages, sawRecords } = await readWindow(conn, topic, undefined, TAIL_PROBE_PAGE, {
    generation,
  });
  const newest = messages.at(-1);
  if (newest !== undefined) return Number(newest.backendMsgId);
  return sawRecords ? undefined : 0;
}

/**
 * Replay everything after `sinceId` through `handler`; returns the new last delivered id.
 * `onProgress` is invoked with the last delivered id after EACH page lands, so a caller retrying
 * a throwing gap-fill can resume past already-delivered pages instead of re-delivering them (the
 * history read at the top of the loop may throw on any non-2xx/network blip — the caller retries).
 */
export async function gapFill(
  conn: ZulipConnection, topic: Topic, sinceId: number,
  deliver: MessageHandler, onProgress: (id: number) => void, opts: ReadOpts,
): Promise<number> {
  const page = GAP_FILL_PAGE;
  let cursor = asCursor(String(sinceId));
  for (;;) {
    // May throw (non-2xx / network blip / teardown) → the caller retries from `onProgress`.
    const { messages } = await readWindow(conn, topic, cursor, page, opts);
    for (const m of messages) deliver(m);
    const last = messages.at(-1);
    if (last === undefined) return Number(cursor);
    cursor = last.cursor; // advance so a retry resumes past this delivered page
    onProgress(Number(cursor)); // report per-page progress — durable across a later throw
    if (messages.length < page) return Number(cursor);
  }
}
