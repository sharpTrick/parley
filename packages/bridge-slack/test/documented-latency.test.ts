/**
 * CLASS: prose that restates something the code owns must be checked against the code.
 *
 * The rate-limit paragraph restates a policy that lives in `@sharptrick/parley-net-util`, which has
 * already changed under it once — the README kept claiming a server-stated `Retry-After` was clamped
 * to 5 s long after the helper began honouring it in full. Prose cannot be diffed against a helper,
 * so the paragraph is required to name each constant it depends on BY VALUE, imported from the
 * helper: a policy change then fails here instead of misleading an operator.
 */
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_DEADLINE_MS,
} from '@sharptrick/parley-net-util';
import { DIAL_BACKOFF_MS, MAX_DIAL_BACKOFF_MS } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('slack rate-limit docs track the shared helper', () => {
  const paragraph = (): string => {
    const readme = read('../README.md');
    const found = /\*\*Rate-limit behaviour\.\*\*([\s\S]*?)\n\n/.exec(readme);
    expect(found, 'README has no **Rate-limit behaviour.** paragraph').not.toBeNull();
    return found![1]!;
  };

  const seconds = (ms: number): string => `${ms / 1000} s`;

  it('names every net-util constant it depends on, by value', () => {
    const text = paragraph();
    for (const [name, ms] of [
      ['DEFAULT_DEADLINE_MS', DEFAULT_DEADLINE_MS],
    ] as const) {
      expect(text, `${name} value missing`).toContain(seconds(ms));
      expect(text, `${name} not named`).toContain(name);
    }
    expect(text).toContain('DEFAULT_BACKOFF_MS');
    expect(text).toContain(`${DEFAULT_BACKOFF_MS} ms`);
  });

  it('does not restate the superseded rule that a stated hint is clamped', () => {
    const text = paragraph();
    expect(text).toMatch(/honoured\s+\*\*in full\*\*/);
    expect(text).not.toMatch(/`Retry-After`[\s\S]*honoured up to/);
  });

  // The same paragraph now quotes the degradation ladder, and an operator reads its cost/latency
  // claim off those two figures — so they are pinned by value from the source, like the net-util set.
  it('names the degradation ladder constants it depends on, by value', () => {
    const text = paragraph();
    expect(text, 'DIAL_BACKOFF_MS not named').toContain('DIAL_BACKOFF_MS');
    expect(text, 'DIAL_BACKOFF_MS value missing').toContain(`${DIAL_BACKOFF_MS} ms`);
    expect(text, 'MAX_DIAL_BACKOFF_MS not named').toContain('MAX_DIAL_BACKOFF_MS');
    expect(text, 'MAX_DIAL_BACKOFF_MS value missing').toContain(seconds(MAX_DIAL_BACKOFF_MS));
  });
});
