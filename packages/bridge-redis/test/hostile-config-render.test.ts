import { describe, expect, it } from 'vitest';
import { NEVER_RENDERABLE, RENDER_LEAK_SENTINEL } from '@sharptrick/parley-net-util';
import { CONFIG_KEYS, type RedisBackendConfig, resolveConfig } from '../src/config.js';

/**
 * CLASS: a value is refused on SHAPE, but only after the refusal message has tried to render it.
 * A renderer that throws replaces this plugin's labelled load error with whatever the caller's own
 * value raised — a bare `TypeError` naming neither the key nor the plugin, or the caller's text
 * verbatim in the operator's log and in the model context core renders a seam error into.
 */
const SECRET = 'PLANTED-SECRET-8f3a';

const WRAPPING_A_SECRET: Array<[string, unknown]> = [
  ['an object', { password: SECRET }],
  ['an array', [SECRET]],
  ['a nested object', { outer: { inner: [SECRET] } }],
  ['a null-prototype object', Object.assign(Object.create(null) as object, { v: SECRET })],
];

/** Keys whose value is, or can carry, a credential — the set the renderer refuses to print. */
const CREDENTIAL_KEYS = ['url'];

const refusing = (key: string, value: unknown): string => {
  let raised: unknown;
  try {
    resolveConfig({ [key]: value } as RedisBackendConfig);
  } catch (err) {
    raised = err;
  }
  return raised instanceof Error ? raised.message : String(raised);
};

describe('redis refuses an unrenderable backend_config value under its own label', () => {
  for (const key of CONFIG_KEYS) {
    it.each(NEVER_RENDERABLE)(`${String(key)} = %s is a labelled refusal`, (_label, value) => {
      const message = refusing(String(key), value);
      expect(message).toMatch(/^parley-redis: /);
      expect(message).not.toContain(RENDER_LEAK_SENTINEL);
      expect(message).not.toMatch(/[\n\r]/);
    });
  }
});

describe('redis discloses nothing a rejected backend_config value carries', () => {
  for (const key of CONFIG_KEYS) {
    it.each(WRAPPING_A_SECRET)(`${String(key)} = %s is refused without it`, (_label, value) => {
      const message = refusing(String(key), value);
      expect(message).toMatch(new RegExp(`^parley-redis: .*\\b${String(key)}\\b`));
      expect(message).not.toContain(SECRET);
      expect(message).not.toMatch(/[\n\r]/);
    });

    it(`${String(key)} = a bare secret string is never echoed back when it is refused`, () => {
      const message = refusing(String(key), `redis://parley:${SECRET}@bus.example.test:6379`);
      if (CREDENTIAL_KEYS.includes(String(key))) expect(message).not.toContain(SECRET);
    });
  }
});
