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
export const newestWindow = (page: PageFn, limit: number, deadline: number) =>
  walk(page, limit, deadline, false, (size, before) =>
    before === undefined ? `limit=${size}` : `limit=${size}&before=${before}`,
  );

/**
 * One exclusive-`since` walk, oldest-first. `?after=` is exclusive server-side and each page comes
 * back newest-first; past 100 it pages forward on the largest id seen until filled, a short page
 * says the tail is reached, or the call's shared `deadline` runs out.
 */
export const windowSince = (page: PageFn, since: string, limit: number, deadline: number) =>
  walk(page, limit, deadline, true, (size, last) =>
    `after=${encodeURIComponent(last ?? since)}&limit=${size}`,
  );

/**
 * One bounded page walk, anchored each time on the last record it kept. `forward` says which end of
 * the timeline it advances towards, and with it both orientations: Discord answers every page
 * newest-first, so a forward walk reverses each page and a backward walk reverses the whole result.
 */
async function walk(
  page: PageFn,
  limit: number,
  deadline: number,
  forward: boolean,
  query: (size: number, anchor: string | undefined) => string,
): Promise<DiscordMessage[]> {
  const walked: DiscordMessage[] = [];
  for (let n = 0; walked.length < limit; n++) {
    const size = Math.min(limit - walked.length, PAGE_LIMIT);
    const chunk = await pageWithin(page, query(size, walked.at(-1)?.id), deadline, n);
    if (chunk === undefined || chunk.length === 0) break;
    walked.push(...(forward ? chunk.reverse() : chunk));
    if (chunk.length < size) break;
  }
  return forward ? walked : walked.reverse();
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
