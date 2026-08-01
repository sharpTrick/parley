import { describe, expect, it } from 'vitest';
import * as api from '@sharptrick/parley-net-util';
import {
  clampBackoff,
  DEFAULT_BACKOFF_MS,
  delay,
  MAX_BACKOFF_MS,
} from '@sharptrick/parley-net-util';
import { README } from './fixtures.js';
/**
 * A normalizer whose stated output range is not the range it produces is the whole defect: the
 * function documented `[DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS]` and returned 1 for 1, which is the
 * hot-spin the floor exists to prevent. So the interval is PARSED out of the README and the docs'
 * own claim is what the sweep below is graded against — a table of hand-listed pairs pinned the
 * contradiction as intended behaviour instead.
 */
describe('clampBackoff', () => {
  const documentedInterval = (): [number, number] => {
    const found = /into `\[(\w+), (\w+)\]`/.exec(README);
    if (found === null) throw new Error("the README no longer states clampBackoff's interval");
    const value = (name: string): number => {
      const v = (api as unknown as Record<string, unknown>)[name];
      expect(typeof v, `\`${name}\` is not an exported number`).toBe('number');
      return v as number;
    };
    return [value(found[1] as string), value(found[2] as string)];
  };

  const SWEEP = [
    ...Array.from({ length: 41 }, (_, i) => i),
    ...Array.from({ length: 41 }, (_, i) => i * 250),
    -1e9,
    -1,
    0.5,
    499.9,
    1e9,
  ];

  it('reads an interval out of the README, so the rows below grade something', () => {
    const [lo, hi] = documentedInterval();
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo);
    expect(SWEEP.some((ms) => ms < lo)).toBe(true);
    expect(SWEEP.some((ms) => ms > hi)).toBe(true);
  });

  it('lands every finite input inside the documented interval', () => {
    const [lo, hi] = documentedInterval();
    for (const ms of SWEEP) {
      const out = clampBackoff(ms);
      expect(out, `clampBackoff(${ms})`).toBeGreaterThanOrEqual(lo);
      expect(out, `clampBackoff(${ms})`).toBeLessThanOrEqual(hi);
    }
  });

  it('is the identity on everything already inside the interval', () => {
    const [lo, hi] = documentedInterval();
    for (const ms of SWEEP.filter((n) => n >= lo && n <= hi)) expect(clampBackoff(ms)).toBe(ms);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'reads the unusable input %s as the documented lower bound',
    (bad) => {
      expect(clampBackoff(bad as number | undefined)).toBe(documentedInterval()[0]);
    },
  );

  it.each([
    [undefined, DEFAULT_BACKOFF_MS],
    [0, DEFAULT_BACKOFF_MS],
    [-1, DEFAULT_BACKOFF_MS],
    [1, DEFAULT_BACKOFF_MS],
    [DEFAULT_BACKOFF_MS - 1, DEFAULT_BACKOFF_MS],
    [DEFAULT_BACKOFF_MS, DEFAULT_BACKOFF_MS],
    [MAX_BACKOFF_MS, MAX_BACKOFF_MS],
    [MAX_BACKOFF_MS + 1, MAX_BACKOFF_MS],
    [1e9, MAX_BACKOFF_MS],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampBackoff(input as number | undefined)).toBe(expected);
  });
});

describe('delay', () => {
  it('resolves after roughly the requested time', async () => {
    const started = Date.now();
    await delay(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('resolves immediately for 0', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});
