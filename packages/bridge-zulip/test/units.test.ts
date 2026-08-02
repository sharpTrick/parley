/**
 * The pure halves of the plugin, graded directly rather than through a booted fake: the wire
 * encoding and its server-rewrite refusals, the `connect()`-time config resolution, and the wait
 * arithmetic. Everything here is reachable from a seam call too, but only at the cost of standing a
 * server up and inferring the answer from a request count — which is why a boundary case (the exact
 * clamp, the exact escalation step) tends to go ungraded until it is a defect.
 */
import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { normalizeBody, normalizeTopic, SERVER_CONSTRAINTS } from './fake-zulip.js';
import { ALL_PLACEMENTS, CANDIDATE_PADDINGS, padName } from './harness.js';
import { resolveConfig, type ZulipConfig } from '../src/config.js';
import {
  blockedFetchPause,
  budgetedDeadlineMs,
  longPollDeadlineMs,
  loopBackoffMs,
  reportsLoopFailure,
} from '../src/pacing.js';
import {
  asArray,
  type EventsResponse,
  MAX_MESSAGES_PER_FETCH,
  pageAnchor,
  type RealmMember,
  readRetryAfter,
  requireSendableBody,
  requireWireTopic,
  type ZulipEvent,
  type ZulipMessage,
  zulipToMessage,
} from '../src/wire.js';

const TOPIC = asTopic('units');

describe('a Parley topic is refused unless Zulip would store it verbatim', () => {
  const ROWS: Array<{ name: string; topic: string; wire?: string; rejects?: RegExp }> = [
    { name: 'case-folds, because Zulip compares case-insensitively', topic: 'MiXeD', wire: 'mixed' },
    { name: 'passes a plain name through', topic: 'hand-off', wire: 'hand-off' },
    { name: 'passes a name of exactly the maximum length', topic: 'x'.repeat(60), wire: 'x'.repeat(60) },
    { name: 'counts code points, not UTF-16 units', topic: '😀'.repeat(60), wire: '😀'.repeat(60) },
    { name: 'refuses one code point past the maximum', topic: 'x'.repeat(61), rejects: /too long/ },
    { name: 'refuses a leading ASCII space', topic: ' pad', rejects: /strips whitespace/ },
    { name: 'refuses a trailing space', topic: 'pad ', rejects: /strips whitespace/ },
    { name: 'refuses a non-ASCII space the server strips', topic: '\u00a0pad', rejects: /strips whitespace/ },
    { name: 'keeps U+FEFF, which the server does not strip', topic: '\ufeffpad', wire: '\ufeffpad' },
  ];

  for (const row of ROWS) {
    it(row.name, () => {
      if (row.rejects !== undefined) {
        expect(() => requireWireTopic(asTopic(row.topic))).toThrow(row.rejects);
        return;
      }
      expect(requireWireTopic(asTopic(row.topic))).toBe(row.wire);
    });
  }
});

describe('a message body is refused unless Zulip would store it verbatim', () => {
  const ROWS: Array<{ name: string; body: string; rejects?: RegExp }> = [
    { name: 'a plain body', body: 'hello' },
    { name: 'an interior newline', body: 'a\nb' },
    { name: 'a body of exactly the maximum length', body: 'x'.repeat(10_000) },
    { name: 'an empty body', body: '', rejects: /empty message body/ },
    { name: 'a whitespace-only body', body: '   ', rejects: /empty message body/ },
    { name: 'a NUL', body: 'a\u0000b', rejects: /NUL/ },
    { name: 'trailing whitespace', body: 'a ', rejects: /trailing whitespace/ },
    { name: 'a leading newline', body: '\na', rejects: /leading newlines/ },
    { name: 'one code point past the maximum', body: 'x'.repeat(10_001), rejects: /too long/ },
  ];

  for (const row of ROWS) {
    it(`${row.rejects === undefined ? 'accepts' : 'refuses'} ${row.name}`, () => {
      if (row.rejects !== undefined) {
        expect(() => requireSendableBody(row.body)).toThrow(row.rejects);
        return;
      }
      expect(requireSendableBody(row.body)).toBe(row.body);
    });
  }
});

