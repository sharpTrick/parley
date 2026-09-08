import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_RENDER,
  MAX_ERROR_BODY,
  NEVER_RENDERABLE,
  RENDER_LEAK_SENTINEL,
  UNSAFE_TEXT,
} from '@sharptrick/parley-net-util';
import { validateBackendConfig } from '../src/config.js';

/**
 * CLASS: a value is refused on SHAPE, but only after the refusal message has tried to render it.
 * A renderer that throws replaces this plugin's labelled load error with whatever the caller's own
 * value raised — a bare `TypeError` naming neither the key nor the plugin, or the caller's text
 * verbatim in the operator's log and in the model context core renders a seam error into.
 */
const KNOBS = ['url', 'table_name', 'pool_size', 'retention_days'] as const;

describe('postgres refuses an unrenderable backend_config value under its own label', () => {
  for (const key of KNOBS) {
    it.each(NEVER_RENDERABLE)(`${key} = %s is a labelled refusal`, (_label, value) => {
      let raised: unknown;
      try {
        validateBackendConfig({ [key]: value });
      } catch (err) {
        raised = err;
      }
      const message = raised instanceof Error ? raised.message : String(raised);
      expect(message).toMatch(new RegExp(`^parley-postgres: invalid backend_config\\.${key} `));
      expect(message).not.toContain(RENDER_LEAK_SENTINEL);
      expect(message).not.toMatch(/[\n\r]/);
    });
  }
});

const SECRET = 'PLANTED-SECRET-8f3a';

/**
 * CLASS: the branch that hands a rejected value to the renderer reads `not a non-empty string`, so
 * it admits every CONTAINER a secret can be nested inside — and a credential key holds one even when
 * the value IS a string. A refusal that enumerates the container, or prints the credential, puts it
 * in the operator's log and in the model context core renders a seam error into.
 */
const WRAPPING_A_SECRET: Array<[string, unknown]> = [
  ['an object', { password: SECRET }],
  ['an array', [SECRET]],
  ['a nested object', { outer: { inner: [SECRET] } }],
  [
    'a null-prototype object',
    Object.assign(Object.create(null) as object, { v: SECRET }),
  ],
];

/** Keys whose value is, or can carry, a credential — the set the renderer refuses to print. */
const CREDENTIAL_KEYS = ['url'];

describe('postgres discloses nothing a rejected backend_config value carries', () => {
  for (const key of KNOBS) {
    it.each(WRAPPING_A_SECRET)(`${key} = %s is refused without it`, (_label, value) => {
      let raised: unknown;
      try {
        validateBackendConfig({ [key]: value });
      } catch (err) {
        raised = err;
      }
      expect(raised, 'a wrapped value must still be refused, or this row grades nothing').toBeInstanceOf(Error);
      const message = (raised as Error).message;
      expect(message).toMatch(new RegExp(`^parley-postgres: invalid backend_config\\.${key} `));
      expect(message).not.toContain(SECRET);
      expect(message).not.toMatch(/[\n\r]/);
    });

    it(`${key} = a bare secret string is never echoed back when it is refused`, () => {
      let raised: unknown;
      try {
        validateBackendConfig({ [key]: `postgres://parley:${SECRET}@db/parley` });
      } catch (err) {
        raised = err;
      }
      const message = raised instanceof Error ? raised.message : '';
      if (CREDENTIAL_KEYS.includes(key)) expect(message).not.toContain(SECRET);
    });
  }
});

/**
 * CLASS: the value's TEXT is untrusted too. A numeric knob given a STRING is refused, and that
 * string is what the refusal renders — the only path by which caller-authored text reaches an
 * operator's log and the model context core renders a seam error into. A container never gets here:
 * it is described by shape, which is why the hostile-OBJECT table above cannot grade the sanitiser.
 */
describe('postgres bounds and flattens the text a rejected value carries', () => {
  for (const key of ['pool_size', 'retention_days'] as const) {
    it.each(UNSAFE_TEXT)(`${String(key)} = %s is refused as one bounded, harmless line`, (_label, text) => {
      let raised: unknown;
      try {
        validateBackendConfig({ [key]: text });
      } catch (err) {
        raised = err;
      }
      expect(raised, 'a text value must still be refused, or this row grades nothing').toBeInstanceOf(Error);
      const message = (raised as Error).message;
      expect(message).not.toMatch(FORBIDDEN_IN_RENDER);
      expect(message).not.toMatch(/[\n\r]/);
      expect(message.length).toBeLessThan(MAX_ERROR_BODY + 1024);
    });
  }
});
