import { describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError } from './allowlist.js';

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

  // The topic is caller-supplied, so however a pattern was written, matching must stay bounded.
  // Guard the class: any over-long input, against any pattern, returns fast and fails closed.
  it.each([
    ['nested quantifier', '([a-z]+)+'],
    ['alternation under a quantifier', '(a|a)*'],
    ['many unbounded quantifiers', '.*.*.*.*.*'],
    ['plain broad pattern', 'ctx-.*'],
  ])('bounds match work against a hostile over-long topic (%s)', (_label, pattern) => {
    const allow = new Allowlist(['ctx'], { postPatterns: [pattern] });
    const hostile = 'a'.repeat(5000) + '!';
    const started = Date.now();
    expect(allow.has(hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('still matches ordinary topics up to the input bound', () => {
    const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
    expect(allow.has(`ctx-${'a'.repeat(59)}`)).toBe(true); // 63 chars, under the 64 cap
    expect(allow.has(`ctx-${'a'.repeat(80)}`)).toBe(false); // over it, refused rather than matched
  });
});
