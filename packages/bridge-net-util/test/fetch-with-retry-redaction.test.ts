import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '@sharptrick/parley-net-util';
import { documentedFigure, loop, rejects, res, resetGlobalsAfterEach } from './fixtures.js';

resetGlobalsAfterEach();

describe('fetchWithRetry', () => {
  // Telegram builds `<api_url>/bot<token>/<method>`, so the request URL IS a credential. A thrown
  // message becomes an MCP isError result — i.e. model context — and the operator's stderr.
  const CANARY = 'SECRET-CANARY-9f3a';
  const SECRET_URL = `https://api.example.test/bot123:${CANARY}/getMe`;
  // A transport, a proxy or a hostile body echoes the URL in ITS OWN spelling, not the caller's
  // byte-for-byte — normalized port, trailing slash, uppercased host, percent-encoding, or just the
  // credential-bearing path. Splitting on the request URL catches only the first of those, so every
  // row below is a spelling that must still be redacted by something other than the exact match.
  const SPELLINGS: [string, (url: string) => string][] = [
    ['byte-identical', (u) => u],
    ['port made explicit', (u) => u.replace('://api.example.test/', '://api.example.test:443/')],
    ['a trailing slash', (u) => `${u}/`],
    ['an uppercased host', (u) => u.replace('api.example.test', 'API.EXAMPLE.TEST')],
    // Percent-encoding the credential's own colon defeats BOTH the exact split and the path-part
    // removal, leaving the scheme-anchored sweep as the only thing between the token and the model.
    ['a percent-encoded credential separator', (u) => u.replace('bot123:', 'bot123%3A')],
    ['a doubled path separator', (u) => u.replace('/getMe', '//getMe')],
    ['the credential path alone, no scheme or host', (u) => new URL(u).pathname],
    ['the credential path segment alone', (u) => new URL(u).pathname.split('/')[1] as string],
  ];

  type Wrap = (fetchImpl: () => Promise<Response>) => () => Promise<Response>;
  /** A failure shape that echoes the URL back at us, as the `fetch` that produces it. */
  type Vector = (echoed: string) => (() => Promise<Response>) | undefined;

  const VECTORS: [string, Vector][] = [
    ['a DNS failure echoing it', (e) => () => Promise.reject(new TypeError(`request to ${e} failed: ENOTFOUND`))],
    [
      'a TLS failure carrying it in the cause chain',
      (e) => () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: new Error(`unable to verify certificate for ${e}`) }),
        ),
    ],
    ['a 4xx body echoing it back', (e) => () => Promise.resolve(res(404, `no route for ${e}`))],
  ];

  /**
   * What the CALLER's own `signal` is doing when the failure lands — the third axis, because a
   * plugin's `disconnect()` aborts mid-request and every long-poller holds a controller for exactly
   * that. A transport failure that RACES the abort is still a transport failure: deciding on the
   * signal's state rather than on the error's identity took the raw, unlabeled, unredacted
   * rejection straight out to the caller. None of these vectors IS an abort, so every cell must
   * still come back inside the envelope.
   */
  const SIGNAL_STATES: [string, () => { init: RequestInit; wrap: Wrap }][] = [
    ['no caller signal', () => ({ init: {}, wrap: (f) => f })],
    [
      'a caller signal aborted before the call',
      () => {
        const controller = new AbortController();
        controller.abort(new Error('torn down'));
        return { init: { signal: controller.signal }, wrap: (f) => f };
      },
    ],
    [
      'a caller signal aborted in the same turn as the failure',
      () => {
        const controller = new AbortController();
        return {
          init: { signal: controller.signal },
          wrap: (f) => () => {
            controller.abort(new Error('torn down'));
            return f();
          },
        };
      },
    ],
  ];

  /** The envelope a call against `url` produces, with `fetch` answering as `respond`. */
  const envelopeFor = async (
    url: string,
    respond: (() => Promise<Response>) | undefined,
  ): Promise<string> => {
    vi.stubGlobal('fetch', respond);
    return (await rejects(fetchWithRetry(url, {}, loop()))).message;
  };

  /** The envelope one cell produces, having asserted the two properties every cell must have. */
  const envelopeOf = async (
    spell: (url: string) => string,
    make: Vector,
    arm: () => { init: RequestInit; wrap: Wrap },
  ): Promise<string> => {
    const { init, wrap } = arm();
    vi.stubGlobal('fetch', wrap(make(spell(SECRET_URL)) as () => Promise<Response>));
    const err = await rejects(
      fetchWithRetry(SECRET_URL, init, loop({ label: 'Telegram GET /getMe' })),
    );
    expect(err.message.startsWith('Telegram GET /getMe → ')).toBe(true);
    expect(err.message).not.toContain(CANARY);
    return err.message;
  };

  const NO_CALLER_SIGNAL = SIGNAL_STATES[0]![1];
  const CANONICAL_SPELLING = SPELLINGS[0]![1];

  /**
   * The two axes below are ADDED, not multiplied: the spelling only ever changes the string handed
   * to `redactUrls`, and the caller-signal state is read only by `isCallerAbort` in `fetchOnce`'s
   * catch, so no spelling can change which branch a signal state takes. Crossed, they spent 72 cells
   * discriminating what 33 do, and reported the product as coverage of a shape it cannot grade.
   */
  it('crosses an axis only where its own values reach different outcomes', async () => {
    const bySpelling: string[] = [];
    for (const [, spell] of SPELLINGS) {
      bySpelling.push(await envelopeOf(spell, VECTORS[0]![1], NO_CALLER_SIGNAL));
    }
    const byVector: string[] = [];
    for (const [, make] of VECTORS) {
      byVector.push(await envelopeOf(CANONICAL_SPELLING, make, NO_CALLER_SIGNAL));
    }
    expect(new Set(bySpelling).size).toBeGreaterThan(1);
    expect(new Set(byVector).size).toBeGreaterThan(1);
  });

  // The pinning half: the signal axis reaches ONE outcome here, which is why it crosses the vectors
  // alone. A change that lets the caller's signal state decide the envelope — the defect that took
  // the raw, unredacted rejection out to the caller — reddens this row rather than hiding inside a
  // product where every cell asserts the same thing.
  it('the caller-signal axis reaches one outcome, which is why it does not cross the spellings', async () => {
    const byState: string[] = [];
    for (const [, arm] of SIGNAL_STATES) {
      byState.push(await envelopeOf(CANONICAL_SPELLING, VECTORS[0]![1], arm));
    }
    expect(byState).toHaveLength(SIGNAL_STATES.length);
    expect(new Set(byState).size).toBe(1);
  });

  it.each(
    SPELLINGS.flatMap(([spelling, spell]) =>
      VECTORS.map(([vector, make]) => [`${vector}, ${spelling}`, spell, make] as const),
    ),
  )('never leaks a credential-bearing URL in an error (%s)', async (_label, spell, make) => {
    await envelopeOf(spell, make, NO_CALLER_SIGNAL);
  });

  it.each(
    VECTORS.flatMap(([vector, make]) =>
      SIGNAL_STATES.map(([state, arm]) => [`${vector}, ${state}`, make, arm] as const),
    ),
  )(
    'keeps a failure that races the caller’s own teardown inside the envelope (%s)',
    async (_label, make, arm) => {
      await envelopeOf(CANONICAL_SPELLING, make, arm);
    },
  );

  // The other rejection the caller-signal exit used to let out bare: an oversized body is detected
  // while READING, not by any signal, so a plugin tearing down mid-read got
  // `response body exceeded N bytes` with no label and no status for a caller to branch on.
  it('labels an oversized body even while the caller is aborting', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', () => {
      controller.abort(new Error('torn down'));
      return Promise.resolve(res(200, 'A'.repeat(4096)));
    });
    const err = await rejects(
      fetchWithRetry(
        'https://x/y',
        { signal: controller.signal },
        loop({ maxBodyBytes: 512 }),
      ),
    );
    expect(err.message).toBe('L → body: response body exceeded 512 bytes');
  });

  // The other half of the class: not another SPELLING of the same location, but the SHAPE the
  // credential itself takes, crossed with the URL component it sits in. Path segments were kept
  // only when they contained a `:`, so Discord's `/api/webhooks/<id>/<token>` — a token with no
  // punctuation at all — reached model context whenever a body echoed the bare path, while the one
  // existing path row passed on Telegram's colon. Every row echoes the component ALONE: the whole
  // URL is claimed by the byte-exact split (and by the scheme sweep) in the table above.
  /**
   * The alphabets real vendors mint credentials from, generated to length rather than hand-picked.
   * Three hand-picked shapes passed only because each happened to carry a digit or a hyphen: the
   * all-alphabetic and dotted-JWT shapes read as method names to the route-word exemption and
   * reached model context in full.
   */
  const cycle = (alphabet: string, n: number): string =>
    Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('');

  const dottedJwt = (n: number): string => {
    const each = Math.max(1, Math.floor((n - 2) / 3));
    return [
      cycle('eyJhbGciOiJIUzIINiJ', each),
      cycle('eyJzdWIiOiJhYmMifQ', each),
      cycle('SflKxwRJSMeKKFtwo', Math.max(1, n - 2 - 2 * each)),
    ].join('.');
  };

  const ALPHABETS: [string, (n: number) => string][] = [
    // The two alphabets whose spelling the URL parser CHANGES. Every row above them is `+`- and
    // `%`-free, which is why sixty green cells missed a standard-base64 key: `URLSearchParams`
    // hands back a space where the wire carried a `+`, so redaction derived from the parser's view
    // alone removes a string the body never contained.
    ['standard base64', (n) => cycle('QWERTY+uiop/asdFGH12345jkl=ZXCVbnm', n)],
    ['percent-escaped', (n) => cycle('%2FQWERTY%3Auiop%20asdFGH12345', n)],
    ['base64url', (n) => cycle('QWERTYuiop-_asdFGH12345jklZXCVbnm', n)],
    ['base62 alphanumeric', (n) => cycle('QWERTYuiopasdFGH12345jklZXCVbnm', n)],
    ['all-lowercase alphabetic', (n) => cycle('qwertyuiopasdfghjklzxcvbnm', n)],
    ['all-mixed-case alphabetic', (n) => cycle('zSXqVvNlrIWmEuBhTgKcPdJfAeRyQoUn', n)],
    ['hex', (n) => cycle('0123456789abcdef', n)],
    ['base32', (n) => cycle('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', n)],
    ['a dotted three-part JWT', dottedJwt],
  ];

  /**
   * One character past the exemption the README states, and the two lengths Discord and GitHub
   * actually mint. Read off the README, so that moving the bound moves the table with it rather
   * than leaving a row that grades the old one.
   */
  const methodNameBound = (): number =>
    documentedFigure(
      /method-name exemption is bounded at \*\*(\d+) characters\*\*/,
      'the method-name exemption bound',
    );

  const secretLengths = (): number[] => [methodNameBound() + 1, 68];

  const SHAPES = (): [string, string][] => [
    ['colon-joined', `bot123:${CANARY}`],
    ...ALPHABETS.flatMap(([alphabet, mint]) =>
      secretLengths().map((n): [string, string] => [`${alphabet} × ${n}`, mint(n)]),
    ),
  ];

  /**
   * The length above which a path segment or a query value stops reading as routing vocabulary. Read
   * off the README for the same reason the method-name bound is: moving the bound moves the tables
   * built on it rather than leaving rows that grade the old one.
   */
  const routeWordBound = (): number =>
    documentedFigure(/Long means \*\*longer than (\d+) characters\*\*/, 'the route-word bound');

  /**
   * Components whose rule CONSULTS what they carry — the per-segment and per-query-value rules, both
   * of which weigh length against the method-name exemption. Only these can grade a value axis, so
   * only these are crossed with one.
   *
   * Each builder reports the fragment the URL ACTUALLY carries, read back off `new URL(...)`, not
   * the value the row wrote. The parser normalizes on the way in, and a table that echoes what it
   * wrote grades a spelling no transport and no body ever produces — which is exactly how a
   * `+`-bearing credential passed every cell while reaching model context verbatim.
   */
  const SHAPED_LOCATIONS: [string, (v: string) => { url: string; fragment: string }][] = [
    [
      'a path segment echoed on its own',
      (v) => {
        const url = `https://api.example.test/api/webhooks/12345/${v}`;
        return { url, fragment: new URL(url).pathname.split('/').at(-1) as string };
      },
    ],
    [
      'a query value echoed on its own',
      (v) => {
        const url = `https://api.example.test/v1/x?access_token=${v}`;
        const query = new URL(url).search.slice(1);
        return { url, fragment: query.slice(query.indexOf('=') + 1) };
      },
    ],
  ];

  /**
   * The table's own premise: a fragment long enough for the length rule to have to decide, and at
   * least one shape the parser does NOT hand back as written. Without the second row the two
   * normalizing alphabets could be deleted and every cell above would stay green.
   */
  it('echoes fragments the rule must decide on, including one the parser respells', () => {
    const cells = SHAPED_LOCATIONS.flatMap(([location, build]) =>
      SHAPES().map(([shape, secret]) => ({ label: `${location}, ${shape}`, ...build(secret) })),
    );
    const tooShort = cells.filter((c) => c.fragment.length <= routeWordBound());
    expect(tooShort.map((c) => c.label)).toEqual([]);
    const respelled = cells.filter(
      (c) => new URL(c.url).searchParams.get('access_token') !== null &&
        new URL(c.url).searchParams.get('access_token') !== c.fragment,
    );
    expect(respelled.map((c) => c.label)).not.toEqual([]);
  });

  /**
   * Components claimed WHATEVER they carry: the whole pathname (claimed on the `/12345/` inside it)
   * and userinfo (credential-by-construction, deliberately taking no exemption). Crossed with a
   * value axis these spent 45 cells apiece on one code path and reported as coverage of a shape they
   * cannot grade, indistinguishable in the report from the rows that do. One row each instead — and
   * the row below pins them as unconditional, so a rule that starts consulting the value reddens
   * here and gets moved into the cross-product rather than quietly re-growing an inert axis.
   */
  const UNCONDITIONAL_LOCATIONS: [string, (v: string) => { url: string; fragment: string }][] = [
    [
      'the whole path',
      (v) => ({
        url: `https://api.example.test/api/webhooks/12345/${v}`,
        fragment: `/api/webhooks/12345/${v}`,
      }),
    ],
    [
      'userinfo',
      (v) => ({
        url: `https://user:${v}@api.example.test/v1/x`,
        fragment: `user:${v}@api.example.test`,
      }),
    ],
  ];

  // Each row states the string that must not survive: the whole echoed fragment where the rule
  // consults it, and the credential inside it where the component is claimed whatever it carries.
  it.each([
    ...SHAPED_LOCATIONS.flatMap(([location, build]) =>
      SHAPES().flatMap(([shape, secret]) =>
        VECTORS.map(([vector, make]) => {
          const target = build(secret);
          return [`${location}, ${shape}, ${vector}`, target, make, target.fragment] as const;
        }),
      ),
    ),
    ...UNCONDITIONAL_LOCATIONS.flatMap(([location, build]) =>
      VECTORS.map(
        ([vector, make]) =>
          [`${location}, ${vector}`, build(`bot123:${CANARY}`), make, CANARY] as const,
      ),
    ),
  ])(
    'never leaks a credential carried in %s, echoed alone',
    async (_label, target, make, secret) => {
      const message = await envelopeFor(target.url, make(target.fragment));
      expect(message).toContain('L → ');
      expect(message).not.toContain(secret);
    },
  );

  /**
   * The one claim in the README that only a LENGTH axis can grade: userinfo takes neither exemption,
   * "so a short password is redacted too". The whole-part filter dropped every candidate of one
   * character, so the shortest password — the only one the sentence is about — survived verbatim
   * while `bot123:<CANARY>` passed the row above. Zero is the other side of the same bound: an empty
   * userinfo may not become a redaction target, or splitting on it puts `<redacted>` between every
   * character of the body.
   */
  const PASSWORD_LENGTHS = [1, 2, 8, 24, 68];

  it.each(PASSWORD_LENGTHS)('redacts a %i-character password out of the body', async (n) => {
    const password = cycle('qwrtypsdfghjklzxvbnm', n);
    const message = await envelopeFor(`https://user:${password}@api.example.test/v1/x`, () =>
      Promise.resolve(res(401, `bad creds ${password} for user`)),
    );
    expect(message.startsWith('L → 401: ')).toBe(true);
    expect(message).not.toContain(password);
  });

  it('leaves the body alone when the URL carries no userinfo at all', async () => {
    const body = 'the parameter anchor is not enabled for this workspace';
    const message = await envelopeFor('https://api.example.test/v1/x?anchor=newest', () =>
      Promise.resolve(res(409, body)),
    );
    expect(message).toBe(`L → 409: ${body}`);
  });

  it.each(UNCONDITIONAL_LOCATIONS)(
    '%s is claimed whatever it carries, which is why no value axis crosses it',
    async (_label, build) => {
      const target = build('newest');
      const message = await envelopeFor(target.url, () =>
        Promise.resolve(res(409, `no route for ${target.fragment}`)),
      );
      expect(message).not.toContain(target.fragment);
    },
  );

  /**
   * The leak table's mirror, on the axis a leak table cannot see: what a component legitimately IS,
   * either side of the two bounds the rule is built on. Redaction that claimed every query value
   * struck Matrix's `timeout=30000` and Zulip's `dont_block=false`, `anchor=newest`, `num_before=10`
   * out of the untrusted body — including from inside longer words, which turned "you have 100
   * messages and no permission" into "you have <redacted>0 messages and <redacted> permission".
   * Both outcomes are rows, so a location that stops discriminating collapses the non-vacuity check
   * beside it instead of passing quietly.
   */
  const VALUE_SHAPES = (): [string, string, boolean][] => [
    ['an ordinary word', 'newest', true],
    ['a boolean literal', 'false', true],
    ['a small integer', '10', true],
    ['a five-digit integer', '30000', true],
    ['digits exactly at the route-word bound', '9'.repeat(routeWordBound()), true],
    ['a resource name', 'conversations', true],
    ['a dotted method name', 'chat.postMessage', true],
    [
      'a method name exactly at the method-name bound',
      cycle('conversations.history.list', methodNameBound()),
      true,
    ],
    ['digits one past the route-word bound', '9'.repeat(routeWordBound() + 1), false],
    [
      'an opaque token past the method-name bound',
      cycle('QWERTYuiop-_asdFGH12345jklZXCVbnm', methodNameBound() + 1),
      false,
    ],
  ];

  it('crosses the value axis only where both outcomes are reachable', () => {
    expect(new Set(VALUE_SHAPES().map(([, , survives]) => survives))).toEqual(
      new Set([true, false]),
    );
    expect(SHAPED_LOCATIONS.length).toBeGreaterThan(1);
    expect(VALUE_SHAPES().length).toBeGreaterThan(5);
  });

  it.each(
    SHAPED_LOCATIONS.flatMap(([location, build]) =>
      VALUE_SHAPES().map(
        ([shape, value, survives]) =>
          [`${location}, ${shape}`, build(value), value, survives] as const,
      ),
    ),
  )('redacts on the value, not on the location (%s)', async (_label, target, value, survives) => {
    const body = `the parameter ${target.fragment} is not enabled for this workspace`;
    const message = await envelopeFor(target.url, () => Promise.resolve(res(409, body)));
    if (survives) expect(message).toContain(value);
    else expect(message).not.toContain(value);
  });

  // The other direction, which is a defect too: a path segment is also a WORD, and every API's
  // error prose uses its own method names. Redacting on length alone struck `getUpdates` out of
  // Telegram's own 409 and left the operator reading "can't use <redacted> method".
  // The bound is a BOUND, not a coincidence: a segment exactly at the documented length is still
  // routing vocabulary, and the generated table above starts one character past it. Deleting this
  // row would let the exemption shrink to nothing while every leak row stayed green.
  const atBound = (): string => cycle('conversations.history.list', methodNameBound());

  it.each([
    [
      'a method name beside a credential',
      `https://api.example.test/bot123:${CANARY}/getUpdates`,
      "can't use getUpdates method while webhook is active",
      'getUpdates',
    ],
    [
      'a resource name',
      'https://api.example.test/api/v1/conversations',
      'conversations is not enabled for this workspace',
      'conversations',
    ],
    [
      'a dotted method name',
      'https://api.example.test/api/chat.postMessage',
      'chat.postMessage requires a scope you do not have',
      'chat.postMessage',
    ],
    [
      'a method name exactly at the documented exemption bound',
      `https://api.example.test/api/${atBound()}`,
      `${atBound()} is not enabled for this workspace`,
      atBound(),
    ],
  ])('keeps %s in the body it explains', async (_label, url, body, word) => {
    const message = await envelopeFor(url, () => Promise.resolve(res(409, body)));
    expect(message).toContain(word);
    expect(message).not.toContain(CANARY);
  });

  // The one vector with no stub at all: a real `fetch` rejecting on a URL it cannot even parse.
  it('never leaks a credential-bearing URL that fetch itself refuses to parse', async () => {
    const url = `https://api.example.test:99999/bot123:${CANARY}/getMe`;
    const err = await rejects(fetchWithRetry(url, {}, loop({ label: 'Telegram GET /getMe' })));
    expect(err.message).toContain('Telegram GET /getMe');
    expect(err.message).not.toContain(CANARY);
    expect(err.message).not.toContain('api.example.test');
  });
});
