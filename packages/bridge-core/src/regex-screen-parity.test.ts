import { describe, expect, it } from 'vitest';
import { Allowlist, UnsafePatternError } from './allowlist.js';
import { parseConfig } from './config.js';
import { isRedosSafeSource } from './regex-safety.js';
import { HOSTILE_PATTERNS, SAFE_PATTERNS } from './testing/regex-corpus.js';

// Three layers compile a pattern nobody in this repo authored: the screen itself, the Allowlist an
// embedder builds by hand, and parseConfig's post_topics at load. A per-layer copy of the hostile
// corpus drifts — three copies with three memberships left the config path, the only one an operator
// actually reaches, ungraded against the quantifier-free chain shapes the screen exists for. So every
// entry point is graded against the single shared corpus, and widening the class widens all three.

type Verdict = 'accepted' | 'refused';

const ENTRY_POINTS: readonly (readonly [label: string, screen: (src: string) => Verdict])[] = [
  ['isRedosSafeSource', (src) => (isRedosSafeSource(src) ? 'accepted' : 'refused')],
  [
    'new Allowlist({ postPatterns })',
    (src) => {
      try {
        new Allowlist(['ctx'], { postPatterns: [src] });
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(UnsafePatternError);
        return 'refused';
      }
    },
  ],
  [
    'parseConfig({ post_topics })',
    (src) => {
      try {
        parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], post_topics: [src] });
        return 'accepted';
      } catch (e) {
        expect((e as Error).message).toMatch(/catastrophic backtracking/);
        return 'refused';
      }
    },
  ],
] as const;

const cross = (
  rows: readonly (readonly [string, string])[],
): [string, (src: string) => Verdict, string][] =>
  ENTRY_POINTS.flatMap(([entry, screen]) =>
    rows.map(([label, src]) => [`${entry} × ${label}`, screen, src] as [
      string,
      (src: string) => Verdict,
      string,
    ]),
  );

describe('every regex screening entry point grades the same corpus', () => {
  // Generated tables cannot see a row deleted from the list that generates them, so pin membership
  // by value: the chain shapes below are the ones a quantifier-counting screen cannot see, and the
  // ones whose absence from the config copy was the defect.
  it('pins the corpus membership', () => {
    expect(HOSTILE_PATTERNS.length).toBe(18);
    expect(SAFE_PATTERNS.length).toBe(13);
    expect(HOSTILE_PATTERNS.map(([label]) => label)).toEqual(
      expect.arrayContaining([
        'ambiguous alternation chain',
        'ambiguous alternation chain (non-capturing)',
        'optional-atom chain',
        'optional-class chain',
        'bounded-repeat chain',
      ]),
    );
    expect(ENTRY_POINTS.length).toBe(3);
    const overlap = SAFE_PATTERNS.map(([, src]) => src).filter((src) =>
      HOSTILE_PATTERNS.some(([, hostile]) => hostile === src),
    );
    expect(overlap).toEqual([]);
  });

  it.each(cross(HOSTILE_PATTERNS))('refuses %s', (_label, screen, src) => {
    expect(screen(src)).toBe('refused');
  });

  it.each(cross(SAFE_PATTERNS))('accepts %s', (_label, screen, src) => {
    expect(screen(src)).toBe('accepted');
  });
});
