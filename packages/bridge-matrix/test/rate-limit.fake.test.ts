import { asHandle, asTopic } from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, fakeConfig, FakeSynapse } from './fake-synapse.js';
import { type MatrixPlugin, readRetryAfter } from '../src/index.js';

/**
 * Two CLASSES over Synapse's 429 (`M_LIMIT_EXCEEDED`) on room creation — the one limiter that
 * actually bites this plugin (~2-room burst per user, then ~1 room / 45s).
 *
 *  1. A hint-extraction function must be killed by a mutation to a constant. What is MATRIX's here
 *     is the FIELD NAME and the UNIT — `retry_after_ms`, milliseconds — and nothing else. How a
 *     header and a body hint combine is net-util's rule and is graded there; the rows that used to
 *     restate it here picked header 7000 against body 1000, the one ordering where "the header
 *     wins" and "the header is a floor" agree, so reverting net-util to the wrong one left this
 *     file 13 passed while zulip and discord both reddened.
 *  2. A per-backend `retryAfterOf` must not narrow net-util's shared policy: a SERVER-STATED wait is
 *     honoured in full (the deadline is the only governor, and its message is the actionable one),
 *     and a hint-less 429 returns `undefined` so the shared default applies once rather than being
 *     re-tuned per backend.
 *  3. A stop-the-work hook nothing observes. The retry loop is handed `isStopped`, and a torn-down
 *     plugin that keeps retrying spends exactly the resource this whole file is about — Synapse's
 *     ~1-room-per-45s creation budget — on a generation that is already gone.
 */

const res429 = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
  });

interface HintRow {
  name: string;
  build: () => Response;
  expected: number | undefined;
}

const HINTS: HintRow[] = [
  {
    name: 'retry_after_ms in the body is read as MILLISECONDS, not seconds',
    build: () => res429({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 45_000 }),
    expected: 45_000,
  },
  {
    name: 'a seconds-shaped figure in the same field is still milliseconds',
    build: () => res429({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 45 }),
    expected: 45,
  },
  {
    name: 'a body field Matrix does not use is not read',
    build: () => res429({ errcode: 'M_LIMIT_EXCEEDED', retry_after: 45 }),
    expected: undefined,
  },
  { name: 'neither present', build: () => res429({ errcode: 'M_LIMIT_EXCEEDED' }), expected: undefined },
  {
    name: 'a negative body value is no hint at all',
    build: () => res429({ retry_after_ms: -5 }),
    expected: undefined,
  },
  { name: 'a non-JSON body is no hint at all', build: () => new Response('nope', { status: 429 }), expected: undefined },
];

describe('the 429 hint the retry loop is handed', () => {
  for (const row of HINTS) {
    it(row.name, async () => {
      expect(await readRetryAfter(row.build())).toBe(row.expected);
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

/**
 * Both lifecycle calls that END a generation, so neither can be the one that forgets. `connect()`
 * without a preceding `disconnect()` is a reconnect, and the retry loop it orphans is invisible to
 * every registry the new generation just cleared — the only thing that stops it is the staleness
 * hook under test.
 */
const TEARDOWNS: Record<string, (p: MatrixPlugin) => Promise<void>> = {
  'disconnect()': async (p) => {
    await p.disconnect();
  },
  'connect() — a bare reconnect': async (p) => {
    await p.connect(fakeConfig({}));
  },
};

/** Long enough for several retries before the teardown, short enough to leave many after it. */
const STATED_WAIT_MS = 120;
const TEAR_DOWN_AT_MS = 360;
const OBSERVE_AFTER_MS = 900;

describe('a 429 backoff on POST /createRoom stops the moment the generation ends', () => {
  for (const [name, teardown] of Object.entries(TEARDOWNS)) {
    it(`${name}: the attempt count is frozen at the teardown instant`, async () => {
      fake.createRoomLimited = Number.POSITIVE_INFINITY;
      fake.createRoomRetryAfterMs = STATED_WAIT_MS;
      const p = await connectFake({});
      const posting = p.post(asTopic('ctx-torn-down'), asHandle('w'), 'hello').catch(() => undefined);

      await new Promise((r) => setTimeout(r, TEAR_DOWN_AT_MS));
      const midBackoff = fake.createRoomBodies.length;
      await teardown(p);
      const atTeardown = fake.createRoomBodies.length;

      await new Promise((r) => setTimeout(r, OBSERVE_AFTER_MS));

      expect(midBackoff).toBeGreaterThan(1); // it really was mid-retry, not already finished
      expect(fake.createRoomBodies).toHaveLength(atTeardown);
      await posting;
      await p.disconnect();
    }, 20_000);
  }
});
