import { describe, expect, it } from 'vitest';
import { Allowlist, allowlistFor } from './allowlist.js';
import { MAX_POST_TOPICS, parseConfig } from './config.js';
import { isRedosSafeSource, MAX_AMBIGUITY, MAX_MATCH_INPUT } from './regex-safety.js';
import { HOSTILE_PATTERNS, SAFE_PATTERNS } from './testing/regex-corpus.js';

// The screen's only real contract: whatever it accepts must MATCH in bounded time, for every input
// a caller can reach it with. Enumerating blowup shapes is not enough — the class this guards is
// "a source whose backtracking is exponential without containing a nested quantifier at all"
// (alternation chains, optional-atom chains), which no quantifier-counting screen can see.
// Generous on purpose. The defect is EXPONENTIAL — the shapes this guards take seconds, or never
// return — so three orders of magnitude of headroom costs no detection power, while a tight bound
// fails on scheduler jitter instead: 50ms flaked at 59ms and 81ms under full-suite CPU contention,
// which is a red suite that says nothing about the screen.
const PER_MATCH_BUDGET_MS = 500;

const chain = (unit: string, n: number): string => unit.repeat(n);

// Accept/refuse verdicts are graded in regex-screen-parity.test.ts against the shared corpus, at
// every layer that compiles an unauthored source. What is graded HERE is the match cost of what the
// screen lets through, so the corpus is that same list plus the same families at INTERMEDIATE
// repetition counts — the accepted-but-nearly-hostile region, which is where a mis-calibrated
// budget shows up.
const CORPUS: string[] = [
  ...SAFE_PATTERNS.map(([, src]) => src),
  ...HOSTILE_PATTERNS.map(([, src]) => src),
  ...[2, 3, 4, 5, 6].map((n) => chain('.*', n) + 'x'),
  ...[2, 4].map((n) => chain('[a-z]*', n) + 'x'),
  ...[2, 4, 8, 16, 20, 30].map((n) => chain('(a|aa)', n) + 'b'),
  ...[4, 16, 30].map((n) => chain('(.|..)', n) + 'z'),
  ...[4, 16, 24].map((n) => chain('(a|b|ab)', n) + 'z'),
  ...[4, 16, 24].map((n) => chain('(?:a|aa)', n) + 'b'),
  ...[4, 16].map((n) => chain('([ab]|[ab][ab])', n) + 'z'),
  ...[4, 12, 20, 24].map((n) => chain('a?', n) + chain('a', n) + 'b'),
  ...[4, 12, 20].map((n) => chain('[ab]?', n) + chain('a', n) + 'z'),
  ...[2, 4, 8, 16].map((n) => chain('[ab]{1,3}', n) + 'z'),
  ...[2, 6, 12].map((n) => chain('a{0,2}', n) + chain('a', n) + 'z'),
];

const HOSTILE = HOSTILE_PATTERNS.map(([label, src]) => [label, src] as [string, string]);

// The screen hand-rolls the regex grammar, so anything it mis-parses hides the rest of the source
// from it. Character classes are the trap: under PCRE a leading `]` joins the class, under V8 it
// CLOSES it, and a scanner that guesses wrong hunts for a `]` that is not coming. Generate the
// class-shaped openings rather than listing them, so the next such form is graded unnamed.
const CLASS_PREFIXES: string[] = ['\\[', '\\]', '\\\\']
  .concat(
    ['', '^'].flatMap((negate) =>
      ['', ']', ']]', 'a', 'a-z', '\\]', '\\\\'].map((body) => `[${negate}${body}]`),
    ),
  )
  .filter((prefix) => {
    try {
      new RegExp(prefix);
      return true;
    } catch {
      return false;
    }
  });

const CLASS_SUFFIXES = ['', ']', 'x]', ']]'];

/** Truncations are how an unterminated class, group or escape reaches the screen. */
const TRUNCATIONS: string[] = CORPUS.flatMap((src) => [src.slice(0, -1), src.slice(0, -2)]).filter(
  (src) => src.length > 0,
);

