import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@sharptrick/parley-net-util';
import {
  DEFAULT_BACKOFF_MS,
  fetchWithRetry,
  retryAfterFromHeader,
} from '@sharptrick/parley-net-util';
import {
  captureWaits,
  documentedFigure,
  loop,
  OPTS,
  rejects,
  res,
  resetGlobalsAfterEach,
  stubFetch,
  stubForever,
  stubStalling,
} from './fixtures.js';

resetGlobalsAfterEach();

describe('fetchWithRetry', () => {
  it('retries a 429 until success and returns the final response', async () => {
    const state = stubFetch([res(429), res(429), res(200, 'done')]);
    const out = await fetchWithRetry('https://x/y', {}, OPTS);
    expect(await out.text()).toBe('done');
    expect(state.calls).toBe(3);
  });

  it('awaits an async retryAfterOf (backends that read the 429 body)', async () => {
    stubFetch([res(429, '{"retry_after":0.005}'), res(200)]);
    const retryAfterOf = async (r: Response): Promise<number> => {
      const body = (await r.clone().json()) as { retry_after: number };
      return body.retry_after * 1000;
    };
    const out = await fetchWithRetry('https://x/y', {}, { ...OPTS, retryAfterOf });
    expect(out.status).toBe(200);
  });

  // The loop must terminate against a permanently-failing upstream. A fixed response array cannot
  // express "forever" — it runs out and the stub throws — which is why no earlier test caught this.
  it.each([
    ['bare 429', () => res(429)],
    ['429 with a huge Retry-After', () => res(429, '', { 'retry-after': '86400' })],
    ['429 with no Retry-After at all', () => res(429, 'slow down')],
  ])('gives up on a permanently rate-limited upstream (%s)', async (_label, make) => {
    const state = stubForever(make);
    captureWaits();
    let clock = 0;
    await expect(
      fetchWithRetry(
        'https://x/y',
        {},
        { ...OPTS, retryAfterOf: () => 1, maxAttempts: 4, now: () => (clock += 10) },
      ),
    ).rejects.toThrow(/still rate limited after \d+ attempts|past this call's \d+ms deadline/);
    expect(state.calls).toBeLessThanOrEqual(4);
  });

  // The attempt cap a caller gets by NOT passing one. Every row around this states its own
  // `maxAttempts`, so the shipped default was a figure nothing here graded — and it decides how many
  // requests every consuming backend spends against a rate limiter before giving up. The figure is
  // read off the README rather than off the export, so that MOVING the export is what fails: a row
  // comparing the constant with itself passes at any value, which is how the default got here.
  const documentedAttemptCap = (): number =>
    documentedFigure(/`DEFAULT_MAX_ATTEMPTS` \((\d+)\)/, 'the default attempt cap');

  it('spends the documented default number of attempts when the caller sets no cap', async () => {
    const state = stubForever(() => res(429, '', { 'retry-after': '0.001' }));
    captureWaits();
    let clock = 0;
    const err = await rejects(fetchWithRetry('https://x/y', {}, loop({ now: () => (clock += 1) })));
    expect(state.calls).toBe(documentedAttemptCap());
    expect(err.message).toMatch(
      new RegExp(`still rate limited after ${documentedAttemptCap()} attempts`),
    );
  });

  it('gives up on the wall-clock deadline before reaching the attempt cap', async () => {
    const state = stubForever(() => res(429));
    captureWaits();
    let clock = 0;
    await expect(
      fetchWithRetry(
        'https://x/y',
        {},
        {
          ...OPTS,
          retryAfterOf: () => 1,
          maxAttempts: 1000,
          deadlineMs: 100,
          now: () => (clock += 40),
        },
      ),
    ).rejects.toThrow(/deadline: exceeded 100ms|still rate limited/);
    expect(state.calls).toBeLessThan(10);
  });

  // `deadlineMs` is documented as a ceiling on the WHOLE call. Every earlier deadline test used a
  // fetch that resolved instantly, so none of them could see a request that simply never answers —
  // the dominant hang shape, and the one `isStopped` cannot break out of.
  it.each([
    ['a request that never answers', { settleAfterMs: undefined }, 1],
    ['a request that answers long after the deadline', { settleAfterMs: 5_000 }, 1],
  ])('honours the deadline against %s', async (_label, stallOpts, maxCalls) => {
    const state = stubStalling(stallOpts);
    const started = Date.now();
    const err = await rejects(
      fetchWithRetry('https://x/y', {}, loop({ deadlineMs: 80 })),
    );
    expect(err.message).toMatch(/deadline/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(state.calls).toBeLessThanOrEqual(maxCalls);
  });

  it('honours the deadline when the stall arrives on a retry after a 429', async () => {
    let first = true;
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
      if (first) {
        first = false;
        return Promise.resolve(res(429, '', { 'retry-after': '0.001' }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      });
    });
    const started = Date.now();
    const err = await rejects(
      fetchWithRetry('https://x/y', {}, loop({ deadlineMs: 120 })),
    );
    expect(err.message).toMatch(/deadline/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // A client-side ceiling that retries SOONER than the server asked is worse than not retrying:
  // Discord and Slack escalate repeated 429s to longer global bans. The `Retry-After` header is a
  // FLOOR: crossed with every shape of caller parser, including ones that shrink it (which is what
  // two shipped backends' parsers did), no performed wait may fall below the header's own figure.
  // Each row states the header as a LIST of field-values, appended one at a time: a gateway and an
  // origin both setting `Retry-After` is what `Headers.get` returns as `"120, 120"`, and reading
  // that as no hint at all retried at the 500ms default against a server asking for two minutes.
  const HEADER_ROWS: [string, () => string[], number, string][] = [
    ['delay-seconds past the deadline', () => ['60'], 60_000, 'stop'],
    ['HTTP-date past the deadline', () => [pinnedDate(120_000)], 120_000, 'stop'],
    ['delay-seconds well within the deadline', () => ['2'], 2_000, 'retry'],
    ['HTTP-date well within the deadline', () => [pinnedDate(3_000)], 3_000, 'retry'],
    // The discriminating pair: above MAX_BACKOFF_MS, which bounds only a backoff we invented, and
    // inside the deadline — so the wait must be the server's full figure, not the 5s clamp. This is
    // the ordinary Slack/Telegram rate limit, and clamping it is what escalates a 429 into a ban.
    ['delay-seconds above the self-imposed clamp', () => ['10'], 10_000, 'retry'],
    ['HTTP-date above the self-imposed clamp', () => [pinnedDate(9_000)], 8_000, 'retry'],
    ['zero', () => ['0'], 0, 'retry'],
    ['empty', () => [''], 0, 'retry'],
    ['unparseable', () => ['abc'], 0, 'retry'],
    ['fractional seconds', () => ['0.5'], 500, 'retry'],
    ['negative', () => ['-5'], 0, 'retry'],
    ['a date already past', () => [pinnedDate(-60_000)], 0, 'retry'],
    ['absent', () => [], 0, 'retry'],
    // Multi-valued: whatever the largest field-value states is the floor, and the whole header is
    // never no-hint just because it carries more than one value.
    ['the same delay-seconds twice', () => ['2', '2'], 2_000, 'retry'],
    ['the same delay-seconds twice, past the deadline', () => ['60', '60'], 60_000, 'stop'],
    ['two different delay-seconds', () => ['2', '10'], 10_000, 'retry'],
    ['two HTTP-dates', () => [pinnedDate(3_000), pinnedDate(9_000)], 8_000, 'retry'],
    ['a delay-seconds beside an HTTP-date', () => ['2', pinnedDate(9_000)], 8_000, 'retry'],
    ['a usable value beside an unparseable one', () => ['abc', '10'], 10_000, 'retry'],
    ['two unparseable values', () => ['abc', 'def'], 0, 'retry'],
    // Spellings `Number` accepts and RFC 9110 `delay-seconds` does not. Read as a figure they would
    // be 500s and 1000s — past the deadline, so a misparse ENDS the call on a routine 429.
    ['a hexadecimal spelling', () => ['0x1F4'], 0, 'retry'],
    ['an exponent spelling', () => ['1e3'], 0, 'retry'],
  ];

  /**
   * Keep the response's `Date` and its HTTP-date `Retry-After` on ONE pinned instant, so that a row
   * asserting a floor cannot fail on the milliseconds the harness itself took: `toUTCString()`
   * truncates to whole seconds, and a floor stated as `offset - 1000` had no slack left for elapsed
   * time. Reading both from the same clock also makes the stated floor the exact figure rather than
   * a second-wide range.
   */
  const SERVER_INSTANT = Date.UTC(2026, 6, 30, 12, 0, 0);
  const pinnedDate = (offsetMs: number): string =>
    new Date(SERVER_INSTANT + offsetMs).toUTCString();

  const headersOf = (values: string[]): Headers => {
    const headers = new Headers();
    headers.set('date', new Date(SERVER_INSTANT).toUTCString());
    for (const value of values) headers.append('retry-after', value);
    return headers;
  };

  // Every shape a consumer's own `retryAfterOf` can take. `bridge-telegram` and `bridge-matrix`
  // ship the clamping one; a hint that is absent, zero, NaN or negative is no hint at all.
  const PARSERS: [string, (res: Response) => number | undefined][] = [
    ['no parser', () => undefined],
    ['a clamping parser', (r) => Math.min(retryAfterFromHeader(r) ?? 0, 5_000) || undefined],
    ['a doubling parser', (r) => (retryAfterFromHeader(r) ?? 0) * 2 || undefined],
    ['a zero parser', () => 0],
    ['a NaN parser', () => Number.NaN],
    ['a negative parser', () => -1],
  ];

  it.each(
    HEADER_ROWS.flatMap(([label, values, requestedMs, outcome]) =>
      PARSERS.map(
        ([parserLabel, retryAfterOf]) =>
          [`${label}, with ${parserLabel}`, values, requestedMs, outcome, retryAfterOf] as const,
      ),
    ),
  )(
    'never retries sooner than the server asked (%s)',
    async (_label, values, requestedMs, outcome, retryAfterOf) => {
      const state = stubForever(() => new Response('', { status: 429, headers: headersOf(values()) }));
      const waits = captureWaits();
      let clock = 0;
      const err = await rejects(
        fetchWithRetry(
          'https://x/y',
          {},
          loop({ maxAttempts: 8, retryAfterOf, now: () => (clock += 1) }),
        ),
      );
      if (outcome === 'stop') {
        expect(state.calls).toBe(1);
        expect(waits).toEqual([]);
        expect(err.message).toMatch(/past this call's 30000ms deadline/);
        const reported = Number(/asked for (\d+)ms/.exec(err.message)?.[1]);
        expect(reported).toBeGreaterThanOrEqual(requestedMs - 2_000);
      } else {
        // Eight of the header rows state nothing, so comparing against `requestedMs` alone made 48
        // of these cells `w >= 0` — vacuously true, and the only backoff the module invents for
        // itself asserted nowhere. The floor is whichever is larger, and it is never zero.
        const floorMs = Math.max(requestedMs, DEFAULT_BACKOFF_MS);
        expect(floorMs).toBeGreaterThan(0);
        expect(state.calls).toBeGreaterThan(1);
        expect(waits.length).toBeGreaterThan(0);
        for (const w of waits) expect(w).toBeGreaterThanOrEqual(floorMs);
      }
    },
  );

  // A floor of 500 is satisfied by 500, 5 000 or 50 000 alike, so the one wait this module invents
  // for itself is also pinned exactly — including its ceiling.
  it('waits exactly the default backoff for a 429 with no hint of any kind', async () => {
    stubFetch([res(429, 'slow down'), res(200, 'ok')]);
    const waits = captureWaits();
    const out = await fetchWithRetry('https://x/y', {}, loop());
    expect(out.status).toBe(200);
    expect(waits).toEqual([DEFAULT_BACKOFF_MS]);
  });

  // A caller's parser is arbitrary code, and the ordinary one reads the body: `res.clone().json()`
  // against a CDN's HTML 429 page throws. Unguarded, THAT error left the module — no label, no
  // redaction, and `statusOf` undefined, so a caller branching on 429 saw nothing. A hook that
  // cannot read the body means "no usable hint"; it may not fail the call and it may not lower the
  // header's floor. Every shipped parser happens to catch internally, which is why nothing was red.
  const HOSTILE_PARSERS: [string, (res: Response) => number | undefined][] = [
    [
      'a parser that throws',
      () => {
        throw new SyntaxError("Unexpected token '<', \"<html>rate\"... is not valid JSON");
      },
    ],
    ['a parser that rejects', () => Promise.reject(new Error('body unreadable')) as never],
    ['a parser that returns a non-number', () => 'soon' as never],
  ];

  it.each(
    HOSTILE_PARSERS.flatMap(([parserLabel, retryAfterOf]) =>
      (
        [
          ['no Retry-After', {}, DEFAULT_BACKOFF_MS],
          ['a Retry-After floor', { 'retry-after': '2' }, 2_000],
        ] as [string, Record<string, string>, number][]
      ).map(
        ([headerLabel, headers, floorMs]) =>
          [`${parserLabel}, with ${headerLabel}`, retryAfterOf, headers, floorMs] as const,
      ),
    ),
  )('keeps %s inside the error envelope', async (_label, retryAfterOf, headers, floorMs) => {
    stubForever(() => res(429, '<html>rate limited</html>', headers));
    const waits = captureWaits();
    let clock = 0;
    const err = await rejects(
      fetchWithRetry(
        'https://x/y',
        {},
        loop({ maxAttempts: 2, deadlineMs: 60_000, retryAfterOf, now: () => (clock += 1) }),
      ),
    );
    expect(err.message.startsWith('L → 429: ')).toBe(true);
    expect(api.statusOf(err)).toBe(429);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(floorMs);
  });

  // The one status this module is built around was the one `statusOf` could not report: the
  // exhaustion rejection was a plain Error, so a caller branching on the field saw undefined and
  // fell back to re-parsing the prose the field exists to replace.
  //
  // A row per exit the LOOP itself takes — not only the ones that fail while READING, which the
  // envelope table covers. The wall-clock exit reached BETWEEN attempts was the last one still
  // reporting nothing: a stated wait that fits the deadline, a sleep that overshoots it, and the
  // next iteration threw a bare `Error`, so a 429 ladder stopped firing on the rejection a
  // permanently rate-limited upstream produces most.
  const ticking = (step: number): (() => number) => {
    let clock = 0;
    return () => (clock += step);
  };

  /**
   * A clock read off a fixed list — `started`, the first budget check, the elapsed reading, then a
   * jump past the deadline. The budget-exhausted exit is otherwise reachable only through a
   * ~1ms timer overshoot, which is a race to depend on rather than a row.
   */
  const readings = (values: number[]): (() => number) => {
    let at = 0;
    return () => values[Math.min(at++, values.length - 1)] as number;
  };

  it.each([
    ['the attempt cap', '10', { maxAttempts: 2, deadlineMs: 30_000 }, ticking(1), 'L → 429: ', /still rate limited after 2 attempts/],
    ['a wait past the deadline', '10', { maxAttempts: 8, deadlineMs: 1_000 }, ticking(1), 'L → 429: ', /past this call's 1000ms deadline/],
    [
      'the budget exhausted before the next attempt',
      '0.001',
      { maxAttempts: 8, deadlineMs: 100 },
      readings([0, 0, 0, 200]),
      'L → deadline: ',
      /exceeded 100ms before attempt 2/,
    ],
  ])(
    'reports 429 through statusOf when the loop gives up on %s',
    async (_label, retryAfter, bounds, now, prefix, shape) => {
      stubForever(() => res(429, '', { 'retry-after': retryAfter }));
      captureWaits();
      const err = await rejects(
        fetchWithRetry('https://x/y', {}, loop({ ...bounds, now })),
      );
      expect(api.statusOf(err)).toBe(429);
      expect(err.message).toMatch(shape);
      expect(err.message.startsWith(prefix)).toBe(true);
    },
  );

  /**
   * The class the rows above pin three exits of. Every `throw` in the loop happens where a response
   * may already have arrived, so none of them may be a type that cannot carry the status: `statusOf`
   * reads a FIELD, and a bare `Error` reports `undefined` for a rejection whose status is known.
   * Derived from the source, so the next exit added to the loop is graded before it ships.
   */
  describe('every exit the loop takes throws a type that can carry a status', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const STATUS_CARRYING = ['LabelledError', 'HttpStatusError'];

    const loopBody = (): string => {
      const from = src.indexOf('export async function fetchWithRetry');
      const to = src.indexOf('\n}', from);
      return src.slice(from, to);
    };

    const thrown = (): string[] =>
      [...loopBody().matchAll(/throw new (\w+)\(/g)].map((m) => m[1] as string);

    it('finds the loop and its throws, so the row below is not reading an empty string', () => {
      expect(loopBody()).toContain('for (let attempt = 1;');
      expect(thrown().length).toBeGreaterThan(2);
    });

    it('throws nothing that drops the status', () => {
      expect(thrown().filter((name) => !STATUS_CARRYING.includes(name))).toEqual([]);
    });
  });

  // The same class one exit further along: a teardown ends the retry AFTER the 429 arrived, so the
  // status is just as known here as at the attempt cap. A caller that branches on `statusOf` — to
  // tell "we were rate limited" from "the transport died" while shutting down — reads the field on
  // every exit or on none.
  it.each([
    ['a stop already true when the 429 lands', () => true],
    [
      'a stop landing during the backoff',
      (() => {
        let stopped = false;
        setTimeout(() => {
          stopped = true;
        }, 5);
        return () => stopped;
      })(),
    ],
  ])('reports 429 through statusOf when a disconnect ends the retry on %s', async (_label, isStopped) => {
    stubForever(() => res(429, '', { 'retry-after': '0.05' }));
    const opts = loop({ isStopped, deadlineMs: 60_000 });
    const err = await rejects(fetchWithRetry('https://x/y', {}, opts));
    expect(err.message).toBe('L → 429 (disconnected)');
    expect(api.statusOf(err)).toBe(429);
  });

  it('falls back to the Retry-After header when the caller supplies no parser', async () => {
    stubFetch([res(429, '', { 'retry-after': '2' }), res(200)]);
    const waits = captureWaits();
    const out = await fetchWithRetry('https://x/y', {}, loop());
    expect(out.status).toBe(200);
    expect(waits).toEqual([2000]);
  });

  it('hands the 429 response itself to retryAfterOf so headers are readable', async () => {
    stubFetch([res(429, '', { 'retry-after': '0.01' }), res(200)]);
    const seen: (string | null)[] = [];
    await fetchWithRetry(
      'https://x/y',
      {},
      {
        ...OPTS,
        retryAfterOf: (r) => {
          seen.push(r.headers.get('retry-after'));
          return 1;
        },
      },
    );
    expect(seen).toEqual(['0.01']);
  });
});
