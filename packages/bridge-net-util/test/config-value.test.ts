import { describe, expect, it } from 'vitest';
import { MAX_ERROR_BODY } from '../src/index.js';
import {
  FORBIDDEN_IN_RENDER,
  NEVER_RENDERABLE,
  RENDER_LEAK_SENTINEL,
  SECRET_AS_TEXT,
  UNSAFE_TEXT,
  WRAPPING_A_SECRET,
} from '../src/testing/index.js';
import { describeConfigShape, describeConfigValue, RENDERED_BY_VALUE } from '../src/config-value.js';
import { backendConfigDeclarations, keysRenderedByName } from './declared-config-keys.js';

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

  const RENDERING_KEYS = Object.keys(RENDERED_BY_VALUE);

  it.each(WRAPPERS)('%s discloses nothing under any key at all', (_label, value) => {
    for (const key of [...RENDERING_KEYS, 'url', 'password', 'bot_token', 'nkey_seed'])
      expect(describeConfigValue(key, value)).not.toContain(SECRET);
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
describe('the secret-carrying corpus reaches every type that can carry text', () => {
  const carriers: readonly (readonly [string, unknown])[] = [...WRAPPING_A_SECRET, SECRET_AS_TEXT];

  it.each(['string', 'symbol', 'object', 'function'])(
    'a %s whose own text is the secret is in the corpus',
    (type) => {
      expect(
        carriers.filter(([, value]) => typeof value === type).map(([label]) => label),
        `no row is a ${type}, so the renderer's ${type} arm is driven by nothing`,
      ).not.toEqual([]);
    },
  );

  const attempt = (render: () => string | undefined): string => {
    try {
      return render() ?? '';
    } catch {
      return '';
    }
  };

  const carries = (value: unknown, seen = new Set<unknown>()): boolean => {
    if (attempt(() => String(value)).includes(SECRET)) return true;
    if (attempt(() => JSON.stringify(value)).includes(SECRET)) return true;
    if (typeof value !== 'object' || value === null || seen.has(value)) return false;
    seen.add(value);
    return Reflect.ownKeys(value).some((key) =>
      carries((value as Record<PropertyKey, unknown>)[key], seen),
    );
  };

  it('every carrier really carries the secret, so the rows above are not vacuous', () => {
    for (const [label, value] of carriers) {
      expect(carries(value), `${label} does not carry the secret`).toBe(true);
    }
  });
});

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

/**
 * CLASS: the render policy is keyed on the config key NAME, so the set it has to be right about is
 * the set of names the backends DECLARE — not a list of credential-ish substrings kept beside the
 * renderer. Read from each plugin's own `satisfies Record<keyof Required<…>>` block, so that a key
 * added to any backend is graded by existing rather than by being remembered. `nkey_seed` and
 * `creds_file` were declared keys the whole time the substring list was in force, and both rendered
 * by value; nats escaped only by having kept a private shape-only renderer of its own.
 */
describe('an unrecognised backend_config key is described, never rendered by content', () => {
  const declared = [...new Set(backendConfigDeclarations().flatMap((d) => d.keys))].sort();
  const namedInSource = keysRenderedByName();
  const everyKey = [...new Set([...declared, ...namedInSource])].sort();

  it('reads the declarations at all, so the rows below are not vacuous', () => {
    expect(declared.length).toBeGreaterThan(30);
    expect(namedInSource.length).toBeGreaterThan(3);
  });

  it.each(everyKey)('%s renders by shape, or is recorded by name with a reason', (key) => {
    const reason = RENDERED_BY_VALUE[key];
    if (reason !== undefined) {
      expect(reason, `${key} is rendered by value with no reason stated`).not.toBe('');
      return;
    }
    expect(
      describeConfigValue(key, `scheme://parley:${SECRET}@host/db`),
      `${key} renders a declared config value by content and nothing says why that is safe`,
    ).not.toContain(SECRET);
  });

  /**
   * A string-keyed policy table read with `[key]` answers for every name `Object.prototype` carries,
   * and no exhaustiveness row can see one: they all walk `Object.keys`, which never yields an
   * inherited name. Generated from the prototype rather than from the eight names that were found,
   * so a name added to `Object.prototype` by a future runtime is covered by existing.
   */
  it.each(Object.getOwnPropertyNames(Object.prototype))(
    'a config key named %s is described, not rendered',
    (key) => {
      expect(
        describeConfigValue(key, `scheme://parley:${SECRET}@host/db`),
        `${key} is inherited from Object.prototype, so the policy table answers for it`,
      ).not.toContain(SECRET);
    },
  );

  /**
   * The table is fail-closed, so every hole in it is a row ADDED — and nothing above constrains
   * membership: each row asks only that a reason is stated, that the key is declared somewhere, and
   * that the key does render by value. Adding `password`, `token`, `nkey_seed` and `url` with the
   * reason 'operators need to see it' satisfied all four and was 3446 passed / 0 failed.
   *
   * Graded from the CREDENTIAL side instead: a key whose name says its value can BE a credential
   * may not be in the table at all, whatever reason is written beside it.
   */
  const CREDENTIAL_NOUN =
    /^(pass|passwd|password|pwd|secret|token|auth|key|keys|cred|creds|credential|credentials|seed|dsn|uri|url|cookie|session|pat|bearer|sig|signature|signing|private|pem|conn)$/;
  const namesACredential = (key: string): boolean => key.split('_').some((s) => CREDENTIAL_NOUN.test(s));

  /**
   * The one key whose credential-shaped segment names a NAMESPACE rather than a value. Each entry
   * is graded from both sides below, so an exemption written to smuggle a credential in has to be
   * false about a key that is really in the table and really matches.
   */
  const NAMES_A_NAMESPACE: Readonly<Record<string, string>> = {
    key_prefix: 'the prefix this backend mints its Redis keys under; it holds no key material',
  };

  it('records no key whose name says its value can be a credential', () => {
    expect(
      Object.keys(RENDERED_BY_VALUE).filter(
        (key) => namesACredential(key) && NAMES_A_NAMESPACE[key] === undefined,
      ),
      'this key renders by value and its name says the value can be a credential',
    ).toEqual([]);
  });

  it.each(Object.keys(NAMES_A_NAMESPACE))('%s is a live exemption, not a stale one', (key) => {
    expect(RENDERED_BY_VALUE[key], `${key} is exempted from a table it is not in`).toBeDefined();
    expect(namesACredential(key), `${key} needs no exemption`).toBe(true);
    expect(NAMES_A_NAMESPACE[key], `${key} is exempted with no reason`).not.toBe('');
  });

  it.each(['password', 'token', 'nkey_seed', 'url', 'api_key', 'bot_token', 'creds_file', 'pass'])(
    'the credential rule would catch %s',
    (key) => {
      expect(namesACredential(key)).toBe(true);
    },
  );

  it.each(['block_ms', 'retention_days', 'room_preset', 'table_name', 'username', 'nick', 'domain'])(
    'the credential rule leaves %s alone',
    (key) => {
      expect(namesACredential(key)).toBe(false);
    },
  );

  it('records no key no backend declares or renders', () => {
    expect(
      Object.keys(RENDERED_BY_VALUE).filter((key) => !everyKey.includes(key)),
      'this entry excuses a key nothing in the repo uses',
    ).toEqual([]);
  });

  it('still renders the keys it records, so the table is not a no-op', () => {
    for (const key of Object.keys(RENDERED_BY_VALUE))
      expect(describeConfigValue(key, 'a-visible-value')).toContain('a-visible-value');
  });
});
