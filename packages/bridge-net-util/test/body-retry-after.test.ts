import { describe, expect, it } from 'vitest';
import { bodyRetryAfter } from '../src/index.js';

const answer = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 429, headers });

/**
 * CLASS: a 429's body hint, in every unit and every field four vendors state it in. The invariant
 * is the same for all of them — the standard header is a FLOOR the body cannot lower, an unreadable
 * body means "no hint" rather than an error out of the retry loop, and the hint is returned
 * UNCLAMPED, because retrying sooner than the vendor asked is what escalates a rate limit into a
 * ban.
 */
const seconds = bodyRetryAfter<{ retry_after?: unknown }>((b) => b.retry_after, 1000);
const millis = bodyRetryAfter<{ retry_after_ms?: unknown }>((b) => b.retry_after_ms);
const nested = bodyRetryAfter<{ parameters?: { retry_after?: unknown } }>(
  (b) => b.parameters?.retry_after,
  1000,
);

describe('bodyRetryAfter', () => {
  it('scales a stated figure by the vendor’s unit', async () => {
    await expect(seconds(answer({ retry_after: 1.5 }))).resolves.toBe(1500);
    await expect(millis(answer({ retry_after_ms: 1500 }))).resolves.toBe(1500);
    await expect(nested(answer({ parameters: { retry_after: 30 } }))).resolves.toBe(30_000);
  });

  it('lets the header win, so a body can never shorten a stated wait', async () => {
    await expect(seconds(answer({ retry_after: 1 }, { 'retry-after': '9' }))).resolves.toBe(9000);
    await expect(millis(answer({ retry_after_ms: 1 }, { 'retry-after': '9' }))).resolves.toBe(9000);
  });

  it('reads a field the vendor did not put where this parser looks as no hint', async () => {
    await expect(seconds(answer({ retry_after_ms: 5000 }))).resolves.toBeUndefined();
    await expect(nested(answer({ retry_after: 30 }))).resolves.toBeUndefined();
  });

  it.each([
    ['a non-number', { retry_after: '30' }],
    ['zero', { retry_after: 0 }],
    ['a negative figure', { retry_after: -5 }],
    ['null', { retry_after: null }],
    ['an absent field', {}],
  ])('treats %s as no hint rather than a wait', async (_label, body) => {
    await expect(seconds(answer(body))).resolves.toBeUndefined();
  });

  it('swallows a body it cannot parse, so a CDN’s HTML 429 is no hint, not a throw', async () => {
    const html = new Response('<html>too many requests</html>', { status: 429 });
    await expect(seconds(html)).resolves.toBeUndefined();
  });

  it('swallows a hintOf that throws rather than ending the retry loop', async () => {
    const hostile = bodyRetryAfter<Record<string, never>>(() => {
      throw new Error('parser blew up');
    });
    await expect(hostile(answer({}))).resolves.toBeUndefined();
  });

  it('does not consume the response, so the caller can still read the body', async () => {
    const res = answer({ retry_after: 2 });
    await expect(seconds(res)).resolves.toBe(2000);
    await expect(res.text()).resolves.toContain('retry_after');
  });

  it('returns a stated wait unclamped, however long it is', async () => {
    await expect(seconds(answer({ retry_after: 86_400 }))).resolves.toBe(86_400_000);
  });
});
