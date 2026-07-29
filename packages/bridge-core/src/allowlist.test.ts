import { describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError, UnsafePatternError } from './allowlist.js';

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

  it('still matches ordinary topics up to the input bound', () => {
    const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
    expect(allow.has(`ctx-${'a'.repeat(59)}`)).toBe(true); // 63 chars, under the 64 cap
    expect(allow.has(`ctx-${'a'.repeat(80)}`)).toBe(false); // over it, refused rather than matched
  });

  it('says WHY an over-long topic was refused instead of just "not allowed"', () => {
    const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
    expect(() => allow.assert(`ctx-${'a'.repeat(80)}`)).toThrow(/at most 64 characters/);
    expect(() => allow.assert('nope')).toThrow(/^topic not allowed: "nope"$/);
  });
});

// `Allowlist` is public API: an embedder can construct one with patterns that never went through
// parseConfig, and `has` is then driven by a caller-supplied topic. Screen at BOTH ends — refuse
// the hostile source at construction, and bound the input the survivors ever see.
describe('Allowlist pattern safety', () => {
  const HOSTILE = [
    ['nested quantifier', '([a-z]+)+'],
    ['alternation under a quantifier', '(a|a)*'],
    ['bounded repeat over a risky body', '([a-z]*){15}'],
    ['many unbounded quantifiers', '.*.*.*.*.*'],
    ['ambiguous alternation chain', `${'(a|aa)'.repeat(30)}b`],
    ['ambiguous alternation chain (dot)', `${'(.|..)'.repeat(30)}z`],
    ['optional-atom chain', `${'a?'.repeat(24)}${'a'.repeat(24)}b`],
  ] as const;

  it.each(HOSTILE)('refuses to compile a pattern that can blow up (%s)', (_label, pattern) => {
    expect(() => new Allowlist(['ctx'], { postPatterns: [pattern] })).toThrow(UnsafePatternError);
  });

  // Two axes: pattern shape × topic length. Lengths UNDER the input clamp are the ones that grade
  // the matcher — `has` refuses anything over it before a regex runs, so a table of over-long
  // topics alone only grades the clamp.
  const LENGTHS = [1, 8, 32, 63, 64, 65, 256, 5000];
  const SAFE = [
    ['plain broad pattern', 'ctx-.*'],
    ['character class', 'project-[a-z0-9-]+'],
    ['alternation', '(alpha|beta)-.*'],
    ['bounded repeat', 'ctx-\\d{1,4}'],
    ['four unbounded quantifiers', '.*.*.*.*x'],
  ] as const;

  it.each(
    SAFE.flatMap(([label, pattern]) => LENGTHS.map((len) => [`${label} @ ${len}`, pattern, len])),
  )('bounds match work for any topic length (%s)', (_label, pattern, len) => {
    const allow = new Allowlist(['ctx'], { postPatterns: [pattern as string] });
    const topic = 'a'.repeat((len as number) - 1) + '!';
    const started = Date.now();
    expect(allow.has(topic)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

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
