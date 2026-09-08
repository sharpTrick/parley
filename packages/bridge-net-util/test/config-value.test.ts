import { describe, expect, it } from 'vitest';
import { describeConfigShape, describeConfigValue, MAX_ERROR_BODY } from '../src/index.js';
import { NEVER_RENDERABLE, RENDER_LEAK_SENTINEL } from './never-renderable.js';

/**
 * CLASS: a rejected `backend_config` value is rendered into an error an operator reads and core
 * hands to a model. Whatever a caller put in the YAML, rendering it may not throw, may not carry
 * text the caller wrote, and may not forge line structure or run unbounded.
 */
describe('describeConfigValue survives every value a backend_config can hold', () => {
  it.each(NEVER_RENDERABLE)('renders %s without throwing', (_label, value) => {
    expect(() => describeConfigValue(value)).not.toThrow();
  });

  it.each(NEVER_RENDERABLE)('never echoes what %s put in its own message', (_label, value) => {
    expect(describeConfigValue(value)).not.toContain(RENDER_LEAK_SENTINEL);
  });

  it.each(NEVER_RENDERABLE)('renders %s as one bounded line', (_label, value) => {
    const text = describeConfigValue(value);
    expect(text).not.toMatch(/[\n\r]/);
    expect(text.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 16);
  });

  it('flattens and bounds a value a caller authored', () => {
    expect(describeConfigValue('a\nb')).not.toMatch(/\n/);
    expect(describeConfigValue('x'.repeat(MAX_ERROR_BODY * 2))).toContain('[truncated]');
  });

  it('keeps NaN readable, which JSON.stringify alone turns into null', () => {
    expect(describeConfigValue(Number.NaN)).toBe('NaN');
    expect(describeConfigValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
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
