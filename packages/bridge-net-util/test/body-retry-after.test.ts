import { describe, expect, it } from 'vitest';
import { bodyRetryAfter, fetchWithRetry, MAX_BODY_WAIT_MS } from '../src/index.js';
import { captureWaits, resetGlobalsAfterEach, stubFetch } from './fixtures.js';

const answer = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 429, headers });

/**
 * CLASS: a 429's body hint, in every unit and every field four vendors state it in. The invariant
 * is the same for all of them — the standard header is a FLOOR the body cannot lower, an unreadable
 * body means "no hint" rather than an error out of the retry loop, and a figure this reports is the
 * one the vendor stated — retrying sooner than that is what escalates a rate limit into a ban, and
 * the one ceiling there is lives where the loop ADOPTS the figure (see below).
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

  /**
   * Both orderings, for all three vendor shapes. The row this replaced picked header 9s against
   * body 1s — the ONE ordering where "the header wins" and "the header is a floor" agree, so it
   * could not tell them apart, and the code was returning the header as the ANSWER. A CDN stamping
   * `Retry-After: 1` in front of a vendor asking 60s is the case that matters, and it is the one
   * that ordering never asked.
   */
  const HINT_PAIRS: Array<[header: number | undefined, body: number | undefined, wait: number]> = [
    [9000, 1000, 9000],
    [1000, 1500, 1500],
    [undefined, 1500, 1500],
    [9000, undefined, 9000],
  ];

  const headers = (header: number | undefined): Record<string, string> =>
    header === undefined ? {} : { 'retry-after': String(header / 1000) };

  it.each(HINT_PAIRS)(
    'header %s + body %s waits the longer of the two: %ims',
    async (header, body, wait) => {
      await expect(
        seconds(answer(body === undefined ? {} : { retry_after: body / 1000 }, headers(header))),
      ).resolves.toBe(wait);
      await expect(
        millis(answer(body === undefined ? {} : { retry_after_ms: body }, headers(header))),
      ).resolves.toBe(wait);
      await expect(
        nested(
          answer(
            body === undefined ? {} : { parameters: { retry_after: body / 1000 } },
            headers(header),
          ),
        ),
      ).resolves.toBe(wait);
    },
  );

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

});

/**
 * CLASS: a quantity a server puts in a response body governs how long THIS process waits, and is
 * adopted with no ceiling. Unbounded, one JSON number states a wait past any deadline and the call
 * is REFUSED rather than retried — a kill switch on every request through the shared loop, for
 * every backend that reads a body hint. Graded at the level the property is observable: what
 * `fetchWithRetry` DOES, not what the parser returns.
 *
 * The `Retry-After` HEADER is deliberately NOT bounded — it is RFC 9110's own field, single-valued,
 * and a call it puts past the deadline ends with a message telling the caller to raise `deadlineMs`.
 * The body field and its unit are a per-backend guess, so a body past {@link MAX_BODY_WAIT_MS} is
 * dropped exactly as an unreadable one is.
 */
const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;
const TEN_YEARS_MS = 315_360_000_000;

type Outcome = { retried: true; waited: number } | { retried: false };

const RETRIED = (waited: number): Outcome => ({ retried: true, waited });
const REFUSED: Outcome = { retried: false };

/** Drive one 429-then-200 exchange through the real loop and report what it did. */
/** Each vendor shape this module builds, with the body that states `ms` in ITS field and unit. */
const BODY_SHAPES: Array<
  [label: string, hint: (res: Response) => Promise<number | undefined>, encode: (ms: number) => unknown]
> = [
  ['seconds', seconds, (ms) => ({ retry_after: ms / 1000 })],
  ['milliseconds', millis, (ms) => ({ retry_after_ms: ms })],
  ['nested seconds', nested, (ms) => ({ parameters: { retry_after: ms / 1000 } })],
];

const outcomeOf = async (
  header: number | undefined,
  hint: (res: Response) => Promise<number | undefined>,
  body: unknown,
): Promise<Outcome> => {
  stubFetch([
    new Response(JSON.stringify(body), {
      status: 429,
      headers: header === undefined ? {} : { 'retry-after': String(header / 1000) },
    }),
    new Response('done', { status: 200 }),
  ]);
  const waits = captureWaits();
  const out = await fetchWithRetry(
    'https://x/y',
    {},
    { label: 'L', isStopped: () => false, retryAfterOf: hint, now: () => 0 },
  ).then(
    () => true,
    () => false,
  );
  return out ? { retried: true, waited: waits[0] as number } : { retried: false };
};

const ADOPTION: Array<[label: string, header: number | undefined, body: number, out: Outcome]> = [
  ['no header + a 1s body waits the body', undefined, SECOND_MS, RETRIED(SECOND_MS)],
  ['no header + a 1h body refuses, and says to raise the deadline', undefined, HOUR_MS, REFUSED],
  ['no header + a 10y body cannot end the call', undefined, TEN_YEARS_MS, RETRIED(500)],
  ['a 1s header + a 1s body waits 1s', SECOND_MS, SECOND_MS, RETRIED(SECOND_MS)],
  ['a 1s header + a 1h body adopts the body', SECOND_MS, HOUR_MS, REFUSED],
  ['a 1s header + a 10y body waits the header', SECOND_MS, TEN_YEARS_MS, RETRIED(SECOND_MS)],
  ['a 1h header refuses whatever the body says', HOUR_MS, SECOND_MS, REFUSED],
  ['a 10y header refuses whatever the body says', TEN_YEARS_MS, SECOND_MS, REFUSED],
];

describe('a body-stated wait governing this process', () => {
  resetGlobalsAfterEach();

  it.each(ADOPTION)('%s', async (_label, header, body, expected) => {
    for (const [shape, hint, encode] of BODY_SHAPES) {
      expect(await outcomeOf(header, hint, encode(body)), `stated in ${shape}`).toEqual(expected);
    }
  });

  /**
   * The property the rows above spell out one by one: past the ceiling the body is not a wait, so
   * the loop does exactly what it would have done with no body at all. Stated over the HEADERS so
   * that a row added to either axis is asked, rather than over a hand-paired list.
   */
  it.each([
    ['no header', undefined],
    ['a 1s header', SECOND_MS],
    ['a 1h header', HOUR_MS],
    ['a 10y header', TEN_YEARS_MS],
  ] as Array<[string, number | undefined]>)(
    'an absurd body leaves %s deciding the call alone',
    async (_label, header) => {
      for (const [shape, hint, encode] of BODY_SHAPES) {
        expect(await outcomeOf(header, hint, encode(TEN_YEARS_MS)), `stated in ${shape}`).toEqual(
          await outcomeOf(header, hint, {}),
        );
      }
    },
  );

  it('states the ceiling as a figure a consumer can read, not as a literal in the loop', () => {
    expect(MAX_BODY_WAIT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_BODY_WAIT_MS)).toBe(true);
  });
});
