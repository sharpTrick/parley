import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a background loop must not turn a permanent error into a silent infinite retry. A revoked
 * access token (401), a kick (403), a broken homeserver (500), or a dropped socket all land in the
 * same catch — the loop must recover from the transient ones and, for the permanent ones, say so on
 * stderr and slow down instead of hammering the homeserver forever with a dead live path.
 */

const FAILURES = {
  '401 (revoked token)': { mode: 'status', status: 401 },
  '403 (kicked from room)': { mode: 'status', status: 403 },
  '500 (homeserver fault)': { mode: 'status', status: 500 },
  'network reject': { mode: 'network', status: 0 },
} as const;

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const arm = (kind: keyof typeof FAILURES, count: number): void => {
  const f = FAILURES[kind];
  fake.syncFailureMode = f.mode;
  fake.syncFailureStatus = f.status;
  fake.syncFailures = count;
};

describe('subscribe loop survives a transient /sync failure', () => {
  for (const kind of Object.keys(FAILURES) as (keyof typeof FAILURES)[]) {
    it(`${kind}: recovers after 3 failures and still delivers`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      const t = asTopic('resilient');
      const got: string[] = [];
      await p.subscribe(t, (m) => got.push(m.content));
      arm(kind, 3);
      fake.addMessage(String(t), 'after-the-outage');

      await vi.waitFor(() => expect(got).toEqual(['after-the-outage']), {
        timeout: 8000,
        interval: 20,
      });
      await p.disconnect();
    }, 20_000);
  }
});

/** The `(N consecutive; …)` counts a run reported on stderr, in order. */
const reportedFailureCounts = (calls: unknown[][]): number[] =>
  calls
    .map((c) => /\((\d+) consecutive;/.exec(String(c[0]))?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);

describe('subscribe loop does not silently hot-retry a permanent /sync failure', () => {
  for (const kind of Object.keys(FAILURES) as (keyof typeof FAILURES)[]) {
    it(`${kind}: reports it on stderr, throttled, and backs off`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      arm(kind, Number.POSITIVE_INFINITY);
      await p.subscribe(asTopic('doomed'), () => undefined);

      await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(4), {
        timeout: 8000,
        interval: 20,
      });
      const [a0, a1, a2, a3] = fake.syncAttempts as [number, number, number, number];
      await p.disconnect();
      const attempts = fake.syncAttempts.length;

      expect(String(errors.mock.calls[0]![0])).toContain('/sync failed');
      // The gap between retries GROWS. A flat delay makes these two roughly equal.
      expect(a3 - a2).toBeGreaterThan((a1 - a0) * 2);

      // The stated throttle, graded by CARDINALITY: an outage of `attempts` retries costs about
      // log2(attempts) lines, at exactly the powers of two, each reported once. A ceiling alone is
      // satisfied by logging nothing, so the floor is asserted too.
      const reported = reportedFailureCounts(errors.mock.calls);
      expect(reported).toEqual([...new Set(reported)]);
      for (const n of reported) expect(n & (n - 1)).toBe(0);
      expect(reported.length).toBeLessThanOrEqual(Math.floor(Math.log2(attempts)) + 1);
      expect(reported.slice(0, 3)).toEqual([1, 2, 4]);
    }, 20_000);
  }
});

/**
 * CLASS: a malformed-but-PARSEABLE upstream response must not escape a fire-and-forget loop. Every
 * fault above is an HTTP status or a socket error, and both land in the loop's own try — so none of
 * them ever reaches the code that dereferences a `/sync` body. A body `res.json()` accepts but whose
 * shape the loop assumes (`null`, a scalar, a `timeline.events` that is not a list) throws from a
 * `void`-ed promise instead: under Node's default that terminates an MCP stdio bridge, and at best
 * the live path ends with no retry and nothing on stderr.
 *
 * Both fire-and-forget `/sync` drivers are graded, because they are separate loops with separate
 * error handling: `subscribe`'s, and the dedicated bounded one a blocking `fetchRecent` drives when
 * no subscription covers its topic.
 */