/**
 * CLASS: every server rewrite this plugin refuses is graded against the SERVER's character set,
 * enumerated over the whole code space, rather than against whichever characters a row list
 * happened to name. Four sets are in play and no two are equal — the body strip is Python
 * `str.rstrip()` (White_Space + U+001C-U+001F), the topic strip is pydantic-core's Rust `trim()`
 * (White_Space exactly), and JavaScript's `\s` and `String#trim` are a third spelling that drops
 * U+0085 and adds U+FEFF. A guard written with the wrong one of the four therefore fails in BOTH
 * directions at once: it accepts a payload the server silently rewrites (a `post` that reports a
 * durable id for something no read returns as sent) and refuses one the server stores verbatim (a
 * hand-off that can never be posted at all).
 *
 * Both verdicts come from {@link normalizeBody}/{@link normalizeTopic} — the fake's model of the
 * server, built from the enumerated constraint — so the plugin is graded against the server rather
 * than against a second copy of its own regex, and the two sets cannot be collapsed into one
 * without a row failing.
 */
describe('every server rewrite is graded against the whole whitespace code space', () => {
  const tailIsStripped = (content: string): boolean => {
    const last = [...content].at(-1);
    return last !== undefined && SERVER_CONSTRAINTS.stripsBodyEdges.includes(last);
  };

  it('the generated table actually spans the divergence it exists to catch', () => {
    const bodyOnly = [...SERVER_CONSTRAINTS.stripsBodyEdges].filter(
      (c) => !SERVER_CONSTRAINTS.stripsTopicEdges.includes(c),
    );
    const jsOnly = CANDIDATE_PADDINGS.filter(
      (c) =>
        !SERVER_CONSTRAINTS.stripsBodyEdges.includes(c) &&
        !SERVER_CONSTRAINTS.stripsTopicEdges.includes(c),
    );
    expect(bodyOnly.map(padName)).toEqual(['U+001C', 'U+001D', 'U+001E', 'U+001F']);
    expect(jsOnly.map(padName)).toEqual(['U+FEFF']);
    expect(CANDIDATE_PADDINGS.map(padName)).toContain('U+0085');
  });

  for (const pad of CANDIDATE_PADDINGS) {
    for (const placement of ALL_PLACEMENTS) {
      it(`a body ${placement.name} ${padName(pad)} matches what normalize_body would store`, () => {
        const content = placement.pad(pad, 'hand-off');
        const stored = normalizeBody(content);
        if (typeof stored !== 'string') {
          expect(() => requireSendableBody(content)).toThrow(/empty message body/);
          return;
        }
        if (stored !== content) {
          expect(() => requireSendableBody(content)).toThrow(
            tailIsStripped(content) ? /trailing whitespace/ : /leading newlines/,
          );
          return;
        }
        expect(requireSendableBody(content)).toBe(content);
      });

      it(`a topic ${placement.name} ${padName(pad)} matches what the request parser would store`, () => {
        const topic = placement.pad(pad, 'core');
        const wire = topic.toLowerCase();
        if (normalizeTopic(wire) !== wire) {
          expect(() => requireWireTopic(asTopic(topic))).toThrow(/strips whitespace/);
          return;
        }
        expect(requireWireTopic(asTopic(topic))).toBe(wire);
      });
    }
  }
});

describe('a server record becomes a Message only when its id can carry the cursor', () => {
  const UNUSABLE: Array<{ name: string; record: unknown }> = [
    { name: 'a missing record', record: undefined },
    { name: 'a null record', record: null },
    { name: 'no id at all', record: {} },
    { name: 'a string id', record: { id: '7' } },
    { name: 'a zero id', record: { id: 0 } },
    { name: 'a negative id', record: { id: -1 } },
    { name: 'a fractional id', record: { id: 1.5 } },
    { name: 'an id past the safe integer range', record: { id: 2 ** 53 } },
    { name: 'a NaN id', record: { id: Number.NaN } },
  ];

  for (const row of UNUSABLE) {
    it(`drops ${row.name}`, () => {
      expect(zulipToMessage(TOPIC, row.record as ZulipMessage)).toBeUndefined();
    });
  }

  it('coerces every other server-controlled field rather than trusting it', () => {
    const m = zulipToMessage(TOPIC, { id: 7, content: 1 as never, sender_email: [] as never });
    expect(m).toMatchObject({ backendMsgId: '7', cursor: '7', content: '', senderHandle: '' });
    expect(m?.timestamp).toBe(new Date(0).toISOString());
  });

  const TIMESTAMPS: Array<{ name: string; seconds: unknown; iso: string }> = [
    { name: 'unix seconds', seconds: 1_700_000_000, iso: new Date(1_700_000_000_000).toISOString() },
    { name: 'a missing timestamp', seconds: undefined, iso: new Date(0).toISOString() },
    { name: 'a string timestamp', seconds: '1700000000', iso: new Date(0).toISOString() },
    { name: 'one past what Date can represent', seconds: 8.64e15, iso: new Date(0).toISOString() },
  ];

  for (const row of TIMESTAMPS) {
    it(`renders ${row.name}`, () => {
      expect(zulipToMessage(TOPIC, { id: 7, timestamp: row.seconds as number })?.timestamp).toBe(
        row.iso,
      );
    });
  }
});

