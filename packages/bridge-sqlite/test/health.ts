import { expect } from 'vitest';
import type { SubscriptionHealth } from '../src/index.js';

/**
 * A {@link SubscriptionHealth} expectation with every field spelled out. Derived from the record
 * itself, so a field added to it has to be given a value in every transition that uses this rather
 * than defaulting to ungraded — `state` is only the first thing a supervisor keys off.
 */
export type ExpectedHealth = Omit<SubscriptionHealth, 'lastError' | 'consecutiveFailures'> & {
  /** An exact count, or a floor for a report taken while the loop is still failing. */
  consecutiveFailures: number | { atLeast: number };
  /** Absent = the report must carry no `lastError`; a pattern must match the one it carries. */
  lastError?: RegExp;
};

type Discriminants = Omit<SubscriptionHealth, 'lastError' | 'consecutiveFailures'>;

function discriminants(h: SubscriptionHealth | ExpectedHealth): Discriminants {
  const { lastError: _e, consecutiveFailures: _f, ...rest } = h;
  return rest;
}

/** Grade a whole health report — every record, every field — against `expected`. */
export function expectHealth(actual: SubscriptionHealth[], expected: ExpectedHealth[]): void {
  expect(actual.map(discriminants)).toEqual(expected.map(discriminants));
  actual.forEach((h, i) => {
    const want = expected[i];
    if (want === undefined) return;
    const where = `on ${h.topic}`;
    if (typeof want.consecutiveFailures === 'number') {
      expect(h.consecutiveFailures, `consecutiveFailures ${where}`).toBe(want.consecutiveFailures);
    } else {
      expect(h.consecutiveFailures, `consecutiveFailures ${where}`).toBeGreaterThanOrEqual(
        want.consecutiveFailures.atLeast,
      );
    }
    if (want.lastError === undefined) expect(h.lastError, `lastError ${where}`).toBeUndefined();
    else expect(h.lastError ?? '', `lastError ${where}`).toMatch(want.lastError);
  });
}