const FRESH = 'after-the-garbage';

/**
 * Shapes a homeserver, a proxy, or a captive portal can put on the wire that still parse as JSON,
 * each with what a PERSISTENT occurrence of it must degrade to. `reported` = the loop throws on it,
 * so it owes the operator a stderr line and a backoff; `paced` = the loop cannot tell it from an
 * empty sync, so it owes no diagnostic but must still not hot-spin. Keep the degradation on the row,
 * so that widening this table cannot add a shape nobody grades past survival.
 */
const MALFORMED: Record<string, { body: (roomId: string) => unknown; degrades: 'reported' | 'paced' }> =
  {
    'JSON null': { body: () => null, degrades: 'reported' },
    'an array': { body: () => [], degrades: 'paced' },
    'a bare string': { body: () => 'ok', degrades: 'paced' },
    'a number': { body: () => 123, degrades: 'paced' },
    'rooms: null': { body: () => ({ next_batch: 'p0', rooms: null }), degrades: 'paced' },
    'rooms.join is not a map': {
      body: () => ({ next_batch: 'p0', rooms: { join: 'x' } }),
      degrades: 'paced',
    },
    'next_batch is not a token': { body: () => ({ next_batch: 42 }), degrades: 'reported' },
    'timeline.events is not a list': {
      body: (roomId) => ({
        next_batch: 'p0',
        rooms: { join: { [roomId]: { timeline: { events: 42, limited: false } } } },
      }),
      degrades: 'reported',
    },
  };

/** Each driver arms the body, lands one well-formed message behind it, and reports what arrived. */
const DRIVERS: Record<string, (arm: () => void) => Promise<string[]>> = {
  'the subscribe loop': async (arm) => {
    const p = await connectFake({});
    const t = asTopic('resilient');
    const got: string[] = [];
    await p.subscribe(t, (m) => got.push(m.content));
    arm();
    fake.addMessage(String(t), FRESH);
    await vi
      .waitFor(() => expect(got).toContain(FRESH), { timeout: 8000, interval: 20 })
      .catch(() => undefined);
    await p.disconnect();
    return got;
  },
  'the dedicated /sync behind a blocking fetchRecent': async (arm) => {
    const p = await connectFake({});
    const t = asTopic('resilient');
    await p.post(t, asHandle('writer'), 'seed');
    const tail = (await p.fetchRecent({ topic: t, limit: 10 })).nextCursor;
    arm();
    const pending = p.fetchRecent({ topic: t, since: tail, blockMs: 8000, limit: 10 });
    const lands = setTimeout(() => void fake.addMessage(String(t), FRESH), 100);
    const got = (await pending).messages.map((m) => m.content);
    clearTimeout(lands);
    await p.disconnect();
    return got;
  },
};

describe('a malformed but parseable /sync body never escapes a background loop', () => {
  for (const [bodyName, shape] of Object.entries(MALFORMED)) {
    for (const [driverName, drive] of Object.entries(DRIVERS)) {
      it(`${bodyName} / ${driverName}: reported and retried, never an unhandled rejection`, async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const escaped: unknown[] = [];
        const onEscape = (reason: unknown): void => void escaped.push(reason);
        process.on('unhandledRejection', onEscape);
        let got: string[] = [];
        try {
          got = await drive(() => void fake.syncBodyOverrides.push(shape.body));
          await new Promise((r) => setTimeout(r, 50)); // let a rejection reach the event loop.
        } finally {
          process.off('unhandledRejection', onEscape);
        }

        expect(escaped.map(String)).toEqual([]);
        expect(got).toContain(FRESH);
      }, 30_000);
    }
  }

  /**
   * The one throw the ladder above cannot contain: the failure REPORT itself, which runs in the
   * loop's `catch` and therefore outside every try. An MCP bridge speaks over stdio, and a closed
   * pipe makes `console.error` throw — so the loop's own error path is the last place a rejection can
   * escape from.
   */
  it('a stderr write that throws is contained too', async () => {
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown): void => void escaped.push(reason);
    process.on('unhandledRejection', onEscape);
    let firstWrite = true;
    vi.spyOn(console, 'error').mockImplementation(() => {
      if (!firstWrite) return;
      firstWrite = false;
      throw new Error('EPIPE: stderr is closed');
    });
    const p = await connectFake({});
    fake.syncFailureStatus = 500;
    fake.syncFailures = Number.POSITIVE_INFINITY;

    try {
      await p.subscribe(asTopic('resilient'), () => undefined);
      await vi
        .waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(1), {
          timeout: 4000,
          interval: 20,
        })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off('unhandledRejection', onEscape);
      await p.disconnect();
    }

    expect(escaped.map(String)).toEqual([]);
  }, 20_000);
});

