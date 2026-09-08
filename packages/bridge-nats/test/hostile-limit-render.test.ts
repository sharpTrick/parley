import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NEVER_RENDERABLE, RENDER_LEAK_SENTINEL } from '@sharptrick/parley-net-util';
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
