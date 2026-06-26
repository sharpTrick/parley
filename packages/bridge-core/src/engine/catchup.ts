import type { Topic } from '../message.js';
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
  let total = 0;

  for (;;) {
    const { messages, nextCursor } = await plugin.fetchRecent({ topic, since, limit });
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
