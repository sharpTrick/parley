import type { BackendPlugin, Cursor, Topic } from '@sharptrick/parley-core';

/**
 * Replay `cursor` to exhaustion exactly as core's catch-up driver does. Kept in one place, so that
 * every table asking "what does this cursor still owe?" asks it the same way — a second copy that
 * stops on a different condition grades a different contract while reading like the first.
 */
export async function drainFrom(
  plugin: BackendPlugin,
  topic: Topic,
  cursor: Cursor,
  limit: number,
): Promise<{ contents: string[]; finalCursor: Cursor }> {
  let since = cursor;
  const contents: string[] = [];
  for (;;) {
    const page = await plugin.fetchRecent({ topic, since, limit });
    contents.push(...page.messages.map((m) => m.content));
    const stop = page.messages.length < limit || page.nextCursor === since;
    since = page.nextCursor;
    if (stop) break;
  }
  return { contents, finalCursor: since };
}
