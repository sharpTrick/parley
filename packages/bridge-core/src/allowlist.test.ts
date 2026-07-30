import { describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError, UnsafePatternError } from './allowlist.js';
import { MAX_MATCH_INPUT } from './regex-safety.js';

function compiles(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

describe('Allowlist', () => {
  const allow = new Allowlist(['ctx-payments', 'ctx-payments-reviews']);

  it('allows listed topics and brands them', () => {
    expect(allow.has('ctx-payments')).toBe(true);
    expect(allow.assert('ctx-payments')).toBe('ctx-payments');
  });

  it('rejects unlisted topics with TopicNotAllowedError', () => {
    expect(allow.has('secret')).toBe(false);
    expect(() => allow.assert('secret')).toThrow(TopicNotAllowedError);
  });

  it('exposes the branded topic set for subscribe', () => {
    expect(allow.topics().sort()).toEqual(['ctx-payments', 'ctx-payments-reviews']);
  });

  it('exposes no patterns by default', () => {
    expect(allow.patterns()).toEqual([]);
  });
});

describe('Allowlist post patterns', () => {
  const allow = new Allowlist(['ctx-a'], { postPatterns: ['ctx-.*', 'exp/[a-z]+'] });

  it('accepts a pattern-matched topic for post/fetch (full-match anchored)', () => {
    expect(allow.has('ctx-anything')).toBe(true);
    expect(allow.assert('exp/beta')).toBe('exp/beta');
  });

  it('anchors patterns — a partial match does not pass', () => {
    expect(allow.has('x-ctx-a')).toBe(false);
    expect(allow.has('ctx-a-suffix')).toBe(true); // ctx-.* still matches this
    expect(allow.has('exp/Beta')).toBe(false); // [a-z]+ excludes uppercase
  });

  it('does NOT widen the explicit topic set (subscribe/catch-up stay exact)', () => {
    expect(allow.topics()).toEqual(['ctx-a']);
  });

  it('round-trips the raw pattern sources', () => {
    expect(allow.patterns()).toEqual(['ctx-.*', 'exp/[a-z]+']);
  });
});

describe('Allowlist reserved topics', () => {
  it('refuses a reserved topic on post/fetch even when a pattern would match it', () => {
    const allow = new Allowlist(['ctx-a'], {
      postPatterns: ['.*'],
      reserved: ['parley-presence'],
    });
    expect(allow.has('parley-presence')).toBe(false);
    expect(() => allow.assert('parley-presence')).toThrow(TopicNotAllowedError);
    expect(allow.has('ctx-a')).toBe(true); // the broad pattern still allows non-reserved topics
  });

  it('throws when an explicit topic is also reserved (config error)', () => {
    expect(() => new Allowlist(['parley-presence'], { reserved: ['parley-presence'] })).toThrow(
      TopicNotAllowedError,
    );
  });

  // The over-long refusal and its message are graded at the clamp itself in stated-bounds.test.ts.
  it('refuses an unmatched topic without inventing a reason', () => {
    const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
    expect(() => allow.assert('nope')).toThrow(/^topic not allowed: "nope"$/);
  });
});

// `Allowlist` is public API: an embedder can construct one with patterns that never went through
// parseConfig, and `has` is then driven by a caller-supplied topic. Screen at BOTH ends — refuse
// the hostile source at construction, and bound the input the survivors ever see.
describe('Allowlist pattern safety', () => {
  // Which sources the constructor refuses is graded against the shared hostile/safe corpus, at every
  // layer that compiles an unauthored pattern, in regex-screen-parity.test.ts.
  it('refuses an unsafe source with UnsafePatternError, naming the pattern', () => {
    expect(() => new Allowlist(['ctx'], { postPatterns: ['([a-z]+)+'] })).toThrow(
      UnsafePatternError,
    );
    expect(() => new Allowlist(['ctx'], { postPatterns: ['([a-z]+)+'] })).toThrow(/\(\[a-z\]\+\)\+/);
  });

  // Two axes: pattern shape × topic length, each at a topic the pattern DOES match and one it does
  // not. A table of non-matching topics grades only the clamp, and the verdict is derived from
  // MAX_MATCH_INPUT rather than pinned false everywhere, so a clamp that swallowed a legal topic
  // (or a pattern that stopped matching) reddens here rather than shipping.
  const LENGTHS = [1, 8, 32, 63, MAX_MATCH_INPUT, MAX_MATCH_INPUT + 1, 256, 5000];
  const SAFE: readonly (readonly [string, string, (len: number) => string | undefined])[] = [
    ['plain broad pattern', 'ctx-.*', (len) => (len >= 4 ? `ctx-${'a'.repeat(len - 4)}` : undefined)],
    [
      'character class',
      'project-[a-z0-9-]+',
      (len) => (len >= 9 ? `project-${'a'.repeat(len - 8)}` : undefined),
    ],
    ['alternation', '(alpha|beta)-.*', (len) => (len >= 5 ? `beta-${'a'.repeat(len - 5)}` : undefined)],
    [
      'bounded repeat',
      'ctx-\\d{1,4}',
      (len) => (len >= 5 && len <= 8 ? `ctx-${'1'.repeat(len - 4)}` : undefined),
    ],
    ['four unbounded quantifiers', '.*.*.*.*x', (len) => `${'a'.repeat(len - 1)}x`],
  ] as const;

  const MATCH_ROWS = SAFE.flatMap(([label, pattern, matching]) =>
    LENGTHS.flatMap((len) => {
      const hit = matching(len);
      const rows: [string, string, string, boolean][] = [
        [`${label} @ ${len} (no match)`, pattern, `${'a'.repeat(len - 1)}!`, false],
      ];
      if (hit !== undefined)
        rows.push([`${label} @ ${len} (match)`, pattern, hit, len <= MAX_MATCH_INPUT]);
      return rows;
    }),
  );

  it('covers both verdicts on both sides of the clamp', () => {
    expect(MATCH_ROWS.filter(([, , , expected]) => expected).length).toBeGreaterThan(15);
    expect(MATCH_ROWS.filter(([label]) => label.includes('(match)')).length).toBeGreaterThan(25);
    expect(MATCH_ROWS.every(([, , topic]) => topic.length > 0)).toBe(true);
  });

  it.each(MATCH_ROWS)(
    'bounds match work and answers correctly (%s)',
    (_label, pattern, topic, expected) => {
      const allow = new Allowlist(['ctx'], { postPatterns: [pattern] });
      const started = Date.now();
      expect(allow.has(topic)).toBe(expected);
      expect(Date.now() - started).toBeLessThan(100);
    },
  );

  // The constructor validates the bare source but matches with `^(?:src)$`. An unbalanced source is
  // uncompilable alone yet LEGAL once wrapped, because the anchors re-associate into one branch of an
  // unanchored alternation — `ops)|(.*` becomes `/^(?:ops)|(.*)$/`, which matches every topic. So a
  // config line that reads as narrow mints an allow-everything post/fetch set.
  const WRAP_ESCAPING = ['ops)|(.*', 'a)|(.*', 'a)(b', 'x)$|^(', '(a', 'a|b)', ')(', '[a', 'a\\'];

  it.each(WRAP_ESCAPING)('refuses a source that only compiles once wrapped (%s)', (src) => {
    expect(() => new Allowlist(['ctx'], { postPatterns: [src] })).toThrow(SyntaxError);
  });

  it('never widens the post set beyond the source, however the source is shaped', () => {
    const widened = WRAP_ESCAPING.filter((src) => {
      try {
        return new Allowlist(['ctx'], { postPatterns: [src] }).has('secret-topic');
      } catch {
        return false;
      }
    });
    expect(widened).toEqual([]);
  });

  it('accepts a source only if it compiles on its own', () => {
    const safe = SAFE.map(([, pattern]) => pattern);
    const candidates = [
      ...safe,
      ...safe.flatMap((src) => [src.slice(0, -1), src.slice(0, -2), src.slice(1)]),
      ...WRAP_ESCAPING,
    ].filter((src) => src.length > 0);
    const accepted = candidates.filter((src) => {
      try {
        new Allowlist(['ctx'], { postPatterns: [src] });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted.filter((src) => !compiles(src))).toEqual([]);
    expect(accepted).toEqual(expect.arrayContaining(safe));
  });
});
