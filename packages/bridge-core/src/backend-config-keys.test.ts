import { describe, expect, it } from 'vitest';
import { assertKnownConfigKeys, isPlainObject, type BackendConfigKeys } from './backend-config-keys.js';

const DECLARED: BackendConfigKeys = { keys: ['tls'], nested: { tls: ['ca_file'] } };

class Settings {
  get ca_file(): string {
    return '/etc/ca.pem';
  }
}

/**
 * CLASS: {@link isPlainObject} is the enumerate-this-container gate every backend's config loader
 * asks before walking a nested group. A container it admits that `Object.entries` reads as EMPTY is
 * a config ACCEPTED with zero members by the check that exists to refuse one — the loader comes up
 * reporting success with the operator's whole group silently dropped. Graded through
 * `assertKnownConfigKeys`, the surface plugins actually call, rather than through the predicate.
 */
describe('a nested config group is an object literal or it is refused', () => {
  const ENUMERATES_TO_NOTHING: Array<[string, unknown]> = [
    ['a Date', new Date()],
    ['a Buffer', Buffer.from('ca')],
    ['a boxed String', new String('ca')],
    ['a RegExp', /ca/],
    ['a class instance', new Settings()],
    ['an array', ['ca_file']],
    ['a Map', new Map([['ca_file', '/etc/ca.pem']])],
  ];

  it.each(ENUMERATES_TO_NOTHING)('%s is refused, naming the members it should have held', (
    _label,
    value,
  ) => {
    expect(() => assertKnownConfigKeys('probe', { tls: value }, DECLARED)).toThrow(
      /invalid backend_config\.tls — expected an object holding tls\.ca_file/,
    );
  });

  it.each(ENUMERATES_TO_NOTHING)('%s enumerates to nothing, so the row above is not vacuous', (
    _label,
    value,
  ) => {
    expect(Object.keys(value as object)).not.toContain('ca_file');
  });

  it('still admits the two shapes a config parse produces', () => {
    expect(() =>
      assertKnownConfigKeys('probe', { tls: { ca_file: '/etc/ca.pem' } }, DECLARED),
    ).not.toThrow();
    const bare = Object.assign(Object.create(null) as object, { ca_file: '/etc/ca.pem' });
    expect(() => assertKnownConfigKeys('probe', { tls: bare }, DECLARED)).not.toThrow();
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('still refuses an undeclared member of a group it does admit', () => {
    expect(() => assertKnownConfigKeys('probe', { tls: { ca_flie: 'x' } }, DECLARED)).toThrow(
      /unknown backend_config key 'tls\.ca_flie'/,
    );
  });
});