describe('a page anchor only ever moves in the direction of travel', () => {
  const ROWS: Array<{ edge: unknown; from: string; backwards: boolean; next?: string }> = [
    { edge: { id: 5 }, from: '10', backwards: true, next: '5' },
    { edge: { id: 10 }, from: '10', backwards: true },
    { edge: { id: 11 }, from: '10', backwards: true },
    { edge: { id: 11 }, from: '10', backwards: false, next: '11' },
    { edge: { id: 10 }, from: '10', backwards: false },
    { edge: { id: 5 }, from: '10', backwards: false },
    { edge: { id: 5 }, from: 'newest', backwards: true, next: '5' },
    { edge: undefined, from: '10', backwards: true },
    { edge: { id: 'nope' }, from: '10', backwards: true },
    { edge: { id: Number.NaN }, from: '10', backwards: true },
  ];

  for (const row of ROWS) {
    it(`${JSON.stringify(row.edge)} from ${row.from} ${row.backwards ? 'backwards' : 'forwards'} → ${String(row.next)}`, () => {
      expect(pageAnchor(row.edge as ZulipMessage, row.from, row.backwards)).toBe(row.next);
    });
  }
});

describe('a server-controlled list is read as a list or as nothing', () => {
  it('passes an array through and answers everything else with an empty one', () => {
    const events: ZulipEvent[] = [{ id: 1, type: 'heartbeat' }];
    const body: EventsResponse = { events };
    const members: RealmMember[] = [{ user_id: 1, email: 'a@b', full_name: 'A' }];
    expect(asArray(body.events)).toBe(events);
    expect(asArray(members)).toBe(members);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray('nope' as unknown as string[])).toEqual([]);
  });

  it('caps one history page at what the server accepts', () => {
    expect(MAX_MESSAGES_PER_FETCH).toBe(5000);
  });
});

describe('a 429 hint is read from either place Zulip states it, in seconds', () => {
  const answer = (body: unknown, headers?: Record<string, string>): Response =>
    new Response(JSON.stringify(body), { status: 429, headers });

  it('reads the header, in seconds', async () => {
    await expect(readRetryAfter(answer({}, { 'retry-after': '2' }))).resolves.toBe(2000);
  });

  it('reads the JSON field when the header is absent', async () => {
    await expect(readRetryAfter(answer({ 'retry-after': 1.5 }))).resolves.toBe(1500);
  });

  it('prefers the header over the JSON field', async () => {
    await expect(
      readRetryAfter(answer({ 'retry-after': 1 }, { 'retry-after': '9' })),
    ).resolves.toBe(9000);
  });

  const UNUSABLE: unknown[] = [{}, { 'retry-after': 0 }, { 'retry-after': -1 }, { 'retry-after': 'x' }];
  for (const body of UNUSABLE) {
    it(`answers undefined for ${JSON.stringify(body)}`, async () => {
      await expect(readRetryAfter(answer(body))).resolves.toBeUndefined();
    });
  }

  it('answers undefined for a body that is not JSON at all', async () => {
    await expect(
      readRetryAfter(new Response('<html>too many requests</html>', { status: 429 })),
    ).resolves.toBeUndefined();
  });
});

