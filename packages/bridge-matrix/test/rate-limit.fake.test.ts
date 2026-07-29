import { asHandle, asTopic } from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';
import { readRetryAfter } from '../src/index.js';

/**
 * Two CLASSES over Synapse's 429 (`M_LIMIT_EXCEEDED`) on room creation — the one limiter that
 * actually bites this plugin (~2-room burst per user, then ~1 room / 45s).
 *
 *  1. A hint-extraction function must be killed by a mutation to a constant. Every shape the wire
 *     can carry is a row, asserting the exact milliseconds the retry loop is handed.
 *  2. A per-backend `retryAfterOf` must not narrow net-util's shared policy: a SERVER-STATED wait is
 *     honoured in full (the deadline is the only governor, and its message is the actionable one),
 *     and a hint-less 429 returns `undefined` so the shared default and ceiling apply once, in
 *     `clampBackoff`, rather than being re-tuned per backend.
 */

const res429 = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
  });

const HTTP_DATE_IN = 40_000;

interface HintRow {
  name: string;
  build: () => Response;
  /** Expected ms, or a predicate for the HTTP-date row whose value depends on the clock. */
  expected: number | undefined | ((ms: number | undefined) => void);
}

const HINTS: HintRow[] = [
  {
    name: 'Retry-After header in seconds',
    build: () => res429({}, { 'retry-after': '45' }),
    expected: 45_000,
  },
  {
    name: 'Retry-After header as an HTTP-date',
    build: () => res429({}, { 'retry-after': new Date(Date.now() + HTTP_DATE_IN).toUTCString() }),
    expected: (ms) => {
      expect(ms).toBeGreaterThan(HTTP_DATE_IN - 5_000);
      expect(ms).toBeLessThanOrEqual(HTTP_DATE_IN);
    },
  },
  {
    name: 'retry_after_ms in the body',
    build: () => res429({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 45_000 }),
    expected: 45_000,
  },
  {
    name: 'both present — the header wins',
    build: () => res429({ retry_after_ms: 1_000 }, { 'retry-after': '7' }),
    expected: 7_000,
  },
  { name: 'neither present', build: () => res429({ errcode: 'M_LIMIT_EXCEEDED' }), expected: undefined },
  {
    name: 'a zero header falls through to the body',
    build: () => res429({ retry_after_ms: 2_500 }, { 'retry-after': '0' }),
    expected: 2_500,
  },
  {
    name: 'a negative body value is no hint at all',
    build: () => res429({ retry_after_ms: -5 }),
    expected: undefined,
  },
  { name: 'a non-JSON body is no hint at all', build: () => new Response('nope', { status: 429 }), expected: undefined },
  {
    name: 'a wait far past the shared ceiling is reported IN FULL',
    build: () => res429({ retry_after_ms: 45_000 }),
    expected: 45_000,
  },
];

describe('the 429 hint the retry loop is handed', () => {
  for (const row of HINTS) {
    it(row.name, async () => {
      const ms = await readRetryAfter(row.build());
      if (typeof row.expected === 'function') row.expected(ms);
      else expect(ms).toBe(row.expected);
    });
  }
});

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  fake.aliasExists = false; // force POST /createRoom, the only 429-bearing call here
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a 429 on room creation is retried on the homeserver terms', () => {
  it('a short stated wait is waited out and the create succeeds', async () => {
    fake.createRoomLimited = 1;
    fake.createRoomRetryAfterMs = 60;
    const p = await connectFake({});

    const started = Date.now();
    await p.post(asTopic('ctx-limited'), asHandle('w'), 'hello');

    expect(fake.createRoomBodies).toHaveLength(2); // refused once, then retried
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    await p.disconnect();
  }, 20_000);

  /**
   * The limiter's real answer (~45s) does not fit a 30s call, so the honest outcome is to end the
   * call saying so — not to retry six times inside the window the homeserver asked us to stay out of.
   */
  it('a stated wait past the call deadline ends the call naming both', async () => {
    fake.createRoomLimited = Number.POSITIVE_INFINITY;
    fake.createRoomRetryAfterMs = 45_000;
    const p = await connectFake({});

    await expect(p.post(asTopic('ctx-banned'), asHandle('w'), 'hello')).rejects.toThrow(
      new RegExp(`asked for 45000ms.*${DEFAULT_DEADLINE_MS}ms deadline`),
    );
    expect(fake.createRoomBodies).toHaveLength(1); // refused once, never hammered
    await p.disconnect();
  }, 20_000);
});
