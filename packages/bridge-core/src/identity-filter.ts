/**
 * Glob filtering for handle listings (e.g. `parley_list_users({ filter: "claude-*" })`).
 * Case-sensitive: handles are compared verbatim.
 */
import type { Handle } from './message.js';

/**
 * Longest glob `filter` we will evaluate. A longer one is REFUSED — never answered — because the
 * only answer it could otherwise carry is an empty roster, which a caller cannot tell apart from
 * "no peer is reachable". Mirrored by a `.max()` on the `parley_list_users` `filter` schema, which
 * rejects an over-long filter before it gets here.
 */
export const MAX_GLOB_LEN = 256;

function assertGlobLength(pattern: string): void {
  if (pattern.length > MAX_GLOB_LEN)
    throw new RangeError(
      `glob filter is ${pattern.length} characters; at most ${MAX_GLOB_LEN} are matched. ` +
        'Shorten it — an over-long filter is refused, not answered with an empty roster.',
    );
}

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
  const P = pattern.length;
  const S = value.length;
  let p = 0;
  let s = 0;
  let lastStar = -1;
  let starEnd = 0;
  while (s < S) {
    // Keep the `*` arm ahead of the literal arm, so that a `*` occurring in the VALUE cannot be
    // consumed as a literal and lose the backtrack point the rest of the walk depends on.
    if (p < P && pattern[p] === '*') {
      lastStar = p;
      starEnd = s;
      p++;
    } else if (p < P && (pattern[p] === '?' || pattern[p] === value[s])) {
      p++;
      s++;
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

/**
 * The matcher primitive behind {@link filterHandles}; exported for its own unit tests. Throws
 * `RangeError` for a pattern over {@link MAX_GLOB_LEN}.
 */
export function matchGlob(pattern: string, value: string): boolean {
  assertGlobLength(pattern);
  return globMatch(pattern, value);
}

/**
 * Keep the handles matching `filter`; an absent filter keeps them all, and one over
 * {@link MAX_GLOB_LEN} throws `RangeError`. A client that serialises an unset filter as `''` means
 * "no filter", so treat it as absent, so that the one answer a caller cannot tell apart from a real
 * outage — an empty roster — is never how an omitted or an illegal filter reads.
 */
export function filterHandles<T extends { handle: Handle }>(items: T[], filter?: string): T[] {
  if (filter === undefined || filter === '') return items;
  assertGlobLength(filter);
  return items.filter((i) => globMatch(filter, i.handle));
}