/**
 * CLASS: a malformed-upstream row must grade the DEGRADATION, not just survival. The table above
 * arms each shape ONCE and asserts only that a later well-formed message arrives — which a variant
 * that adopts the bad token, ignores it silently, or re-issues `/sync` as fast as the socket allows
 * satisfies just as well. What separates them is what a PERSISTENT occurrence costs the deployment:
 * a shape the loop throws on owes the operator a stderr line and an exponential backoff, and one it
 * cannot tell from an empty sync owes no diagnostic but must still be paced. Without this, a
 * homeserver or proxy answering one bad shape forever presents as a dead live path, no operator
 * signal, and roughly a thousandfold the request rate.
 *
 * Graded on the subscribe loop alone: it is the only `/sync` driver that reports or backs off — the
 * dedicated one behind a blocking `fetchRecent` is bounded by the caller's own `blockMs`.
 */

/** Arm a shape that RE-ARMS itself, so every `/sync` for the rest of the case answers with it. */
const armForever = (body: (roomId: string) => unknown): void => {
  const again = (roomId: string): unknown => {
    fake.syncBodyOverrides.push(again);
    return body(roomId);
  };
  fake.syncBodyOverrides.push(again);
};

/** Long enough for the paced arm to run many `/sync` rounds, short enough to keep the file quick. */
const PACING_WINDOW_MS = 600;
/**
 * Attempts a PACED loop can fit in that window. The pace floor is 25ms, so a conforming loop lands
 * near 24; an unpaced one is bounded only by the fake's 1ms round-trip and lands in the hundreds.
 */
const PACED_ATTEMPT_CEILING = 100;

describe('a malformed /sync body that never stops is reported and slowed, not hot-retried', () => {
  for (const [bodyName, shape] of Object.entries(MALFORMED)) {
    it(`${bodyName}: degrades ${shape.degrades}`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      // Arm BEFORE subscribe, so that every incremental `/sync` of the run is the shape under test
      // and the attempt timestamps below are consecutive occurrences of it.
      armForever(shape.body);
      await p.subscribe(asTopic('doomed'), () => undefined);

      if (shape.degrades === 'paced') {
        await new Promise((r) => setTimeout(r, PACING_WINDOW_MS));
        const attempts = fake.syncAttempts.length;
        await p.disconnect();

        expect(reportedFailureCounts(errors.mock.calls)).toEqual([]);
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThan(PACED_ATTEMPT_CEILING);
        return;
      }

      await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(4), {
        timeout: 8000,
        interval: 20,
      });
      const [a0, a1, a2, a3] = fake.syncAttempts as [number, number, number, number];
      await p.disconnect();

      // The same two assertions the 401/403/500/network table makes: the gap between retries GROWS…
      expect(a3 - a2).toBeGreaterThan((a1 - a0) * 2);
      // …and the operator hears about it, at exactly the powers of two, each reported once.
      const reported = reportedFailureCounts(errors.mock.calls);
      expect(reported).toEqual([...new Set(reported)]);
      for (const n of reported) expect(n & (n - 1)).toBe(0);
      expect(reported.slice(0, 3)).toEqual([1, 2, 4]);
    }, 20_000);
  }
});
