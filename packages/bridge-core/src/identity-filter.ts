/**
 * Glob filtering for handle listings (e.g. `parley_list_users({ filter: "claude-*" })`).
 *
 * The topic {@link Allowlist} is exact-set membership only — there is no shared glob matcher to
 * reuse — so this is the single small, dependency-free implementation. Case-sensitive: handles
 * are compared verbatim.
 */
import type { Handle } from './message.js';

/** Translate a glob (`*` = any run, `?` = one char) to an anchored RegExp; all else is literal. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True if `value` matches the glob `pattern`. */
export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

/** Keep the handles matching `filter`; when `filter` is undefined, keep them all. */
export function filterHandles<T extends { handle: Handle }>(items: T[], filter?: string): T[] {
  if (filter === undefined) return items;
  const re = globToRegExp(filter);
  return items.filter((i) => re.test(i.handle));
}
