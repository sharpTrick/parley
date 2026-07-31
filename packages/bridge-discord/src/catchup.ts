import { NoSuchTopicError } from '@sharptrick/parley-core';
import { PAGE_LIMIT, type DiscordMessage } from './wire.js';

export type PageFn = (query: string, budgetMs: number) => Promise<DiscordMessage[]>;

/**
 * The floor under the FIRST query's budget. Keep it above zero, so that whether an absent channel
 * answers `NoSuchTopicError` or an empty window is decided by the channel and not by the clock.
 */
const MIN_QUERY_BUDGET_MS = 250;

/**
 * The newest `limit` messages, oldest-first. Keep paging BACKWARDS with `before` past the API's
 * 100-per-page cap, so that a larger limit is not answered with a truncated head whose cursor
 * already sits past everything older than it.
 */
export async function newestWindow(
  page: PageFn,
  limit: number,
  deadline: number,
): Promise<DiscordMessage[]> {
  const newestFirst: DiscordMessage[] = [];
  for (let n = 0; newestFirst.length < limit; n++) {
    const size = Math.min(limit - newestFirst.length, PAGE_LIMIT);
    const before = newestFirst.at(-1)?.id;
    const query = before === undefined ? `limit=${size}` : `limit=${size}&before=${before}`;
    const chunk = await pageWithin(page, query, deadline, n);
    if (chunk === undefined || chunk.length === 0) break;
    newestFirst.push(...chunk);
    if (chunk.length < size) break;
  }
  return newestFirst.reverse();
}

/**
 * One exclusive-`since` walk, oldest-first. `?after=` is exclusive server-side and each page comes
 * back newest-first; past 100 it pages forward on the largest id seen until filled, a short page
 * says the tail is reached, or the call's shared `deadline` runs out.
 */
export async function windowSince(
  page: PageFn,
  since: string,
  limit: number,
  deadline: number,
): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  for (let n = 0; messages.length < limit; n++) {
    const size = Math.min(limit - messages.length, PAGE_LIMIT);
    const after = messages.at(-1)?.id ?? since;
    const query = `after=${encodeURIComponent(after)}&limit=${size}`;
    const chunk = await pageWithin(page, query, deadline, n);
    if (chunk === undefined || chunk.length === 0) break;
    messages.push(...chunk.reverse());
    if (chunk.length < size) break;
  }
  return messages;
}

/**
 * The `n`th page of a walk sharing ONE absolute `deadline`, or undefined once that deadline has
 * ended the walk. Re-read the clock PER PAGE, so that a limit spanning N pages cannot spend N times
 * the budget the caller set. Page ZERO runs even on a spent budget, so that no call answers an
 * empty window without asking; a later page failing past the deadline ends the walk instead of
 * failing it, so a bounded call still answers with what it gathered and a cursor to resume from.
 */
async function pageWithin(
  page: PageFn,
  query: string,
  deadline: number,
  n: number,
): Promise<DiscordMessage[] | undefined> {
  const remaining = deadline - Date.now();
  const budget = n === 0 ? Math.max(remaining, MIN_QUERY_BUDGET_MS) : remaining;
  if (budget <= 0) return undefined;
  try {
    return await page(query, budget);
  } catch (err) {
    if (n === 0 || err instanceof NoSuchTopicError || Date.now() < deadline) throw err;
    return undefined;
  }
}
