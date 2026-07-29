import type { Cursor, Topic } from '../message.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
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
 * Ceiling on how many pages one topic's catch-up will read. A backend that keeps handing back
 * non-empty pages with an advancing cursor is indistinguishable from a very long topic, so the
 * driver stops and says so rather than pinning a CPU and a state-file rewrite per page forever.
 */
export const MAX_CATCHUP_PAGES = 10_000;

/**
 * Catch-up driver for ONE topic (DESIGN §7). Warms the seen-set and advances the persisted read
 * position. How much it reads depends on whether a cursor was persisted:
 *
 *   - RESUMED (a cursor on disk): pages forward from that cursor until the topic is exhausted —
 *     which means an EMPTY page, so exhausting a topic always costs one final empty round-trip.
 *   - COLD START (no cursor): reads the backend's most-recent `limit` window and adopts its tail.
 *     Anything older than that window is outside this instance's catch-up horizon — it is never
 *     drained and never will be, because read-state now points past it.
 *
 * A topic the backend cannot represent yet (`NoSuchTopicError`, recognised by contract via
 * {@link isNoSuchTopicError}) counts as zero messages and leaves read-state untouched — the seam
 * declares that "absent", not a failure, so one missing chat channel must not take the whole bridge
 * down.
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
  let total = 0;

  for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
    let result;
    try {
      result = await (page === 0 && resumedFromDisk
        ? fetchWithResumeHint(plugin, { topic, since, limit }, readState.path)
        : plugin.fetchRecent({ topic, since, limit }));
    } catch (err) {
      if (!isNoSuchTopicError(err)) throw err;
      console.error(`[parley] topic ${JSON.stringify(topic)} does not exist on the backend yet; skipping catch-up`);
      return total;
    }
    const { messages, nextCursor } = result;
    for (const m of messages) seen.markSeen(topic, m.backendMsgId);
    total += messages.length;
    readState.set(topic, nextCursor);

    // Keep EMPTY — not "shorter than the requested limit" — as the exhaustion test, so that a
    // backend whose history API caps a page below `limit` (Discord's 100, Telegram, Matrix
    // /messages) cannot strand everything past its cap. `nextCursor === since` is the separate
    // brake for a page that made no cursor progress at all.
    if (messages.length === 0 || nextCursor === since) return total;
    since = nextCursor;
  }

  console.error(
    `[parley] catch-up on topic ${JSON.stringify(topic)} stopped after ${MAX_CATCHUP_PAGES} pages ` +
      `with messages still arriving; the backend may not be honouring the exclusive \`since\` contract`,
  );
  return total;
}

/**
 * Run the first catch-up page — the only one replaying a cursor read off disk — and annotate a
 * rejection with the state-file path.
 *
 * Wrap only the first page, so that a later failure (whose cursor this plugin minted itself)
 * surfaces as the plain backend error it is.
 */
async function fetchWithResumeHint(
  plugin: BackendPlugin,
  req: { topic: Topic; since: Cursor | undefined; limit: number },
  statePath: string,
): Promise<Awaited<ReturnType<BackendPlugin['fetchRecent']>>> {
  try {
    return await plugin.fetchRecent(req);
  } catch (err) {
    // Rethrow the absence sentinel unwrapped, so that the caller can still recognise it — an absent
    // topic is not a stale-cursor problem and must not be described as one.
    if (isNoSuchTopicError(err)) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    // Never copy err.stack onto this wrapper, so that the hint survives: callers print
    // `err.stack ?? err.message`, and a stack opens with the message it was captured for.
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
