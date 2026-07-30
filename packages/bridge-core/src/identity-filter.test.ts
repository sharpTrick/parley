import { describe, expect, it } from 'vitest';
import { asHandle } from './message.js';
import { filterHandles, matchGlob, MAX_GLOB_LEN } from './identity-filter.js';

// Semantics the generated corpus below cannot reach: literals outside its {a,b} alphabet, regex
// metacharacters, and case. Backtracking is graded there, exhaustively, and is deliberately not
// restated here.
describe('matchGlob semantics beyond the generated corpus', () => {
  it.each([
    ['claude-*', 'claude-payments', true],
    ['claude-*', 'claude-', true],
    ['claude-*', 'human-x', false],
    ['*-bot', 'chat-bot', true],
    ['*-bot', 'chat-boat', false],
    ['claude-?', 'claude-a', true],
    ['claude-?', 'claude-ab', false],
    ['ctx', 'ctx-payments', false],
    ['a.b', 'a.b', true],
    ['a.b', 'axb', false],
    ['a+b', 'a+b', true],
    ['a+b', 'aab', false],
    ['Claude-*', 'claude-a', false],
    ['a***b', 'axyzb', true],
    ['a*b', 'axyzb', true],
    ['**', 'anything', true],
  ])('matchGlob(%j, %j) === %s', (pattern, value, expected) => {
    expect(matchGlob(pattern, value)).toBe(expected);
  });
});

// The two-pointer walk is only correct if it agrees with the definition of a glob everywhere, and
// the arm that decides that is the backtrack: a hand-written table keeps landing on inputs the
// greedy first pass already resolves. Grade the whole matcher against an exhaustive reference over
// a corpus dense in re-grown stars, so a resume/off-by-one anywhere in the walk reddens this.
describe('matchGlob agrees with an exhaustive reference matcher', () => {
  function referenceMatch(pattern: string, value: string): boolean {
    if (pattern.length === 0) return value.length === 0;
    if (pattern[0] === '*') {
      for (let take = 0; take <= value.length; take++) {
        if (referenceMatch(pattern.slice(1), value.slice(take))) return true;
      }
      return false;
    }
    if (value.length === 0) return false;
    if (pattern[0] !== '?' && pattern[0] !== value[0]) return false;
    return referenceMatch(pattern.slice(1), value.slice(1));
  }

  function words(alphabet: string[], maxLen: number): string[] {
    let level = [''];
    const all = [''];
    for (let len = 0; len < maxLen; len++) {
      level = level.flatMap((w) => alphabet.map((c) => w + c));
      all.push(...level);
    }
    return all;
  }

  const PATTERNS = words(['a', 'b', '*', '?'], 5);
  const VALUES = words(['a', 'b'], 5);

  it('generates a corpus wide enough to reach the backtrack arm', () => {
    expect(PATTERNS.length).toBe(1365);
    expect(VALUES.length).toBe(63);
    expect(PATTERNS).toContain('*ab');
    expect(VALUES).toContain('aaab');
  });

  it('never disagrees over the whole pattern × value corpus', () => {
    const disagreements: string[] = [];
    for (const pattern of PATTERNS) {
      for (const value of VALUES) {
        const got = matchGlob(pattern, value);
        if (got !== referenceMatch(pattern, value))
          disagreements.push(`matchGlob(${JSON.stringify(pattern)}, ${JSON.stringify(value)}) === ${got}`);
      }
    }
    expect(disagreements.slice(0, 10), `${disagreements.length} disagreement(s)`).toEqual([]);
  });
});

describe('filterHandles', () => {
  const items = [
    { handle: asHandle('claude-a') },
    { handle: asHandle('claude-b') },
    { handle: asHandle('human-x') },
  ];

  it('applies the glob', () => {
    expect(filterHandles(items, 'claude-*').map((i) => i.handle)).toEqual(['claude-a', 'claude-b']);
  });

  // An optional string has exactly two legal readings — absent, or a value that narrows. The third
  // behaviour, silently returning nothing, is the one a caller cannot tell apart from "nobody is
  // reachable", and `''` is what a client that serialises an unset field sends. The tool schema
  // accepts it (`.max` with no `.min`), so every spelling of "unset" must land on the same answer.
  const OMITTED = [
    ['omitted', undefined],
    ['empty string', ''],
  ] as const;

  it.each(OMITTED)('keeps every handle when the filter is %s', (_label, filter) => {
    expect(filterHandles(items, filter)).toEqual(items);
  });

  it('still narrows for a filter that names something, so "keep all" is not the only answer', () => {
    expect(filterHandles(items, 'human-*')).toEqual([{ handle: asHandle('human-x') }]);
    expect(filterHandles(items, 'nobody-*')).toEqual([]);
  });
});

// A `filter` is caller-supplied and matched against caller-influenced handles, so every pattern
// shape must resolve in bounded time — one row per shape a `*`→`.*` translation blows up on.
describe('glob filtering is bounded for hostile patterns', () => {
  const NO_Z = asHandle('claude-agent-oncall-payments'); // 28 chars, contains no 'z'
  const ALL_A = asHandle('a'.repeat(60));

  it.each([
    ['star flood, trailing non-match', '*'.repeat(40) + 'z', NO_Z],
    ['shorter star flood', '*'.repeat(20) + 'z', NO_Z],
    ['non-adjacent stars over a uniform run', '*a'.repeat(30) + 'b', ALL_A],
    ['star/? mix over a uniform run', '*?a'.repeat(20) + 'b', ALL_A],
  ])('resolves promptly and empty (%s)', (_label, filter, handle) => {
    const started = performance.now();
    const out = filterHandles([{ handle }], filter);
    expect(out).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('refuses an over-long filter (safe-empty) and returns fast', () => {
    const filter = '*'.repeat(MAX_GLOB_LEN + 50);
    const started = performance.now();
    expect(filterHandles([{ handle: asHandle('anything') }], filter)).toEqual([]);
    expect(matchGlob(filter, 'anything')).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
