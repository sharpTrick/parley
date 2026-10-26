import { describe, expect, it } from 'vitest';
import { BROKEN_VARIANTS, brokenShardOf } from './reference-plugin.js';

/**
 * How the negative control's variants are split across children, graded on its own rather than
 * through the 222-second nested run that consumes it.
 *
 * `brokenShardOf` had no test at all, and two of its answers were silently wrong: `''` yielded
 * index 0 of count 1 — EVERY variant, in every child — and `'abc'` yielded NaN, which no index is
 * congruent to, so the child registered NOTHING and the parent read an empty slice as a run that
 * found no failures.
 */
describe('the broken variants are split across children without loss or overlap', () => {
  it.each([1, 2, 3, 4, 8, BROKEN_VARIANTS.length].map((n) => [n]))(
    'splitting into %i children covers every variant exactly once',
    (count) => {
      const shards = Array.from({ length: count }, (_, i) => brokenShardOf(`${i}/${count}`));
      const seen = shards.flatMap((s) => s.map((v) => v.name));
      expect(new Set(seen).size, 'a variant landed in two children, or in none').toBe(seen.length);
      expect([...seen].sort()).toEqual(BROKEN_VARIANTS.map((v) => v.name).sort());
    },
  );

  it('takes every variant when no shard is named', () => {
    expect(brokenShardOf(undefined).map((v) => v.name)).toEqual(BROKEN_VARIANTS.map((v) => v.name));
  });

  it.each([[''], ['abc'], ['0/0'], ['3/2'], ['-1/2'], ['1'], ['1/2/3'], ['1.5/3']])(
    'refuses the malformed spec "%s" rather than answering one',
    (spec) => {
      expect(() => brokenShardOf(spec)).toThrow(/PARLEY_CONFORMANCE_BROKEN_SHARD/);
    },
  );
});
