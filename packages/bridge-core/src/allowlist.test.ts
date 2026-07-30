import { describe, expect, it } from 'vitest';
import { Allowlist, allowlistFor, TopicNotAllowedError, UnsafePatternError } from './allowlist.js';
import { parseConfig } from './config.js';
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

// `allowlistFor` is the one function that turns a parsed config into the runtime security boundary,
// and every composition root calls it. The class-level cases above hand `reserved`/`postPatterns` in
// by hand, so none of them can see a wiring mistake HERE — dropping `reserved`, or folding
// `post_topics` into the explicit set, changes nothing they assert. Drive it from parseConfig output
// only, and grade the three-way partition as a property of each row, so a config field added later
// (a second reserved topic, a `subscribe_topics` list) is graded the moment it appears.
describe('allowlistFor wires a parsed config to the boundary', () => {
  const ROWS: readonly (readonly [
    label: string,
    raw: Record<string, unknown>,
    patternHit: string | undefined,
  ])[] = [
    ['no patterns', { topics: ['ctx-a', 'ctx-b'] }, undefined],
    ['one pattern', { topics: ['ctx-a'], post_topics: ['ctx-.*'] }, 'ctx-zzz'],
    ['broad pattern', { topics: ['ctx-a'], post_topics: ['.*'] }, 'anything-at-all'],
    [
      'several patterns',
      { topics: ['ctx-a', 'ctx-b'], post_topics: ['ops-.*', 'dev-[a-z]+'] },
      'dev-x',
    ],
    [
      'custom presence topic under a broad pattern',
      { topics: ['ctx-a'], post_topics: ['.*'], presence: { topic: 'roster-x' } },
      'anything-at-all',
    ],
    [
      'presence disabled under a broad pattern',
      { topics: ['ctx-a'], post_topics: ['.*'], presence: { enabled: false } },
      'anything-at-all',
    ],
  ] as const;

  const configOf = (raw: Record<string, unknown>): ReturnType<typeof parseConfig> =>
    parseConfig({ identity: { handle: 'h' }, ...raw });

  const patternsOf = (raw: Record<string, unknown>): string[] =>
    (raw.post_topics as string[] | undefined) ?? [];

  it('covers rows that can see each wiring mistake', () => {
    expect(ROWS.map(([label]) => label)).toEqual([
      'no patterns',
      'one pattern',
      'broad pattern',
      'several patterns',
      'custom presence topic under a broad pattern',
      'presence disabled under a broad pattern',
    ]);
    expect(ROWS.filter(([, raw]) => patternsOf(raw).length > 0).length).toBeGreaterThanOrEqual(4);
    expect(ROWS.filter(([, raw]) => patternsOf(raw).includes('.*')).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(ROWS.filter(([, , hit]) => hit !== undefined).length).toBeGreaterThanOrEqual(4);
  });

  it.each(ROWS)('subscribe sees exactly the explicit topics (%s)', (_label, raw) => {
    const cfg = configOf(raw);
    expect([...allowlistFor(cfg).topics()].sort()).toEqual([...cfg.topics].sort());
  });

  it.each(ROWS)('the presence topic is reserved on both dimensions (%s)', (_label, raw) => {
    const cfg = configOf(raw);
    const allow = allowlistFor(cfg);
    expect(allow.has(cfg.presence.topic)).toBe(false);
    expect(() => allow.assert(cfg.presence.topic)).toThrow(TopicNotAllowedError);
    expect(allow.topics()).not.toContain(cfg.presence.topic);
  });

  it.each(ROWS)('a pattern match is postable but never subscribed (%s)', (_label, raw, hit) => {
    const cfg = configOf(raw);
    const allow = allowlistFor(cfg);
    expect(allow.patterns()).toEqual(cfg.post_topics);
    if (hit === undefined) return;
    expect(allow.has(hit)).toBe(true);
    expect(allow.topics()).not.toContain(hit);
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

  // The wrapper is `^(?:src)$`, not `^src$`, and the group is what makes the anchors bind the WHOLE
  // source. Every alternation in the shared corpus is already parenthesised, which is exactly the
  // shape the group is redundant for, so nothing there can tell the two wrappers apart. A source
  // whose TOP level is an alternation or an anchor can: under `^src$` a config line reading as two
  // narrow topics mints a post/fetch set reaching arbitrary topics. The mustNotMatch column is what
  // pins it — a row asserting only that the listed topic matches cannot fail.
  const ANCHORING: readonly (readonly [src: string, match: string[], notMatch: string[]])[] = [
    ['ops|dev', ['ops', 'dev'], ['secret-dev', 'ops-anything', 'xops', 'devx']],
    ['a|b|c', ['a', 'b', 'c'], ['ab', 'xa', 'cx']],
    ['|ops', ['ops'], ['secret', 'x-ops']],
    ['ops|', ['ops'], ['secret', 'ops-x']],
    ['ctx-.*|ops', ['ctx-a', 'ops'], ['x-ctx-a', 'opsx']],
    ['^ops', ['ops'], ['ops-x', 'x-ops']],
    ['ops$', ['ops'], ['ops-x', 'x-ops']],
  ] as const;

  const COMPILING_ENTRY_POINTS: readonly (readonly [
    label: string,
    build: (src: string) => Allowlist,
  ])[] = [
    ['new Allowlist({ postPatterns })', (src) => new Allowlist(['ctx'], { postPatterns: [src] })],
    [
      'allowlistFor(parseConfig({ post_topics }))',
      (src) => allowlistFor(parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], post_topics: [src] })),
    ],
  ] as const;

  it('every anchoring row can fail in both directions', () => {
    expect(ANCHORING.length).toBe(7);
    expect(ANCHORING.every(([, match]) => match.length > 0)).toBe(true);
    expect(ANCHORING.every(([, , notMatch]) => notMatch.length > 0)).toBe(true);
    expect(ANCHORING.map(([src]) => src)).toEqual(
      expect.arrayContaining(['ops|dev', '|ops', 'ops|', '^ops', 'ops$']),
    );
  });

  it.each(
    COMPILING_ENTRY_POINTS.flatMap(([entry, build]) =>
      ANCHORING.map(
        ([src, match, notMatch]) =>
          [`${entry} × ${JSON.stringify(src)}`, build, src, match, notMatch] as const,
      ),
    ),
  )('anchors the whole source, not one branch of it (%s)', (_label, build, src, match, notMatch) => {
    const allow = build(src);
    expect(match.filter((t) => !allow.has(t))).toEqual([]);
    expect(notMatch.filter((t) => allow.has(t))).toEqual([]);
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