describe('backend_config resolves to exactly what reaches the wire', () => {
  it('an empty config is the documented default in every field', () => {
    const cfg: ZulipConfig = resolveConfig({});
    expect(cfg).toEqual({
      baseUrl: 'http://127.0.0.1:9991',
      email: 'parley-bot@localhost',
      apiKey: 'parley-api-key',
      stream: 'parley',
      eventsTimeoutMs: 25_000,
      usesDefaultApiKey: true,
    });
  });

  const CLAMP: Array<[number, number]> = [
    [1, 250],
    [250, 250],
    [500, 500],
    [600_000, 600_000],
    [10_000_000, 600_000],
  ];
  for (const [given, effective] of CLAMP) {
    it(`clamps events_timeout_ms ${given} to ${effective}`, () => {
      expect(resolveConfig({ events_timeout_ms: given }).eventsTimeoutMs).toBe(effective);
    });
  }

  it('strips trailing slashes off site_url so no request path doubles one', () => {
    expect(resolveConfig({ site_url: ' https://z.example.com// ' }).baseUrl).toBe(
      'https://z.example.com',
    );
  });

  const DEFAULT_KEY: Array<[unknown, boolean]> = [
    [undefined, true],
    ['parley-api-key', true],
    ['s3cret', false],
  ];
  for (const [api_key, flagged] of DEFAULT_KEY) {
    it(`flags api_key ${String(api_key)} as default=${String(flagged)}`, () => {
      expect(resolveConfig(api_key === undefined ? {} : { api_key }).usesDefaultApiKey).toBe(
        flagged,
      );
    });
  }

  const REJECTS: Array<{ config: Record<string, unknown>; names: RegExp }> = [
    { config: { nonsense: 1 }, names: /nonsense/ },
    { config: { site_url: 'not-a-url' }, names: /site_url/ },
    { config: { site_url: 'ftp://z.example.com' }, names: /site_url/ },
    { config: { site_url: 'https://user:pw@z.example.com' }, names: /username or password/ },
    { config: { site_url: 'https://z.example.com?a=1' }, names: /bare base URL/ },
    { config: { site_url: 'https://z.example.com#a' }, names: /bare base URL/ },
    { config: { email: '' }, names: /email/ },
    { config: { api_key: 42 }, names: /api_key/ },
    { config: { stream: '  ' }, names: /stream/ },
    { config: { stream: '42' }, names: /stream ID/ },
    { config: { stream: '"parley"' }, names: /differently quoted/ },
    { config: { stream: '["parley"]' }, names: /JSON list/ },
    { config: { events_timeout_ms: 0 }, names: /events_timeout_ms/ },
    { config: { events_timeout_ms: '25000' }, names: /events_timeout_ms/ },
  ];
  for (const row of REJECTS) {
    it(`rejects ${JSON.stringify(row.config)}`, () => {
      expect(() => resolveConfig(row.config)).toThrow(row.names);
    });
  }

  it('reports a mistyped secret by shape, never by value', () => {
    expect(() => resolveConfig({ api_key: 's3cret-mistyped-as-a-number' as unknown as string })).not.toThrow();
    expect(() => resolveConfig({ api_key: 12345 as unknown as string })).toThrow(/a number/);
    expect(() => resolveConfig({ site_url: 's3cret-pasted-here' })).toThrow(/18-character string/);
  });
});

describe('every wait the plugin takes is bounded and escalates', () => {
  it('a blocked fetch retries on a doubling pause under a ceiling', () => {
    expect([0, 1, 2, 3, 4, 20].map(blockedFetchPause)).toEqual([400, 800, 1600, 3200, 5000, 5000]);
  });

  it('a failing push loop backs off on a doubling pause under a ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 100].map(loopBackoffMs)).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
  });

  it('a run of failures is reported once it is established, then periodically', () => {
    const reported = Array.from({ length: 61 }, (_, i) => i).filter(reportsLoopFailure);
    expect(reported).toEqual([0, 3, 20, 40, 60]);
  });

  it("a parked poll's deadline clears the cap it asked the server to hold for", () => {
    expect(longPollDeadlineMs(600_000)).toBeGreaterThan(600_000);
    expect(longPollDeadlineMs(-1)).toBe(longPollDeadlineMs(0));
  });

  it("a request inside a caller's budget gets what is left of it, plus one answer", () => {
    const now = Date.now();
    expect(budgetedDeadlineMs(now + 1000)).toBeGreaterThan(1000);
    expect(budgetedDeadlineMs(now + 1000)).toBeLessThanOrEqual(1500);
    // A spent budget still buys the last request an answer, rather than a deadline of zero.
    expect(budgetedDeadlineMs(now - 10_000)).toBe(500);
  });
});
