/**
 * Glob filtering for handle listings (e.g. `parley_list_users({ filter: "claude-*" })`).
 *
 * The topic {@link Allowlist} is exact-set membership only — there is no shared glob matcher to
 * reuse — so this is the single small, dependency-free implementation. Case-sensitive: handles
 * are compared verbatim.
 *
 * Matching is a linear-time two-pointer wildcard walk (SEC-15), NOT a translated `RegExp`. A
 * caller-supplied `filter` is attacker-influenceable (one prompt-injection hop) and matched against
 * attacker-influenceable handles; the old `*`→`.*` translation backtracked catastrophically on
 * Node's engine — e.g. `'*'.repeat(40) + 'z'` against an ordinary handle hung the whole event loop
 * for ~47s, and a non-adjacent variant like `('*a'.repeat(8)) + 'b'` still hangs even after
 * collapsing adjacent `*`. The two-pointer walk has no backtracking blowup (a run of `*` behaves as
 * one — `**` === `*`), so any filter resolves in bounded time regardless of input; a hard length cap
 * is a belt-and-suspenders bound for absurd patterns.
 */
import type { Handle } from './message.js';

/**
 * Longest glob `filter` we will evaluate; a longer pattern matches nothing. Handles and their globs
 * are short in practice, so this only trips on pathological input. Mirrored by a `.max()` on the
 * `parley_list_users` `filter` schema so Zod rejects an over-long filter before it reaches here —
 * but `matchGlob`/`filterHandles` are library functions callable outside the tool path, so the bound
 * is enforced here too.
 */
export const MAX_GLOB_LEN = 256;

/**
 * Linear-time glob match: `*` = any run (incl. empty), `?` = exactly one char; every other char is a
 * literal (regex metacharacters included), full-anchored and case-sensitive. A greedy two-pointer
 * walk with a single backtrack to the most recent `*` — O(pattern×value) worst case, never the
 * exponential / high-degree-polynomial backtracking a `*`→`.*` `RegExp` translation suffers. An
 * over-long pattern is refused (matches nothing) as a defensive bound.
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern.length > MAX_GLOB_LEN) return false; // defensive: never evaluate an absurd pattern
  const P = pattern.length;
  const S = value.length;
  let p = 0;
  let s = 0;
  let star = -1; // index in `pattern` of the most recent `*`, or -1 if none seen yet
  let resume = 0; // where in `value` to resume from after that `*` when we backtrack
  while (s < S) {
    if (p < P && (pattern[p] === '?' || pattern[p] === value[s])) {
      p++;
      s++;
    } else if (p < P && pattern[p] === '*') {
      star = p; // let this `*` match zero chars for now; remember where to grow it
      resume = s;
      p++;
    } else if (star !== -1) {
      p = star + 1; // backtrack: make the last `*` absorb one more char
      resume++;
      s = resume;
    } else {
      return false;
    }
  }
  while (p < P && pattern[p] === '*') p++; // trailing `*`s match the empty remainder
  return p === P;
}

/** True if `value` matches the glob `pattern`. */
export function matchGlob(pattern: string, value: string): boolean {
  return globMatch(pattern, value);
}

/** Keep the handles matching `filter`; when `filter` is undefined, keep them all. */
export function filterHandles<T extends { handle: Handle }>(items: T[], filter?: string): T[] {
  if (filter === undefined) return items;
  return items.filter((i) => globMatch(filter, i.handle));
}
