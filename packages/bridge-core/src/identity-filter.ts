/**
 * Glob filtering for handle listings (e.g. `parley_list_users({ filter: "claude-*" })`).
 * Case-sensitive: handles are compared verbatim.
 */
import type { Handle } from './message.js';

/**
 * Longest glob `filter` we will evaluate; a longer pattern matches nothing. Mirrored by a `.max()`
 * on the `parley_list_users` `filter` schema, which rejects an over-long filter before it gets here.
 */
export const MAX_GLOB_LEN = 256;

/**
 * Full-anchored glob match: `*` = any run (including empty), `?` = exactly one char, every other
 * char a literal — regex metacharacters included. Greedy two-pointer walk that backtracks to the
 * most recent `*` and grows it one char at a time.
 *
 * Keep the two-pointer walk rather than a `*`→`.*` `RegExp` translation, so that a filter — which is
 * caller-supplied and one prompt-injection hop from attacker control — cannot wedge the event loop
 * in catastrophic backtracking.
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern.length > MAX_GLOB_LEN) return false;
  const P = pattern.length;
  const S = value.length;
  let p = 0;
  let s = 0;
  let lastStar = -1;
  let starEnd = 0;
  while (s < S) {
    if (p < P && (pattern[p] === '?' || pattern[p] === value[s])) {
      p++;
      s++;
    } else if (p < P && pattern[p] === '*') {
      lastStar = p;
      starEnd = s;
      p++;
    } else if (lastStar !== -1) {
      p = lastStar + 1;
      starEnd++;
      s = starEnd;
    } else {
      return false;
    }
  }
  while (p < P && pattern[p] === '*') p++;
  return p === P;
}

/** The matcher primitive behind {@link filterHandles}; exported for its own unit tests. */
export function matchGlob(pattern: string, value: string): boolean {
  return globMatch(pattern, value);
}

/** Keep the handles matching `filter`; when `filter` is undefined, keep them all. */
export function filterHandles<T extends { handle: Handle }>(items: T[], filter?: string): T[] {
  if (filter === undefined) return items;
  return items.filter((i) => globMatch(filter, i.handle));
}
