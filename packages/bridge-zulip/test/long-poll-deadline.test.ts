/**
 * CLASS: a request the plugin intends to PARK longer than the shared call deadline must raise its
 * own `deadlineMs`. `fetchWithRetry` aborts any call that gets no response within
 * `DEFAULT_DEADLINE_MS`, and that abort is indistinguishable from a transport failure to the caller:
 * the push loop's `capped` flag stays false, so a perfectly healthy idle long-poll reads as a
 * backend failure and escalates into backoff, `degrade()` and error spam — and a blocked
 * `fetchRecent` stops piggybacking on the live queue and starts minting dedicated ones instead.
 * Every `events_timeout_ms` above the shared default (a range `connect()` accepts and the README
 * documents as valid) and every `block_ms` above it (core's cap defaults to 60s) sits in that hole.
 *
 * Two layers, because neither reaches the whole class alone. The behavioural rows scale the shared
 * default down to {@link SCALED_DEFAULT_MS} so the degradation is observable in milliseconds instead
 * of half a minute. The structural rows then pin the arithmetic across the documented range, which
 * no affordable wall-clock test can reach.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { rand, SENDER, sleep, useZulip } from './harness.js';

const { calls, shared } = vi.hoisted(() => ({
  calls: [] as { route: string; deadlineMs: number | undefined }[],
  shared: { scaledDefaultMs: undefined as number | undefined },
}));

vi.mock('@sharptrick/parley-net-util', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sharptrick/parley-net-util')>();
  return {
    ...real,
    fetchWithRetry: (url: string, init: RequestInit, opts: { deadlineMs?: number }) => {
      const route = `${init.method ?? 'GET'} ${new URL(String(url)).pathname}`;
      calls.push({ route, deadlineMs: opts.deadlineMs });
      const deadlineMs = opts.deadlineMs ?? shared.scaledDefaultMs;
      return real.fetchWithRetry(url, init, { ...opts, deadlineMs } as never);
    },
  };
});

/** Stands in for `DEFAULT_DEADLINE_MS` in the behavioural rows — the same relation, 100× faster. */
const SCALED_DEFAULT_MS = 300;
/** Long enough for at least one poll to outlive {@link SCALED_DEFAULT_MS} and be severed. */
const OBSERVE_MS = 700;
/** Above every wall-clock wait below, so the fake never answers an idle poll on its own. */
const NEVER_HEARTBEATS_MS = 30_000;

/** Only the long-poll parks: `DELETE /api/v1/events` is a teardown request on the same path. */
const PARKING_ROUTE = 'GET /api/v1/events';

const parkingCalls = (): { deadlineMs: number | undefined }[] =>
  calls.filter((c) => c.route === PARKING_ROUTE);

const boot = useZulip();

beforeEach(() => {
  calls.length = 0;
  shared.scaledDefaultMs = undefined;
});

/** `events_timeout_ms` values straddling the (scaled) shared default. */
const PARK_ROWS = [SCALED_DEFAULT_MS - 50, SCALED_DEFAULT_MS + 200, SCALED_DEFAULT_MS * 4];

