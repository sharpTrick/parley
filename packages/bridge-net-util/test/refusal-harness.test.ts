import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLANTED_SECRET } from '../src/testing/hostile-config-values.js';
import { expectRefusalMessage, type RefusalSpec } from '../src/testing/refusal-harness.js';

const spec = (validate: RefusalSpec['validate']): RefusalSpec => ({
  label: () => /^refused/,
  keys: ['url'],
  declared: ['url'],
  validate,
});

const ACCEPTS_EVERYTHING = spec(() => undefined);
const REFUSES_SILENTLY = spec(() => {
  throw new Error('');
});
const REFUSES = spec((key) => {
  throw new Error(`refused ${key}`);
});

/**
 * CLASS: a harness block that reads the message a validator threw, without first establishing that
 * it threw one. `expect('').not.toContain(secret)` holds for every secret there is, so the block
 * that exists to prove a credential is never echoed passed for the two backends whose validator
 * ACCEPTS a bare credential string under the key it was handed — postgres `url` and xmpp
 * `password`. Nothing about that failure was visible: the row was green, and its neighbours carried
 * the guard it was missing.
 */
describe('the harness fails a validator that never refuses, instead of grading its silence', () => {
  it('fails when the validator accepts the value', () => {
    expect(() =>
      expectRefusalMessage(ACCEPTS_EVERYTHING, 'url', `scheme://parley:${PLANTED_SECRET}@host/x y`),
    ).toThrow(/ACCEPTED/);
  });

  it('fails when the refusal carries no message to grade', () => {
    expect(() => expectRefusalMessage(REFUSES_SILENTLY, 'url', 'anything')).toThrow(/empty message/);
  });

  it('returns the message when the validator does refuse, so the rows above are not vacuous', () => {
    expect(expectRefusalMessage(REFUSES, 'url', 'anything')).toBe('refused url');
  });

  /**
   * The guard above is only worth having if a block CANNOT be written that skips it. Every block
   * reaches a caught message through the one chokepoint, and the catch itself has exactly one
   * caller — so a new block reads a message the same way or does not read one at all.
   */
  it('leaves no second path from a caught refusal to an assertion', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/testing/refusal-harness.ts', import.meta.url)),
      'utf8',
    );
    expect(
      source.split('refusalOf').length - 1,
      'the catch has a caller other than expectRefusalMessage, which can skip the guard',
    ).toBe(2);
    expect(source.split('expectRefusalMessage(').length - 1).toBeGreaterThan(1);
  });
});
