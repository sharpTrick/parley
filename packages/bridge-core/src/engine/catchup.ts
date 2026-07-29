import type { Cursor, Topic } from '../message.js';
import type { BackendPlugin } from '../seam.js';
import type { ReadStateStore } from './read-state.js';
import type { SeenSet } from './seen-set.js';

export interface CatchUpArgs {
  plugin: BackendPlugin;
  topic: Topic;
  /** Page size per fetchRecent call. */
  limit: number;
  readState: ReadStateStore;
  seen: SeenSet;
}

/**
 * Catch-up driver for ONE topic (DESIGN §7). Drains everything newer than the persisted
 * cursor, warms the seen-set, and advances the persisted read position.
 *
 * It deliberately does NOT emit to the channel: on-start history is surfaced when the agent
 * calls the `fetch_recent` tool (the pull/push split, §7). The driver's jobs are (a) advance
 * the per-instance read cursor and (b) prevent the live poll from double-emitting across the
 * catch-up/live boundary. Core loops this once per configured topic (§7).
 *
 * @returns the number of messages drained.
 */
export async function catchUpTopic(args: CatchUpArgs): Promise<number> {
  const { plugin, topic, limit, readState, seen } = args;
  let since = readState.get(topic);
  const resumedFromDisk = since !== undefined;
  let first = true;
  let total = 0;

  for (;;) {
    const page = await (first && resumedFromDisk
      ? fetchWithResumeHint(plugin, { topic, since, limit }, readState.path)
      : plugin.fetchRecent({ topic, since, limit }));
    first = false;
    const { messages, nextCursor } = page;
    for (const m of messages) seen.markSeen(topic, m.backendMsgId);
    total += messages.length;
    readState.set(topic, nextCursor);

    // Defensive against a non-conformant backend: stop if a full page made no cursor
    // progress (a conformant backend guarantees nextCursor advances past returned rows).
    if (messages.length < limit || nextCursor === since) break;
    since = nextCursor;
  }

  return total;
}

/**
 * Run the FIRST catch-up page — the only one that replays a cursor read off disk — and, if the
 * plugin rejects it, re-throw with the one hint core is able to give.
 *
 * Cursors are opaque to core and their format is the backend's own (a Redis stream id, a Postgres
 * BIGSERIAL, a Matrix event id, …), while read-state is keyed by instance and topic but NOT by
 * backend. So pointing one instance_id at a different backend hands the new plugin a cursor minted
 * by the old one, and it fails somewhere deep in a driver — e.g. Postgres reporting
 * `invalid input syntax for type bigint: "1785300194045-0"` on a Redis stream id. Core cannot
 * validate an opaque cursor, but it knows a disk cursor was in play and where the file is, which is
 * the difference between a driver stack trace and an actionable one.
 *
 * Only the first page is wrapped: every later cursor in the loop was minted by this same plugin in
 * this same run, so a failure there is a genuine backend error and must surface unadorned.
 */
async function fetchWithResumeHint(
  plugin: BackendPlugin,
  req: { topic: Topic; since: Cursor | undefined; limit: number },
  statePath: string,
): Promise<Awaited<ReturnType<BackendPlugin['fetchRecent']>>> {
  try {
    return await plugin.fetchRecent(req);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // `cause` keeps the driver's own error (and its stack) reachable. Do NOT copy err.stack onto
    // the wrapper: callers print `err.stack ?? err.message`, and a stack always begins with the
    // message it was captured for — so overwriting it silently throws this hint away.
    throw new Error(
      `catch-up failed on topic ${JSON.stringify(req.topic)} while resuming from the stored ` +
        `cursor ${JSON.stringify(String(req.since))}: ${detail}\n` +
        `If this instance previously ran against a DIFFERENT backend, that cursor was minted by ` +
        `the old one and this backend cannot parse it. Delete ${statePath} to re-read from ` +
        `scratch, or give this instance its own instance_id.`,
      { cause: err },
    );
  }
}

/** Catch up on every configured topic in turn (DESIGN §7 — single-topic fetchRecent, core loops). */
export async function catchUpAll(args: {
  plugin: BackendPlugin;
  topics: Iterable<Topic>;
  limit: number;
  readState: ReadStateStore;
  seen: SeenSet;
}): Promise<number> {
  const { plugin, topics, limit, readState, seen } = args;
  let total = 0;
  for (const topic of topics) {
    total += await catchUpTopic({ plugin, topic, limit, readState, seen });
  }
  return total;
}
