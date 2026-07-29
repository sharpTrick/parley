import { describe, expect, it } from 'vitest';
import { isRedosSafeSource, MAX_MATCH_INPUT } from './regex-safety.js';

// The screen's only real contract: whatever it accepts must MATCH in bounded time, for every input
// a caller can reach it with. Enumerating blowup shapes is not enough — the class this guards is
// "a source whose backtracking is exponential without containing a nested quantifier at all"
// (alternation chains, optional-atom chains), which no quantifier-counting screen can see.
const PER_MATCH_BUDGET_MS = 50;

const chain = (unit: string, n: number): string => unit.repeat(n);

const CORPUS: string[] = [
  // Ordinary topic patterns — these MUST stay accepted (an over-strict screen is a bug too).
  'ctx-.*',
  'project-[a-z0-9-]+',
  '(alpha|beta)-.*',
  'ctx-\\d{1,4}',
  'exp/[a-z]+',
  '.*',
  '(a|b|c|d|e|f|g|h)-[0-9]{2}',
  // Nested / repeated ambiguous bodies (the classic shapes).
  '([a-z]+)+',
  '(a*)*',
  '(a|a)*',
  '([a-z]*){15}',
  '(a?){250}',
  '(a|aa)+',
  '(?:a|aa){8}',
  // Sequential unbounded quantifiers.
  ...[2, 3, 4, 5, 6].map((n) => chain('.*', n) + 'x'),
  ...[2, 4].map((n) => chain('[a-z]*', n) + 'x'),
  '.*?.*?x',
  // Ambiguous alternation chains — quantifier-free, exponential.
  ...[2, 4, 8, 16, 20, 30].map((n) => chain('(a|aa)', n) + 'b'),
  ...[4, 16, 30].map((n) => chain('(.|..)', n) + 'z'),
  ...[4, 16, 24].map((n) => chain('(a|b|ab)', n) + 'z'),
  ...[4, 16, 24].map((n) => chain('(?:a|aa)', n) + 'b'),
  ...[4, 16].map((n) => chain('([ab]|[ab][ab])', n) + 'z'),
  // Optional-atom chains — also quantifier-free and exponential.
  ...[4, 12, 20, 24].map((n) => chain('a?', n) + chain('a', n) + 'b'),
  ...[4, 12, 20].map((n) => chain('[ab]?', n) + chain('a', n) + 'z'),
  // Bounded repeats that unroll into ambiguity.
  ...[2, 4, 8, 16].map((n) => chain('[ab]{1,3}', n) + 'z'),
  ...[2, 6, 12].map((n) => chain('a{0,2}', n) + chain('a', n) + 'z'),
  // Escapes and classes the parser must treat as literal.
  '\\(a\\|aa\\)\\(a\\|aa\\)',
  '[*+?{}()|]+',
  '[\\]]*x',
];

/** Inputs drawn from the pattern's own literal alphabet, at every length up to the caller clamp. */
function inputsFor(src: string): string[] {
  const literals = new Set(src.match(/[A-Za-z0-9]/g) ?? []);
  const alphabet = [...literals, 'a', 'b', 'z'].slice(0, 4);
  const lengths = [0, 1, 2, 3, 5, 8, 13, 21, 32, 45, 63, MAX_MATCH_INPUT];
  const out: string[] = [];
  for (const len of lengths) {
    for (const c of alphabet) {
      out.push(c.repeat(len));
      out.push(c.repeat(Math.max(0, len - 1)) + '!');
      out.push(alphabet.join('').repeat(len).slice(0, len));
    }
  }
  return out;
}

describe('isRedosSafeSource', () => {
  it.each(CORPUS.map((src) => [src.length > 48 ? `${src.slice(0, 45)}…` : src, src]))(
    'an accepted source matches in bounded time for every reachable input (%s)',
    (_label, src) => {
      if (!isRedosSafeSource(src)) return;
      const re = new RegExp(`^(?:${src})$`);
      for (const input of inputsFor(src)) {
        expect(input.length).toBeLessThanOrEqual(MAX_MATCH_INPUT);
        const started = process.hrtime.bigint();
        re.test(input);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        expect(ms, `${src} vs ${input.length}-char input`).toBeLessThan(PER_MATCH_BUDGET_MS);
      }
    },
    60_000,
  );

  it.each([
    ['ctx-.*'],
    ['project-[a-z0-9-]+'],
    ['(alpha|beta)-.*'],
    ['ctx-\\d{1,4}'],
    ['exp/[a-z]+'],
    ['(a|b|c|d|e|f|g|h)-[0-9]{2}'],
    ['(?:ops|dev|qa)-[a-z]+'],
    ['\\(a\\|aa\\)\\(a\\|aa\\)'],
  ])('accepts an ordinary topic pattern (%s)', (src) => {
    expect(isRedosSafeSource(src)).toBe(true);
  });

  it.each([
    ['nested quantifier', '([a-z]+)+'],
    ['alternation under a quantifier', '(a|a)*'],
    ['bounded repeat over a risky body', '([a-z]*){15}'],
    ['optional group repeated many times', '(a?){250}'],
    ['too many unbounded quantifiers', '.*.*.*.*.*'],
    ['ambiguous alternation chain', `${chain('(a|aa)', 30)}b`],
    ['ambiguous alternation chain (dot)', `${chain('(.|..)', 30)}z`],
    ['ambiguous alternation chain (non-capturing)', `${chain('(?:a|aa)', 24)}b`],
    ['three-branch alternation chain', `${chain('(a|b|ab)', 24)}z`],
    ['optional-atom chain', `${chain('a?', 24)}${chain('a', 24)}b`],
    ['optional-class chain', `${chain('[ab]?', 20)}${chain('a', 20)}z`],
    ['bounded-repeat chain', `${chain('[ab]{1,3}', 16)}z`],
  ])('rejects a source that can blow up (%s)', (_label, src) => {
    expect(isRedosSafeSource(src)).toBe(false);
  });
});