function compiles(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

/** Every character that can change how the hand-rolled scan parses what follows it. */
const META = [
  'a', '.', '*', '+', '?', '|', '(', ')', '[', ']', '{', '}', ',', '1', '2', '\\', '^', '$', 'b',
  ':', '=', '!',
];

/** Every source of length 1…maxLen over {@link META}. */
function enumerateSources(maxLen: number): string[] {
  let level = [''];
  const out: string[] = [];
  for (let len = 0; len < maxLen; len++) {
    level = level.flatMap((prefix) => META.map((c) => prefix + c));
    out.push(...level);
  }
  return out;
}

/**
 * Every kind of atom crossed with every quantifier spelling — including the ones a random sample of
 * a 22-character alphabet will never land on, such as a reversed `{3,2}` or a doubled `**`, and the
 * ones with no atom in front of them at all.
 */
function quantifierShapes(): string[] {
  const atoms = ['', 'a', '.', '\\d', '\\b', '[ab]', '(a)', '(?:a)', '(?=a)', '^', '$'];
  const quantifiers = [
    '', '*', '+', '?', '**', '*?', '*+', '??', '+?', '+*', '{2}', '{2,}', '{2,3}', '{3,2}', '{2,1}',
    '{0,0}', '{1}', '{,2}', '{2,}?', '{}', '{a}', '{2}{3}', '{2}*',
  ];
  return atoms.flatMap((atom) =>
    quantifiers.flatMap((q) => [atom + q, `${atom}${q}x`, `x${atom}${q}`]),
  );
}

/** Longer sources, sampled deterministically so a failure is reproducible without a fixture file. */
function sampleSources(count: number, minLen: number, maxLen: number): string[] {
  let seed = 0x2f6e2b1;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = minLen + (next() % (maxLen - minLen + 1));
    let src = '';
    for (let j = 0; j < len; j++) src += META[next() % META.length]!;
    out.push(src);
  }
  return out;
}

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

  it('rejects every blowup shape hidden behind a character class', () => {
    const leaked = CLASS_PREFIXES.flatMap((prefix) =>
      HOSTILE.flatMap(([label, src]) =>
        // A later `]` is what lets a mis-parsed class swallow the shape WHOLE and still terminate;
        // without one the scan merely runs off the end, which a fail-closed screen catches anyway.
        CLASS_SUFFIXES.map(
          (suffix) => [`${prefix} + ${label} + ${suffix}`, prefix + src + suffix] as const,
        ),
      )
        .filter(([, src]) => isRedosSafeSource(src))
        .map(([label]) => label),
    );
    expect(leaked).toEqual([]);
  });

  // The screen's doc promises everything it accepts also compiles on its own, and that promise is
  // the argument a future reader would use to delete allowlist.ts's assertCompilesAlone. A
  // hand-picked candidate list cannot reach the shapes that break it — a quantifier with nothing to
  // repeat (`*a`, `a**`, `^?`) or a reversed `{n,m}` — so enumerate the metacharacter alphabet.
  it('never accepts a source that does not compile on its own', () => {
    const candidates = [
      ...CORPUS,
      ...TRUNCATIONS,
      ...CLASS_PREFIXES.map((p) => p + '.*'),
      ...enumerateSources(3),
      ...quantifierShapes(),
      ...sampleSources(30_000, 4, 8),
    ];
    const uncompilable = candidates.filter((src) => !compiles(src));
    // Floors, so that a shrunken or mis-seeded generator cannot pass by enumerating only sources
    // that trivially compile: the interesting region is the one V8 refuses.
    expect(candidates.length).toBeGreaterThan(40_000);
    expect(uncompilable.length).toBeGreaterThan(2_000);
    const leaked = [...new Set(candidates.filter((src) => isRedosSafeSource(src) && !compiles(src)))];
    expect(leaked.slice(0, 20), `${leaked.length} accepted source(s) do not compile`).toEqual([]);
  });
});

// MAX_AMBIGUITY bounds ONE source. `Allowlist.has` runs every compiled pattern against the same
// caller-supplied topic, so a post/reply/fetch pays that bound once PER SOURCE — an uncapped
// collection makes a per-source calibration meaningless. Fill the collection to its documented
// maximum with the worst source the screen accepts AT the bound, derived from the constants so
// raising either constant re-grades this instead of silently widening the hole.
describe('a screened collection is bounded in aggregate, not only per source', () => {
  const WORST = chain('[ab]?', Math.log2(MAX_AMBIGUITY)) + chain('a', 16) + 'z';
  const ADVERSARIAL = 'a'.repeat(MAX_MATCH_INPUT);
  const AGGREGATE_BUDGET_MS = 1_000;

  it('the source really sits at the ambiguity bound', () => {
    expect(Number.isInteger(Math.log2(MAX_AMBIGUITY))).toBe(true);
    expect(isRedosSafeSource(WORST)).toBe(true);
    expect(isRedosSafeSource(`[ab]?${WORST}`)).toBe(false);
  });

  // The cap has to live at the class that owns the screen, not only at the loader: `Allowlist` is
  // exported public API, so an embedder builds one WITHOUT parseConfig and inherits the per-source
  // calibration with no aggregate at all (64 copies of WORST cost 34 ms, 20 000 cost 7.5 s of blocked
  // event loop). Grade both entry points from one table, so a bound enforced at only one of them is
  // a red row rather than an invisible hole.
  const ENTRY_POINTS: readonly (readonly [
    label: string,
    build: (patterns: string[]) => Allowlist,
  ])[] = [
    [
      'new Allowlist({ postPatterns })',
      (patterns) => new Allowlist(['ctx'], { postPatterns: patterns }),
    ],
    [
      'allowlistFor(parseConfig({ post_topics }))',
      (patterns) =>
        allowlistFor(
          parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], post_topics: patterns }),
        ),
    ],
  ] as const;

  it('grades every entry point that compiles a screened collection', () => {
    expect(ENTRY_POINTS.map(([label]) => label)).toEqual([
      'new Allowlist({ postPatterns })',
      'allowlistFor(parseConfig({ post_topics }))',
    ]);
  });

  it.each(ENTRY_POINTS)(
    'a collection AT the cap stays inside the aggregate budget (%s)',
    (_l, build) => {
      const allow = build(Array.from({ length: MAX_POST_TOPICS }, () => WORST));
      expect(allow.patterns()).toHaveLength(MAX_POST_TOPICS);
      const started = performance.now();
      expect(allow.has(ADVERSARIAL)).toBe(false);
      expect(performance.now() - started).toBeLessThan(AGGREGATE_BUDGET_MS);
    },
  );

  it.each(ENTRY_POINTS)('refuses one pattern past the cap (%s)', (_l, build) => {
    const overCap = Array.from({ length: MAX_POST_TOPICS + 1 }, (_, i) => `ctx-${i}-.*`);
    expect(() => build(overCap)).toThrow(new RegExp(`${MAX_POST_TOPICS}`));
  });

  it('the loader names the offending field, so the operator error stays better located', () => {
    const overCap = Array.from({ length: MAX_POST_TOPICS + 1 }, (_, i) => `ctx-${i}-.*`);
    let issuePaths: unknown[][] = [];
    try {
      parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], post_topics: overCap });
    } catch (e) {
      issuePaths = (e as { issues?: { path: unknown[] }[] }).issues?.map((i) => i.path) ?? [];
    }
    expect(issuePaths).toContainEqual(['post_topics']);
  });
});
