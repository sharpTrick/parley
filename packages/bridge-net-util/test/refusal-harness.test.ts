import { describe, expect, it } from 'vitest';
import { PLANTED_SECRET } from '../src/testing/hostile-config-values.js';
import {
  expectRefusalMessage,
  refusalOf,
  type RefusalSpec,
} from '../src/testing/refusal-harness.js';

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
   * The guard above is only worth having if a block cannot be written that skips it. What stops one
   * is the TYPE: an acceptance carries no `message` at all, so `.message` does not compile until
   * `threw` has been narrowed, and there is no empty string for a block to grade by accident.
   */
  it('an acceptance carries no message for a block to read', () => {
    const accepted = refusalOf(ACCEPTS_EVERYTHING, 'url', PLANTED_SECRET);
    expect(accepted.threw).toBe(false);
    expect(Object.hasOwn(accepted, 'message')).toBe(false);
    const refused = refusalOf(REFUSES, 'url', PLANTED_SECRET);
    expect(refused).toEqual({ threw: true, message: 'refused url' });
  });
});
