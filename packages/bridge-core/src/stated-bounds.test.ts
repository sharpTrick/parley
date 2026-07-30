import { describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError } from './allowlist.js';
import { parseConfig } from './config.js';
import { matchGlob, MAX_GLOB_LEN } from './identity-filter.js';
import { asTopic } from './message.js';
import { isRedosSafeSource, MAX_AMBIGUITY, MAX_MATCH_INPUT } from './regex-safety.js';
import { MAX_HASH_LEN, MIN_HASH_LEN, safeName } from './topic-name.js';

// Every limit below is documented as INCLUSIVE — "at most 64 characters", "must be >= the
// heartbeat", "an integer in [10, 40]" — and each is stated in an error message the operator reads.
// A table that samples one interior value on each side leaves the equality case free, and the
// equality case is where a one-character regression lands: it refuses a legal input with a message
// that contradicts itself ("at most 64 characters (this one is 64)"), and it locks an operator out
// of post/fetch for a topic the doc promises works. So grade the bound itself, three cells per rule,
// every probe value derived from the constant rather than from a literal.

type Verdict = 'accepted' | 'refused';

interface StatedBound {
  label: string;
  bound: number;
  /** Which side of the bound is legal; the bound value itself is legal on both. */
  legal: 'at-or-below' | 'at-or-above';
  probe: (value: number) => Verdict;
}

const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

const BOUNDS: StatedBound[] = [
  {
    label: 'Allowlist post-pattern input clamp (MAX_MATCH_INPUT)',
    bound: MAX_MATCH_INPUT,
    legal: 'at-or-below',
    probe: (len) => {
      const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
      const topic = `ctx-${'a'.repeat(len - 4)}`;
      expect(topic).toHaveLength(len);
      try {
        allow.assert(topic);
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(TopicNotAllowedError);
        expect((e as Error).message).toMatch(
          new RegExp(`at most ${MAX_MATCH_INPUT} characters \\(this one is ${len}\\)`),
        );
        return 'refused';
      }
    },
  },
  {
    label: 'glob filter length ceiling (MAX_GLOB_LEN)',
    bound: MAX_GLOB_LEN,
    legal: 'at-or-below',
    probe: (len) => {
      const handle = 'a'.repeat(len - 1);
      return matchGlob(`${handle}*`, handle) ? 'accepted' : 'refused';
    },
  },
  {
    label: 'safeName hash suffix floor (MIN_HASH_LEN)',
    bound: MIN_HASH_LEN,
    legal: 'at-or-above',
    probe: (hashLen) => hashLenVerdict(hashLen),
  },
  {
    label: 'safeName hash suffix ceiling (MAX_HASH_LEN)',
    bound: MAX_HASH_LEN,
    legal: 'at-or-below',
    probe: (hashLen) => hashLenVerdict(hashLen),
  },
  {
    label: 'presence.ttl_ms floor (presence.heartbeat_ms)',
    bound: 60_000,
    legal: 'at-or-above',
    probe: (ttl_ms) => {
      try {
        const cfg = parseConfig({
          identity: { handle: 'h' },
          topics: ['ctx'],
          presence: { heartbeat_ms: 60_000, ttl_ms },
        });
        expect(cfg.presence.ttl_ms).toBe(ttl_ms);
        return 'accepted';
      } catch (e) {
        expect((e as Error).message).toMatch(/ttl_ms must be >= .*heartbeat_ms/);
        return 'refused';
      }
    },
  },
  {
    label: 'regex screen ambiguity budget (MAX_AMBIGUITY)',
    bound: Math.log2(MAX_AMBIGUITY),
    legal: 'at-or-below',
    // Each `a?` doubles the paths the engine can explore, so n optional atoms cost exactly 2^n.
    probe: (n) => (isRedosSafeSource(`${'a?'.repeat(n)}b`) ? 'accepted' : 'refused'),
  },
];

function hashLenVerdict(hashLen: number): Verdict {
  try {
    safeName(asTopic('a b'), sanitizeAlias, { hashLen });
    return 'accepted';
  } catch (e) {
    expect(e).toBeInstanceOf(RangeError);
    expect((e as Error).message).toMatch(
      new RegExp(`integer in \\[${MIN_HASH_LEN}, ${MAX_HASH_LEN}\\]`),
    );
    return 'refused';
  }
}

const inside = (b: StatedBound): number => (b.legal === 'at-or-below' ? b.bound - 1 : b.bound + 1);
const outside = (b: StatedBound): number => (b.legal === 'at-or-below' ? b.bound + 1 : b.bound - 1);

describe('every documented inclusive bound is graded AT the bound', () => {
  it('pins the set of graded bounds and that each is an integer probe point', () => {
    expect(BOUNDS.map((b) => b.label)).toEqual([
      'Allowlist post-pattern input clamp (MAX_MATCH_INPUT)',
      'glob filter length ceiling (MAX_GLOB_LEN)',
      'safeName hash suffix floor (MIN_HASH_LEN)',
      'safeName hash suffix ceiling (MAX_HASH_LEN)',
      'presence.ttl_ms floor (presence.heartbeat_ms)',
      'regex screen ambiguity budget (MAX_AMBIGUITY)',
    ]);
    for (const b of BOUNDS) expect(Number.isInteger(b.bound), b.label).toBe(true);
  });

  it.each(BOUNDS.map((b) => [b.label, b] as const))('%s accepts the bound itself', (_l, b) => {
    expect(b.probe(b.bound)).toBe('accepted');
  });

  it.each(BOUNDS.map((b) => [b.label, b] as const))(
    '%s accepts one step inside the bound',
    (_l, b) => {
      expect(b.probe(inside(b))).toBe('accepted');
    },
  );

  it.each(BOUNDS.map((b) => [b.label, b] as const))('%s refuses one step past it', (_l, b) => {
    expect(b.probe(outside(b))).toBe('refused');
  });
});
