import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IN_RENDER,
  MAX_ERROR_BODY,
  NEVER_RENDERABLE,
  RENDER_LEAK_SENTINEL,
  UNSAFE_TEXT,
} from '@sharptrick/parley-net-util';
import { normalizeLimit } from '../src/cursor.js';

/**
 * CLASS: a `limit` is refused on SHAPE, but only after the refusal message has tried to render it.
 * A renderer that throws replaces the named refusal with whatever the caller's own value raised —
 * and a page size that is refused unlabelled is one an operator cannot connect to their config.
 */
describe('nats refuses an unrenderable limit under its own label', () => {
  it.each(NEVER_RENDERABLE)('limit = %s is a labelled refusal', (_label, value) => {
    let raised: unknown;
    try {
      normalizeLimit(value as number, asTopic('room'));
    } catch (err) {
      raised = err;
    }
    const message = raised instanceof Error ? raised.message : String(raised);
    expect(message).toMatch(/^invalid nats limit /);
    expect(message).not.toContain(RENDER_LEAK_SENTINEL);
    expect(message).not.toMatch(/[\n\r]/);
  });
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

describe('nats discloses nothing a rejected limit carries', () => {
  it.each(WRAPPING_A_SECRET)('limit = %s is refused without it', (_label, value) => {
    let raised: unknown;
    try {
      normalizeLimit(value as number, asTopic('room'));
    } catch (err) {
      raised = err;
    }
    expect(raised, 'a wrapped value must still be refused, or this row grades nothing').toBeInstanceOf(Error);
    const message = (raised as Error).message;
    expect(message).toMatch(/^invalid nats limit /);
    expect(message).not.toContain(SECRET);
    expect(message).not.toMatch(/[\n\r]/);
  });
});

/**
 * CLASS: the value's TEXT is untrusted too. A numeric knob given a STRING is refused, and that
 * string is what the refusal renders — the only path by which caller-authored text reaches an
 * operator's log and the model context core renders a seam error into. A container never gets here:
 * it is described by shape, which is why the hostile-OBJECT table above cannot grade the sanitiser.
 */
describe('nats bounds and flattens the text a rejected value carries', () => {
  for (const key of ['limit'] as const) {
    it.each(UNSAFE_TEXT)(`${String(key)} = %s is refused as one bounded, harmless line`, (_label, text) => {
      let raised: unknown;
      try {
        normalizeLimit(text as unknown as number, asTopic('room'));
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
