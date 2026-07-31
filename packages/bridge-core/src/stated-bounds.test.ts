import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError } from './allowlist.js';
import { MAX_BLOCK_MS, MAX_POST_TOPICS, parseConfig } from './config.js';
import { matchGlob, MAX_GLOB_LEN } from './identity-filter.js';
import { asTopic } from './message.js';
import { isRedosSafeSource, MAX_AMBIGUITY, MAX_MATCH_INPUT } from './regex-safety.js';
import { DEFAULT_HASH_LEN, MAX_HASH_LEN, MIN_HASH_LEN, safeName } from './topic-name.js';

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
      try {
        return matchGlob(`${handle}*`, handle) ? 'accepted' : 'refused';
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        expect((e as Error).message).toMatch(new RegExp(`at most ${MAX_GLOB_LEN} are matched`));
        return 'refused';
      }
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
    label: 'catchup.block_max_ms ceiling (MAX_BLOCK_MS)',
    bound: MAX_BLOCK_MS,
    legal: 'at-or-below',
    probe: (block_max_ms) => {
      try {
        const cfg = parseConfig({
          identity: { handle: 'h' },
          topics: ['ctx'],
          catchup: { block_max_ms },
        });
        expect(cfg.catchup.block_max_ms).toBe(block_max_ms);
        return 'accepted';
      } catch (e) {
        expect((e as Error).message).toMatch(
          new RegExp(`block_max_ms must be <= ${MAX_BLOCK_MS}`),
        );
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
      'catchup.block_max_ms ceiling (MAX_BLOCK_MS)',
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

// Grading a bound only through probes DERIVED from it leaves its VALUE free: with every probe built
// as `'a'.repeat(bound - 1)`, `MAX_GLOB_LEN = 8` keeps the whole suite green while the
// `parley_list_users` schema starts rejecting `claude-agent-*`. These constants are documented
// capacities — promises to an operator — as well as bounds on work, so pin the value as a literal and
// pair it with a literal, realistic input that must still be accepted. The modules are scanned, so a
// capacity added to any of them needs a row here rather than arriving unpinned.

const CAPACITY_MODULES = ['config.ts', 'identity-filter.ts', 'regex-safety.ts', 'topic-name.ts'];

interface Capacity {
  name: string;
  actual: number;
  expected: number;
  realistic: string;
  accepts: () => boolean;
}

const CAPACITIES: Capacity[] = [
  {
    name: 'MAX_GLOB_LEN',
    actual: MAX_GLOB_LEN,
    expected: 256,
    realistic: 'claude-agent-oncall-payments-*',
    accepts: () => matchGlob('claude-agent-oncall-payments-*', 'claude-agent-oncall-payments-eu'),
  },
  {
    name: 'MAX_POST_TOPICS',
    actual: MAX_POST_TOPICS,
    expected: 64,
    realistic: 'sixteen post_topics patterns',
    accepts: () => {
      const cfg = parseConfig({
        identity: { handle: 'h' },
        topics: ['ctx'],
        post_topics: Array.from({ length: 16 }, (_, i) => `ctx-team-${i}-.*`),
      });
      return cfg.post_topics.length === 16;
    },
  },
  {
    name: 'MAX_BLOCK_MS',
    actual: MAX_BLOCK_MS,
    expected: 300_000,
    realistic: 'a two-minute long-poll clamp',
    accepts: () => {
      const cfg = parseConfig({
        identity: { handle: 'h' },
        topics: ['ctx'],
        catchup: { block_max_ms: 120_000 },
      });
      return cfg.catchup.block_max_ms === 120_000;
    },
  },
  {
    name: 'MAX_MATCH_INPUT',
    actual: MAX_MATCH_INPUT,
    expected: 64,
    realistic: 'ctx-payments-oncall-europe-west-handoff-2 (41 chars)',
    accepts: () => {
      const topic = 'ctx-payments-oncall-europe-west-handoff-2';
      expect(topic).toHaveLength(41);
      new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] }).assert(topic);
      return true;
    },
  },
  {
    name: 'MAX_AMBIGUITY',
    actual: MAX_AMBIGUITY,
    expected: 65_536,
    realistic: 'ctx-(?:payments|billing|search)-[a-z0-9-]{1,32}',
    accepts: () => isRedosSafeSource('ctx-(?:payments|billing|search)-[a-z0-9-]{1,32}'),
  },
  {
    name: 'MIN_HASH_LEN',
    actual: MIN_HASH_LEN,
    expected: 10,
    realistic: 'a caller may ask for the floor explicitly, and gets exactly it',
    accepts: () => {
      const minted = safeName(asTopic('a b'), sanitizeAlias, { hashLen: MIN_HASH_LEN })
        .split('-')
        .pop()!;
      return minted.length === MIN_HASH_LEN && /^[0-9a-f]+$/.test(minted);
    },
  },
  {
    name: 'DEFAULT_HASH_LEN',
    actual: DEFAULT_HASH_LEN,
    expected: 16,
    // Grade the width safeName mints when `hashLen` is omitted — exactly, not `{16,}`, which would
    // leave the security parameter free to move under a green suite. Every shipped backend omits it,
    // so this is the width a deployment runs on, and changing it renames every channel.
    realistic: 'the suffix minted when hashLen is omitted is exactly this many hex digits',
    accepts: () => {
      const minted = safeName(asTopic('a b'), sanitizeAlias).split('-').pop()!;
      return minted.length === DEFAULT_HASH_LEN && /^[0-9a-f]+$/.test(minted);
    },
  },
  {
    name: 'MAX_HASH_LEN',
    actual: MAX_HASH_LEN,
    expected: 40,
    realistic: 'a full sha1 hex suffix',
    accepts: () => /-[0-9a-f]{40}$/.test(safeName(asTopic('a b'), sanitizeAlias, { hashLen: 40 })),
  },
];

describe('every documented capacity is pinned to a value, not only to itself', () => {
  it('has a row for every capacity the governed modules export', () => {
    const declared = CAPACITY_MODULES.flatMap((m) =>
      [
        ...readFileSync(fileURLToPath(new URL(m, import.meta.url)), 'utf8').matchAll(
          /^export const ((?:MAX|MIN|DEFAULT)_[A-Z0-9_]+)\b/gm,
        ),
      ].map((match) => match[1]!),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.sort()).toEqual(CAPACITIES.map((c) => c.name).sort());
  });

  it.each(CAPACITIES.map((c) => [c.name, c] as const))('pins %s to a literal', (_n, c) => {
    expect(c.actual).toBe(c.expected);
  });

  it.each(CAPACITIES.map((c) => [c.name, c.realistic, c] as const))(
    '%s still admits a realistic input (%s)',
    (_n, _r, c) => {
      expect(c.accepts()).toBe(true);
    },
  );
});
