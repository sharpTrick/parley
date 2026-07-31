/**
 * The ONE corpus of (pattern source, candidate topic, is-a-full-match) rows every site that compiles
 * a regex source it did not author is graded against.
 *
 * Core anchors an untrusted source in exactly two places — the {@link Allowlist}'s `post_topics` and
 * `filterReachable`'s peer `postTopics` — and only the first was pinned, so dropping the `^(?:…)$`
 * wrapper from the second (the one fed by ATTACKER-supplied sources, where a peer advertising `ops`
 * would be reported as able to post into `my-ops-secret`) left the whole suite green. Anchoring is
 * one rule; grading it in one place per site is how the two drift apart.
 *
 * Keep this list single, so that a new anchoring site is registered against it rather than pinned by
 * a fresh copy that starts identical and stops being so.
 */
export const ANCHORING_CASES: readonly (readonly [
  label: string,
  source: string,
  input: string,
  fullMatch: boolean,
])[] = [
  ['bare substring must not match a longer topic', 'ops', 'my-ops-secret', false],
  ['bare substring matches only itself', 'ops', 'ops', true],
  ['leading substring must not match its extension', 'my', 'my-ops', false],
  ['trailing substring must not match its extension', 'ops', 'the-ops', false],
  ['a prefix pattern matches what it spans', 'my-.*', 'my-ops', true],
  ['a prefix pattern does not match past its prefix', 'my-.*', 'not-my-ops', false],
  ['unanchored alternation must not match a substring hit', 'a|b', 'xax', false],
  ['unanchored alternation matches a whole branch', 'a|b', 'b', true],
  ['an already-anchored source still matches itself', '^x$', 'x', true],
  ['an already-anchored source does not match a superstring', '^x$', 'yxy', false],
  ['an empty alternation branch does not match arbitrary text', 'a|', 'zz', false],
  ['match-everything really does match everything', '.*', 'anything-at-all', true],
] as const;
