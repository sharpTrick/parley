import { describe, expect, it } from 'vitest';
import { asHandle } from './message.js';
import { filterHandles, matchGlob, MAX_GLOB_LEN } from './identity-filter.js';

describe('matchGlob', () => {
  it('matches a prefix wildcard', () => {
    expect(matchGlob('claude-*', 'claude-payments')).toBe(true);
    expect(matchGlob('claude-*', 'claude-')).toBe(true);
    expect(matchGlob('claude-*', 'human-x')).toBe(false);
  });

  it('matches a suffix wildcard and a single-char ?', () => {
    expect(matchGlob('*-bot', 'chat-bot')).toBe(true);
    expect(matchGlob('*-bot', 'chat-boat')).toBe(false);
    expect(matchGlob('claude-?', 'claude-a')).toBe(true);
    expect(matchGlob('claude-?', 'claude-ab')).toBe(false);
  });

  it('anchors fully and treats other regex metachars as literals', () => {
    expect(matchGlob('ctx', 'ctx-payments')).toBe(false); // no implicit substring
    expect(matchGlob('a.b', 'a.b')).toBe(true);
    expect(matchGlob('a.b', 'axb')).toBe(false); // '.' is literal, not "any char"
    expect(matchGlob('a+b', 'a+b')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(matchGlob('Claude-*', 'claude-a')).toBe(false);
  });
});

describe('filterHandles', () => {
  const items = [
    { handle: asHandle('claude-a') },
    { handle: asHandle('claude-b') },
    { handle: asHandle('human-x') },
  ];

  it('returns all when filter is undefined', () => {
    expect(filterHandles(items)).toHaveLength(3);
  });

  it('applies the glob', () => {
    expect(filterHandles(items, 'claude-*').map((i) => i.handle)).toEqual(['claude-a', 'claude-b']);
  });
});

// SEC-15 — a caller-supplied `filter` is attacker-influenceable (one prompt-injection hop) and the
// old `*`→`.*` RegExp translation backtracked catastrophically: `'*'.repeat(40)+'z'` against an
// ordinary handle hung the event loop for ~47s. The linear two-pointer matcher must resolve any such
// filter in bounded wall-clock time while preserving glob semantics.
describe('glob ReDoS bounding (SEC-15)', () => {
  const NO_Z = asHandle('claude-agent-oncall-payments'); // 28 chars, contains no 'z'

  it('returns promptly (bounded time) for a star-flood filter with a trailing non-match', () => {
    for (const stars of [40, 20]) {
      const filter = '*'.repeat(stars) + 'z';
      const t0 = performance.now();
      const out = filterHandles([{ handle: NO_Z }], filter);
      const elapsed = performance.now() - t0;
      expect(out).toEqual([]); // 'z' absent ⇒ correct empty result
      expect(elapsed).toBeLessThan(100); // was ~47s on the unfixed `*`→`.*` translation
    }
  });

  it('returns promptly for NON-adjacent stars too (collapse-of-adjacent alone would not save this)', () => {
    // `.*a.*a…b` over an all-`a` run still explodes on a RegExp translation even after collapsing
    // adjacent `*`; the two-pointer walk stays linear.
    const filter = '*a'.repeat(30) + 'b';
    const t0 = performance.now();
    const out = filterHandles([{ handle: asHandle('a'.repeat(60)) }], filter);
    expect(out).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('collapses runs of `*` — `a***b` and `**` behave exactly like their single-star forms', () => {
    expect(matchGlob('a***b', 'axyzb')).toBe(matchGlob('a*b', 'axyzb'));
    expect(matchGlob('a***b', 'axyzb')).toBe(true);
    expect(matchGlob('**', 'anything')).toBe(true);
    expect(matchGlob('**', '')).toBe(true);
  });

  it('preserves glob semantics: `claude-*`, `?`, literal specials, and undefined⇒all', () => {
    expect(matchGlob('claude-*', 'claude-agent')).toBe(true);
    expect(matchGlob('claude-*', 'other')).toBe(false);
    expect(matchGlob('claude-?', 'claude-a')).toBe(true);
    expect(matchGlob('claude-?', 'claude-ab')).toBe(false);
    expect(matchGlob('a.b', 'a.b')).toBe(true); // '.' is literal, not "any char"
    expect(matchGlob('a.b', 'axb')).toBe(false);
    expect(matchGlob('a+b', 'a+b')).toBe(true); // '+' is literal, not a quantifier
    const items = [{ handle: asHandle('claude-a') }, { handle: asHandle('human-x') }];
    expect(filterHandles(items)).toHaveLength(2); // undefined ⇒ all
  });

  it('refuses an over-long filter (safe-empty) and returns fast', () => {
    const filter = '*'.repeat(MAX_GLOB_LEN + 50); // exceeds the length cap
    const t0 = performance.now();
    const out = filterHandles([{ handle: asHandle('anything') }], filter);
    expect(out).toEqual([]); // over the cap ⇒ matches nothing
    expect(matchGlob(filter, 'anything')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
