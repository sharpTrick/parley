import { describe, expect, it } from 'vitest';
import { MAX_ERROR_BODY, NEVER_RENDERABLE, RENDER_LEAK_SENTINEL } from '../src/index.js';
import { describeConfigShape, describeConfigValue } from '../src/config-value.js';

const SECRET = 'PLANTED-SECRET-8f3a';

/**
 * CLASS: a rejected `backend_config` value is rendered into an error an operator reads and core
 * hands to a model. Whatever a caller put in the YAML, rendering it may not throw, may not carry
 * text the caller wrote, and may not forge line structure or run unbounded.
 */
describe('describeConfigValue survives every value a backend_config can hold', () => {
  it.each(NEVER_RENDERABLE)('renders %s without throwing', (_label, value) => {
    expect(() => describeConfigValue('block_ms', value)).not.toThrow();
  });

  it.each(NEVER_RENDERABLE)('never echoes what %s put in its own message', (_label, value) => {
    expect(describeConfigValue('block_ms', value)).not.toContain(RENDER_LEAK_SENTINEL);
  });

  it.each(NEVER_RENDERABLE)('renders %s as one bounded line', (_label, value) => {
    const text = describeConfigValue('block_ms', value);
    expect(text).not.toMatch(/[\n\r]/);
    expect(text.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 16);
  });

  it('flattens and bounds a value a caller authored', () => {
    expect(describeConfigValue('key_prefix', 'a\nb')).not.toMatch(/\n/);
    expect(describeConfigValue('key_prefix', 'x'.repeat(MAX_ERROR_BODY * 2))).toContain(
      '[truncated]',
    );
  });

  it('keeps NaN readable, which JSON.stringify alone turns into null', () => {
    expect(describeConfigValue('block_ms', Number.NaN)).toBe('NaN');
    expect(describeConfigValue('block_ms', Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('describes a shape without disclosing what it holds', () => {
    expect(describeConfigShape('')).toBe('the empty string');
    expect(describeConfigShape(['secret'])).toBe('an array');
    expect(describeConfigShape({ password: 'hunter2' })).toBe('an object');
    expect(describeConfigShape(7)).toBe('a number');
    for (const [, value] of NEVER_RENDERABLE)
      expect(() => describeConfigShape(value)).not.toThrow();
  });
});

/**
 * CLASS: the branch that hands a value to this renderer is `not a non-empty string`, which admits
 * every CONTAINER a secret can be nested inside. A renderer that enumerates one prints that secret
 * into the operator's log and into the model context core renders a seam error into — whatever key
 * it was written under, and whether or not that key names a credential.
 */
describe('a container is described, never enumerated', () => {
  const WRAPPERS: Array<[string, unknown]> = [
    ['an object', { value: SECRET }],
    ['an array', [SECRET]],
    ['a nested object', { outer: { inner: [SECRET] } }],
    ['a null-prototype object', Object.assign(Object.create(null) as object, { v: SECRET })],
    ['a function whose source names it', () => SECRET],
    ['a value whose toJSON yields the secret', { toJSON: () => ({ v: SECRET }) }],
  ];

  const CREDENTIAL_KEYS = [
    'url',
    'password',
    'bot_token',
    'client_secret',
    'key_file',
    'cert',
    'auth_token',
  ];
  const INNOCUOUS_KEYS = ['block_ms', 'table_name', 'key_prefix', 'limit'];

  it.each(WRAPPERS)('%s under an innocuous key still discloses nothing', (_label, value) => {
    for (const key of INNOCUOUS_KEYS) expect(describeConfigValue(key, value)).not.toContain(SECRET);
  });

  it.each(WRAPPERS)('%s under a credential key discloses nothing', (_label, value) => {
    for (const key of CREDENTIAL_KEYS) expect(describeConfigValue(key, value)).not.toContain(SECRET);
  });

  it.each(CREDENTIAL_KEYS)('`%s` is never rendered by value, even as a bare string', (key) => {
    expect(describeConfigValue(key, `postgres://u:${SECRET}@db/parley`)).not.toContain(SECRET);
    expect(describeConfigValue(key, SECRET)).not.toContain(SECRET);
  });

  it('still renders a value under an innocuous key, so the rows above are not vacuous', () => {
    expect(describeConfigValue('key_prefix', 'parley:')).toContain('parley:');
    expect(describeConfigValue('block_ms', 5)).toBe('5');
  });
});
