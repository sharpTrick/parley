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

/**
 * CLASS: the offending key is CALLER-AUTHORED text, and this refusal is rendered into an operator's
 * log and into the model context core renders a seam error into. Round 2 hardened the VALUE side by
 * lifting a renderer into a backend-support package; the KEY side is equally caller-authored and
 * equally destined for that context, and core cannot reach that renderer — the seam may not depend
 * on a plugin's support package. So the bound lives here.
 */
describe('an undeclared key is named as one bounded, harmless line', () => {
  const FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

  const HOSTILE: [string, string][] = [
    ['a newline', 'evil\nkey'],
    ['a carriage return', 'evil\rkey'],
    ['a LINE SEPARATOR', 'evil\u2028key'],
    ['a PARAGRAPH SEPARATOR', 'evil\u2029key'],
    ['a bidi override', 'evil\u202Ekey'],
    ['3KiB of one character', 'k'.repeat(3000)],
    ['all of it at once', `evil\u202E\n${'k'.repeat(3000)}`],
  ];

  const messageFor = (key: string, config: object): string => {
    try {
      assertKnownConfigKeys('probe', config, DECLARED);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`${key} was accepted, so this row grades nothing`);
  };

  it.each(HOSTILE)('%s at the top level', (_label, key) => {
    const message = messageFor(key, { [key]: 1 });
    expect(message).not.toMatch(FORBIDDEN);
    expect(message).not.toMatch(/[\n\r]/);
    expect(message.length).toBeLessThan(512);
  });

  it.each(HOSTILE)('%s nested in a group', (_label, key) => {
    const message = messageFor(key, { tls: { [key]: 1 } });
    expect(message).not.toMatch(FORBIDDEN);
    expect(message).not.toMatch(/[\n\r]/);
    expect(message.length).toBeLessThan(512);
  });

  it('still names a key an operator can act on, so the rows above are not vacuous', () => {
    expect(messageFor('ca_flie', { tls: { ca_flie: 'x' } })).toContain("'tls.ca_flie'");
  });
});