describe('an idle long-poll the plugin asked for is never read as a backend failure', () => {
  for (const eventsTimeoutMs of PARK_ROWS) {
    it(`events_timeout_ms ${eventsTimeoutMs} vs a ${SCALED_DEFAULT_MS}ms shared default`, async () => {
      shared.scaledDefaultMs = SCALED_DEFAULT_MS;
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { plugin, fake } = await boot(
        { heartbeatMs: NEVER_HEARTBEATS_MS },
        { events_timeout_ms: eventsTimeoutMs },
      );
      const topic = asTopic(`park-${rand()}`);
      await plugin.post(topic, SENDER, 'seed');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor;

      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));
      await sleep(OBSERVE_MS);

      // A blocked fetch piggybacks on a HEALTHY loop's queue and opens none of its own; the loop
      // stops advertising itself the moment it mistakes its own severed poll for a failure.
      await plugin.fetchRecent({ topic, since: tail, blockMs: 200 });
      expect(fake.requestCount('POST /api/v1/register')).toBe(1);
      const reported = error.mock.calls.map((c) => String(c[0]));
      expect(reported.filter((m) => m.includes('[parley-zulip]'))).toEqual([]);

      await plugin.post(topic, SENDER, 'live');
      await sleep(300);
      expect(got.map((m) => m.content)).toEqual(['live']);
    }, 15_000);
  }

  it('a blocked fetchRecent with no subscription parks its queue for the whole budget', async () => {
    shared.scaledDefaultMs = SCALED_DEFAULT_MS;
    const { plugin, fake } = await boot({ heartbeatMs: NEVER_HEARTBEATS_MS });
    const topic = asTopic(`park-solo-${rand()}`);
    await plugin.post(topic, SENDER, 'seed');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor;

    const { messages } = await plugin.fetchRecent({
      topic,
      since: tail,
      blockMs: SCALED_DEFAULT_MS * 3,
    });
    expect(messages).toEqual([]);
    expect(fake.requestCount('POST /api/v1/register')).toBe(1);
  }, 15_000);
});

/** The documented range, including the two values either side of the shared default. */
const EVENTS_TIMEOUTS = [250, 25_000, 30_000, 30_001, 60_000, 600_000];

describe('every parking request carries a deadline beyond the wait it asked for', () => {
  for (const eventsTimeoutMs of EVENTS_TIMEOUTS) {
    it(`events_timeout_ms: ${eventsTimeoutMs}`, async () => {
      const { plugin } = await boot(
        { heartbeatMs: NEVER_HEARTBEATS_MS },
        { events_timeout_ms: eventsTimeoutMs },
      );
      await plugin.subscribe(asTopic(`deadline-${rand()}`), () => undefined);
      await sleep(80);
      await plugin.disconnect();

      const polls = parkingCalls();
      expect(polls.length).toBeGreaterThan(0);
      for (const poll of polls) {
        expect(poll.deadlineMs).toBeGreaterThanOrEqual(eventsTimeoutMs + DEFAULT_DEADLINE_MS);
      }
    }, 15_000);
  }

  /** `block_ms` reaches the plugin from core's `catchup.block_max_ms`, which defaults to 60000. */
  for (const blockMs of [250, 30_000, 60_000]) {
    it(`block_ms: ${blockMs}`, async () => {
      const { plugin } = await boot({ heartbeatMs: NEVER_HEARTBEATS_MS });
      const topic = asTopic(`deadline-block-${rand()}`);
      await plugin.post(topic, SENDER, 'seed');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor;

      void plugin.fetchRecent({ topic, since: tail, blockMs }).catch(() => undefined);
      await sleep(80);
      await plugin.disconnect();

      const polls = parkingCalls();
      expect(polls.length).toBeGreaterThan(0);
      for (const poll of polls) expect(poll.deadlineMs).toBeGreaterThanOrEqual(blockMs);
    }, 15_000);
  }

  it('a request that does not park keeps the shared default budget', async () => {
    const { plugin } = await boot({ heartbeatMs: NEVER_HEARTBEATS_MS });
    const topic = asTopic(`no-park-${rand()}`);
    await plugin.post(topic, SENDER, 'seed');
    await plugin.fetchRecent({ topic });
    await plugin.resolveIdentity(SENDER);
    await plugin.disconnect();

    const others = calls.filter((c) => c.route !== PARKING_ROUTE);
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((c) => c.deadlineMs !== undefined)).toEqual([]);
  }, 15_000);
});

describe('a raised deadline is not a licence to ignore the caller signal', () => {
  it('disconnect ends a 600s-capped poll at once rather than at its deadline', async () => {
    const plugin = new ZulipPlugin();
    const { fake } = await boot({ heartbeatMs: NEVER_HEARTBEATS_MS });
    await plugin.connect({ site_url: fake.url, events_timeout_ms: 600_000 });
    await plugin.subscribe(asTopic(`abort-${rand()}`), () => undefined);
    await sleep(80);
    const started = Date.now();
    await plugin.disconnect();
    expect(Date.now() - started).toBeLessThan(2000);
  }, 15_000);
});
