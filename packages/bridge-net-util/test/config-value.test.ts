import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_RENDER,
  MAX_ERROR_BODY,
  NEVER_RENDERABLE,
  RENDER_LEAK_SENTINEL,
  UNSAFE_TEXT,
} from '../src/index.js';
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

/**
 * CLASS: {@link NEVER_RENDERABLE} is a DATA TABLE, so it shrinks with no code change and nothing
 * notices — deleting the null-prototype row, which is the entire justification for lifting the
 * renderer here, left 306 passed / 0 failed. Every other derived check in this package carries a
 * floor; this is that floor.
 *
 * Pinned by the PROPERTY each row exists for rather than by a count: `toHaveLength` cements the
 * table as it stands, and a row whose value stopped being hostile would still satisfy it.
 */
describe('the corpus keeps the properties it was assembled for', () => {
  /**
   * How a value defeats a renderer built out of `JSON.stringify` and `String`. Each mode is one
   * naive renderer's failure, not one composite renderer's: a bare null-prototype object stringifies
   * to `{}` and throws only under `String`, which is exactly the crash the five forked renderers
   * this corpus retired all shared.
   */
  const FAILURE_MODES: Record<string, (value: unknown) => boolean> = {
    'JSON.stringify throws': (value) => {
      try {
        JSON.stringify(value);
        return false;
      } catch {
        return true;
      }
    },
    'String throws': (value) => {
      try {
        String(value);
        return false;
      } catch {
        return true;
      }
    },
    'JSON.stringify returns undefined': (value) => {
      try {
        return JSON.stringify(value) === undefined;
      } catch {
        return false;
      }
    },
    'JSON.stringify succeeds where String throws': (value) => {
      try {
        if (typeof JSON.stringify(value) !== 'string') return false;
      } catch {
        return false;
      }
      try {
        String(value);
        return false;
      } catch {
        return true;
      }
    },
    "the value's own toJSON raises text it wrote": (value) => {
      try {
        JSON.stringify(value);
        return false;
      } catch (err) {
        return String(err).includes(RENDER_LEAK_SENTINEL);
      }
    },
  };

  it.each(NEVER_RENDERABLE)('%s defeats a naive renderer', (_label, value) => {
    const broken = Object.entries(FAILURE_MODES).filter(([, breaks]) => breaks(value));
    expect(
      broken.map(([mode]) => mode),
      'this row renders fine without help — it grades nothing where it sits',
    ).not.toEqual([]);
  });

  it.each(Object.keys(FAILURE_MODES))('the corpus still carries a value where %s', (mode) => {
    const breaks = FAILURE_MODES[mode] as (value: unknown) => boolean;
    expect(
      NEVER_RENDERABLE.filter(([, value]) => breaks(value)).map(([label]) => label),
      `no row left in the corpus reaches the "${mode}" branch of the renderer`,
    ).not.toEqual([]);
  });
});

/**
 * CLASS: the value reaches an operator's log and the model context core renders a seam error into,
 * so its TEXT is untrusted as well as its shape. Only a PRIMITIVE gets this far — a container is
 * described rather than rendered — which is exactly why the hostile-object corpus cannot grade the
 * sanitiser: `JSON.stringify` escapes a newline before `sanitizeBody` ever sees one, so every
 * assertion about flattening was passing on text that was never dangerous.
 */
describe('a rendered value is one bounded line of harmless text', () => {
  it.each(UNSAFE_TEXT)('%s survives neither the flattening nor the bound', (_label, text) => {
    const rendered = describeConfigValue('key_prefix', text);
    expect(rendered).not.toMatch(FORBIDDEN_IN_RENDER);
    expect(rendered).not.toMatch(/[\n\r]/);
    expect(rendered.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 16);
  });

  it('every row is text a naive renderer would pass through, so none is vacuous', () => {
    for (const [label, text] of UNSAFE_TEXT) {
      const naive = JSON.stringify(text);
      expect(
        naive.length > MAX_ERROR_BODY || FORBIDDEN_IN_RENDER.test(naive),
        `${label} is already harmless under JSON.stringify — it grades nothing`,
      ).toBe(true);
    }
  });
});
