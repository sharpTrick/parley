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
