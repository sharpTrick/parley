import { describe, expect, it } from 'vitest';
import { asHandle } from './message.js';
import { filterHandles, matchGlob, MAX_GLOB_LEN } from './identity-filter.js';

// Semantics the generated corpus below cannot reach: literals outside its {a,b,*,?} alphabet, regex
// metacharacters, and case. Backtracking is graded there, exhaustively, and is deliberately not
// restated here. The glob metacharacters appear as VALUE literals so a failure names the shape.
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
    ['*', '*ops', true],
    ['a*', 'a*b', true],
    ['*', '**', true],
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

  // A glob metacharacter is only special on the PATTERN side; on the value side it is an ordinary
  // character a handle may legally contain. Both alphabets therefore carry `*` and `?`, so the
  // corpus reaches the case where the two sides line up and a literal can be mistaken for a wildcard.
  const PATTERNS = words(['a', 'b', '*', '?'], 5);
  const VALUES = words(['a', 'b', '*', '?'], 4);

  it('generates a corpus wide enough to reach the backtrack arm', () => {
    expect(PATTERNS.length).toBe(1365);
    expect(VALUES.length).toBe(341);
    expect(PATTERNS).toContain('*ab');
    expect(VALUES).toContain('aaab');
    expect(VALUES).toContain('*ab');
    expect(VALUES).toContain('?ab');
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

// A roster-shaping input has exactly three honest answers: keep everyone (no filter), narrow to
// what the glob names, or REFUSE. The fourth behaviour — quietly returning nothing for an input the
// layer considers illegal — is the one a caller cannot tell apart from "nobody is reachable", so no
// illegal input may be answered at all. `''` is what a client that serialises an unset field sends
// and the tool schema accepts it (`.max` with no `.min`), so it is a legal spelling of "unset";
// anything over MAX_GLOB_LEN the schema rejects outright, and this layer must agree by throwing.
describe('filterHandles', () => {
  const items = [
    { handle: asHandle('claude-a') },
    { handle: asHandle('claude-b') },
    { handle: asHandle('human-x') },
  ];

  interface RosterInput {
    label: string;
    filter: string | undefined;
    verdict: 'keep-all' | 'narrowed' | 'refused';
    kept: string[];
  }

  const ALL = ['claude-a', 'claude-b', 'human-x'];

  const ROSTER_INPUTS: RosterInput[] = [
    { label: 'omitted', filter: undefined, verdict: 'keep-all', kept: ALL },
    { label: 'the empty string', filter: '', verdict: 'keep-all', kept: ALL },
    { label: 'a glob naming a prefix', filter: 'claude-*', verdict: 'narrowed', kept: ALL.slice(0, 2) },
    { label: 'a glob naming one handle', filter: 'human-*', verdict: 'narrowed', kept: ['human-x'] },
    { label: 'a legal glob nobody matches', filter: 'nobody-*', verdict: 'narrowed', kept: [] },
    { label: 'a star flood AT the cap', filter: '*'.repeat(MAX_GLOB_LEN), verdict: 'narrowed', kept: ALL },
    { label: 'a literal AT the cap', filter: 'a'.repeat(MAX_GLOB_LEN), verdict: 'narrowed', kept: [] },
    { label: 'one character past the cap', filter: 'a'.repeat(MAX_GLOB_LEN + 1), verdict: 'refused', kept: [] },
    { label: 'a star flood past the cap', filter: '*'.repeat(MAX_GLOB_LEN + 50), verdict: 'refused', kept: [] },
    { label: 'ten thousand characters', filter: 'a'.repeat(10_000), verdict: 'refused', kept: [] },
  ];

  it('covers all three verdicts, and pairs the empty ANSWER with the empty REFUSAL', () => {
    expect([...new Set(ROSTER_INPUTS.map((r) => r.verdict))].sort()).toEqual([
      'keep-all',
      'narrowed',
      'refused',
    ]);
    // Both rows must exist together: one proves `[]` is a true answer for a legal filter, the other
    // proves an illegal filter never gets to borrow it.
    expect(ROSTER_INPUTS.some((r) => r.verdict === 'narrowed' && r.kept.length === 0)).toBe(true);
    expect(ROSTER_INPUTS.some((r) => r.verdict === 'refused')).toBe(true);
  });

  it.each(ROSTER_INPUTS)('filterHandles: $label is $verdict', ({ filter, verdict, kept }) => {
    if (verdict === 'refused') {
      expect(() => filterHandles(items, filter)).toThrow(RangeError);
      expect(() => filterHandles(items, filter)).toThrow(new RegExp(`${MAX_GLOB_LEN}`));
      return;
    }
    const out = filterHandles(items, filter);
    expect(out.map((i) => i.handle)).toEqual(kept);
    expect(out === items).toBe(verdict === 'keep-all');
  });

  // The matcher primitive is a second door onto the same policy, so it owes the same verdicts.
  it.each(ROSTER_INPUTS.filter((r) => r.filter !== undefined && r.filter !== ''))(
    'matchGlob: $label is $verdict',
    ({ filter, verdict }) => {
      if (verdict === 'refused') {
        expect(() => matchGlob(filter!, 'claude-a')).toThrow(RangeError);
        return;
      }
      expect(typeof matchGlob(filter!, 'claude-a')).toBe('boolean');
    },
  );
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

  it('a filter AT the cap still resolves promptly', () => {
    const filter = '*a'.repeat(MAX_GLOB_LEN / 2);
    expect(filter).toHaveLength(MAX_GLOB_LEN);
    const started = performance.now();
    expect(filterHandles([{ handle: asHandle('a'.repeat(60)) }], filter)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
