import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchWithRetry, retryAfterFromHeader } from '@sharptrick/parley-net-util';
import {
  captureWaits,
  loop,
  rejects,
  res,
  resetGlobalsAfterEach,
  stubForever,
} from './fixtures.js';

resetGlobalsAfterEach();

function httpDate(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toUTCString();
}

describe('retryAfterFromHeader', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['0', undefined],
    ['-5', undefined],
    ['abc', undefined],
    ['2', 2000],
    ['0.5', 500],
  ])('reads %s as %s', (header, expected) => {
    const headers: Record<string, string> =
      header === undefined ? {} : { 'retry-after': header };
    expect(retryAfterFromHeader(new Response('', { headers }))).toBe(expected);
  });

  // RFC 9110 gives Retry-After two forms; reading only delay-seconds made the date form look
  // absent, which retried at the 500ms default instead of when the server said.
  it('reads the HTTP-date form', () => {
    const at = retryAfterFromHeader(
      new Response('', { headers: { 'retry-after': httpDate(120_000) } }),
    );
    expect(at).toBeGreaterThan(110_000);
    expect(at).toBeLessThanOrEqual(120_000);
  });

  it('reads an HTTP-date already in the past as no hint', () => {
    expect(
      retryAfterFromHeader(new Response('', { headers: { 'retry-after': httpDate(-60_000) } })),
    ).toBeUndefined();
  });

  /**
   * A gateway and an origin both setting the header make `Headers.get` join them, and the whole
   * joined string is tried first because a single HTTP-date carries a comma of its own. Deferring
   * that attempt to a bare `Date.parse` — the laxity the delay-seconds branch is pinned against —
   * reads a leading 4-digit second count as a YEAR: `"3600, 5"` becomes May of the year 3600 and
   * dominates the max by twelve orders of magnitude, so the call ends advising an operator to raise
   * a deadline past a wait of fifty trillion milliseconds.
   *
   * The first field-value is SWEPT over 1-to-4-digit second counts rather than hand-picked, so the
   * next year-shaped figure is already a row. Every row states the max of the field-values parsed
   * INDIVIDUALLY, which is what the README promises.
   */
  const SECOND_COUNTS = [1, 5, 12, 59, 120, 999, 1200, 1900, 2026, 3600, 9999];

  it.each(
    SECOND_COUNTS.flatMap((first) =>
      [5, 12, 4000].map((second) => [first, second] as [number, number]),
    ),
  )('reads a header set twice (%i then %i) as the longer field-value', (first, second) => {
    const headers = new Headers();
    headers.append('retry-after', String(first));
    headers.append('retry-after', String(second));
    expect(retryAfterFromHeader(new Response('', { headers }))).toBe(
      Math.max(first, second) * 1000,
    );
  });

  it('finds a joined header at all, so the rows above are not reading one value', () => {
    const headers = new Headers();
    headers.append('retry-after', '3600');
    headers.append('retry-after', '5');
    expect(headers.get('retry-after')).toBe('3600, 5');
  });

  /**
   * The three `HTTP-date` spellings RFC 9110 §5.6.7 defines must all be read, and nothing else may
   * be: pinning the spelling is what stops `Date.parse` inventing a wait out of a string that is not
   * a date. `undefined` here means "no usable hint", i.e. the fixed default backoff.
   */
  const from = (spelling: string, at: number): number | undefined =>
    retryAfterFromHeader(
      new Response('', {
        headers: { date: new Date(at - 60_000).toUTCString(), 'retry-after': spelling },
      }),
    );

  const HTTP_DATE_SPELLINGS: [label: string, spelling: string, at: number][] = [
    ['IMF-fixdate', 'Fri, 06 Nov 2099 08:49:37 GMT', Date.UTC(2099, 10, 6, 8, 49, 37)],
    ['obsolete RFC 850', 'Saturday, 06-Nov-32 08:49:37 GMT', Date.UTC(2032, 10, 6, 8, 49, 37)],
    ['asctime', 'Fri Nov  6 08:49:37 2099', Date.UTC(2099, 10, 6, 8, 49, 37)],
  ];

  const NOT_HTTP_DATES: [label: string, spelling: string][] = [
    ['an ISO date', '2099-01-01'],
    ['an RFC 3339 timestamp', '2099-11-06T08:49:37Z'],
    ['a slashed date', '01/01/3600'],
    ['a date with no day-of-week', '06 Nov 2099 08:49:37 GMT'],
    ['a day name followed by an ISO date', 'Fri 2099-11-06'],
    // The pinned asctime shape with a field outside its range: `Date.UTC` rolls these forward into
    // an instant hours or months away, which is a wait no deadline covers rather than no hint.
    ['an asctime with a 32nd day', 'Fri Nov 32 08:49:37 2099'],
    ['an asctime with a 25th hour', 'Fri Nov  6 25:49:37 2099'],
    ['an asctime with a 69th minute', 'Fri Nov  6 08:69:37 2099'],
    ['an asctime with a 61st second', 'Fri Nov  6 08:49:61 2099'],
    ['an asctime naming no month', 'Fri Xyz  6 08:49:37 2099'],
  ];

  /**
   * Every assertion above is an ABSOLUTE instant, and an HTTP-date is GMT by definition (RFC 9110
   * §5.6.7) — so any of them reading differently under a different `TZ` is a parser consulting the
   * host's clock for a value that does not depend on it. asctime, the one spelling with no zone
   * token, was doing exactly that: `Date.parse` read it locally, which east of Greenwich turned a
   * stated 120 s wait into no hint at all and west of it into one past the call's deadline.
   *
   * Zones rather than one pinned `TZ`: pinning `TZ=UTC` in the vitest config would have made this
   * suite green everywhere while the parser stayed wrong for every non-UTC deployment.
   */
  const ZONES = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati', 'Australia/Lord_Howe'];

  const inZone = <T>(zone: string, fn: () => T): T => {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  };

  it('crosses zones that actually differ, so the rows below are not five spellings of UTC', () => {
    const offsets = new Set(
      ZONES.map((zone) => inZone(zone, () => new Date(Date.UTC(2099, 10, 6)).getHours())),
    );
    expect(offsets.size).toBe(ZONES.length);
  });

  it('re-enters the parser under the zone it is given, so the rows below grade the zone', () => {
    expect(inZone('Asia/Tokyo', () => new Date(0).getHours())).not.toBe(
      inZone('America/New_York', () => new Date(0).getHours()),
    );
  });

  describe.each(ZONES)('with TZ=%s', (zone) => {
    it.each(HTTP_DATE_SPELLINGS)(
      'reads the %s spelling of an HTTP-date',
      (_label, spelling, at) => {
        expect(inZone(zone, () => from(spelling, at))).toBe(60_000);
      },
    );

    it.each(NOT_HTTP_DATES)('does not invent a wait out of %s', (_label, spelling) => {
      expect(
        inZone(zone, () => from(spelling, Date.UTC(2099, 10, 6, 8, 49, 37))),
      ).toBeUndefined();
    });
  });

  /**
   * The invariant itself rather than the two tables that state it today: every clock-shaped literal
   * in THIS SUITE, wherever it is written, must read identically under every zone. Keep the sweep
   * over the whole test DIRECTORY rather than over `import.meta.url`, so that a spelling written in
   * a sibling file — or in the next file this one is split into — is graded without anyone
   * remembering to cross it with `ZONES`.
   */
  const clockShapedLiterals = (): string[] => {
    const here = new URL('./', import.meta.url);
    return [
      ...new Set(
        readdirSync(here, { recursive: true })
          .map(String)
          .filter((name) => name.endsWith('.ts'))
          .sort()
          .flatMap((name) => [
            ...readFileSync(new URL(name, here), 'utf8').matchAll(
              /'([^'\n]*\d\d:\d\d:\d\d[^'\n]*)'/g,
            ),
          ])
          .map((m) => m[1] as string),
      ),
    ];
  };

  it('sees every clock-shaped spelling the tables above name, so the sweep is not empty', () => {
    const tabled = [
      ...HTTP_DATE_SPELLINGS.map(([, spelling]) => spelling),
      ...NOT_HTTP_DATES.map(([, spelling]) => spelling),
    ].filter((spelling) => /\d\d:\d\d:\d\d/.test(spelling));
    expect(tabled.length).toBeGreaterThan(5);
    expect(clockShapedLiterals()).toEqual(expect.arrayContaining(tabled));
  });

  it.each(clockShapedLiterals())('reads `%s` the same under every zone', (literal) => {
    const readings = ZONES.map((zone) =>
      inZone(zone, () => from(literal, Date.UTC(2099, 10, 6, 8, 49, 37))),
    );
    expect(new Set(readings).size).toBe(1);
  });

  // An HTTP-date states a point on the SERVER's clock, so subtracting OUR clock reads a real
  // 30-second wait as negative on a client a minute fast — i.e. as no hint at all, which retries at
  // the 500ms default against a server that asked for sixty times that. The mirror case inflates a
  // routine hint past the deadline and ends the call. Every row here derives its dates from the
  // server's clock, which `httpDate()` cannot do.
  const SKEWS: [string, number][] = [
    ['two minutes ahead of the server', -120_000],
    ['a second ahead', -1_000],
    ['in step', 0],
    ['a second behind', 1_000],
    ['two minutes behind', 120_000],
  ];

  const HINT_FORMS: [string, (serverAt: number, ms: number) => string][] = [
    ['an HTTP-date', (serverAt, ms) => new Date(serverAt + ms).toUTCString()],
    ['delay-seconds', (_serverAt, ms) => String(ms / 1000)],
  ];

  const STATED_MS = 30_000;

  it.each(
    SKEWS.flatMap(([skew, ahead]) =>
      HINT_FORMS.map(([form, spell]) => [`${form}, client ${skew}`, ahead, spell] as const),
    ),
  )('reads the server-stated wait unchanged (%s)', async (_label, ahead, spell) => {
    const serverAt = Date.now() - ahead;
    const headers = {
      date: new Date(serverAt).toUTCString(),
      'retry-after': spell(serverAt, STATED_MS),
    };
    expect(retryAfterFromHeader(new Response('', { headers }))).toBe(STATED_MS);

    stubForever(() => res(429, '', headers));
    const waits = captureWaits();
    let clock = 0;
    await rejects(
      fetchWithRetry(
        'https://x/y',
        {},
        loop({ maxAttempts: 2, deadlineMs: 120_000, now: () => (clock += 1) }),
      ),
    );
    expect(waits).toEqual([STATED_MS]);
  });

  it('falls back to our own clock when the response offers no Date header', () => {
    const at = retryAfterFromHeader(
      new Response('', { headers: { 'retry-after': httpDate(30_000) } }),
    );
    expect(at).toBeGreaterThan(28_000);
    expect(at).toBeLessThanOrEqual(30_000);
  });
});
