/**
 * The ONE corpus of regex sources every layer that compiles a pattern it did not author is graded
 * against: {@link isRedosSafeSource} itself, the {@link Allowlist} constructor an embedder can call
 * directly, and `parseConfig`'s `post_topics` validation an operator hits at load.
 *
 * Keep this list single, so that widening the class widens every layer at once — the same corpus was
 * restated in three test files with three different memberships, and the config load path (the one
 * an operator actually reaches) was missing exactly the quantifier-free chain shapes the screen
 * exists for.
 */

const chain = (unit: string, n: number): string => unit.repeat(n);

/** Sources that MUST be refused by every screening entry point. */
export const HOSTILE_PATTERNS: readonly (readonly [label: string, src: string])[] = [
  ['nested quantifier', '([a-z]+)+'],
  ['nested star', '(a*)*'],
  ['alternation under a quantifier', '(a|a)*'],
  ['bounded repeat over a risky body', '([a-z]*){15}'],
  ['optional group repeated many times', '(a?){250}'],
  ['ambiguous alternation under a plus', '(a|aa)+'],
  ['ambiguous alternation under a bounded repeat', '(?:a|aa){8}'],
  ['ambiguous alternation at the smallest compounding repeat', '(?:a|aa){2}'],
  ['risky body at the smallest compounding repeat', '(?:[a-z]*[a-z]*[a-z]*[a-z]*){2}'],
  ['too many unbounded quantifiers', '.*.*.*.*.*'],
  ['too many class quantifiers', chain('[a-z]*', 5) + 'x'],
  ['ambiguous alternation chain', `${chain('(a|aa)', 30)}b`],
  ['ambiguous alternation chain (dot)', `${chain('(.|..)', 30)}z`],
  ['ambiguous alternation chain (non-capturing)', `${chain('(?:a|aa)', 24)}b`],
  ['three-branch alternation chain', `${chain('(a|b|ab)', 24)}z`],
  ['class-alternation chain', `${chain('([ab]|[ab][ab])', 20)}z`],
  ['optional-atom chain', `${chain('a?', 24)}${chain('a', 24)}b`],
  ['optional-class chain', `${chain('[ab]?', 20)}${chain('a', 20)}z`],
  ['bounded-repeat chain', `${chain('[ab]{1,3}', 16)}z`],
  ['bounded-repeat chain (backtrackable min)', `${chain('a{0,2}', 12)}${chain('a', 12)}z`],
] as const;

/**
 * Ordinary topic patterns that MUST stay accepted by every screening entry point — an over-strict
 * screen locks an operator out of `post_topics` just as surely as a leaky one hangs the bridge.
 */
export const SAFE_PATTERNS: readonly (readonly [label: string, src: string])[] = [
  ['plain broad pattern', 'ctx-.*'],
  ['match everything', '.*'],
  ['character class', 'project-[a-z0-9-]+'],
  ['alternation', '(alpha|beta)-.*'],
  ['non-capturing alternation', '(?:ops|dev|qa)-[a-z]+'],
  ['ambiguous alternation at the non-compounding bound', '(?:a|aa){1}'],
  ['ambiguous alternation made merely optional', '(?:a|aa)?'],
  ['bounded repeat', 'ctx-\\d{1,4}'],
  ['slash-separated', 'exp/[a-z]+'],
  ['eight-branch alternation with a bounded repeat', '(a|b|c|d|e|f|g|h)-[0-9]{2}'],
  ['four unbounded quantifiers', '.*.*.*.*x'],
  ['lazy quantifiers', '.*?.*?x'],
  ['escaped metacharacters', '\\(a\\|aa\\)\\(a\\|aa\\)'],
  ['metacharacters inside a class', '[*+?{}()|]+'],
  ['escaped bracket inside a class', '[\\]]*x'],
] as const;
