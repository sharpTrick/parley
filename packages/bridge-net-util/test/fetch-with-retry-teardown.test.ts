import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, STOP_POLL_MS } from '@sharptrick/parley-net-util';
import {
  captureWaits,
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
interface TimerEntry {
  kind: 'timeout' | 'interval';
  fired: boolean;
  cleared: boolean;
}

/**
 * Ledger of the timers armed while it is installed, and how each one ended. A leak is an interval
 * never cleared, or a timeout neither cleared nor fired. Counting `process.getActiveResourcesInfo()`
 * instead cannot see either: that number is global, includes the harness's own timers, and its
 * baseline churns between the two samples — so the comparison passes whatever the module does.
 */
function timerLedger(): { outstanding: () => TimerEntry[]; restore: () => void } {
  const entries: TimerEntry[] = [];
  const byHandle = new Map<unknown, TimerEntry[]>();
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };

  const arm =
    (kind: TimerEntry['kind'], underlying: unknown) =>
    (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]): unknown => {
      const entry: TimerEntry = { kind, fired: false, cleared: false };
      entries.push(entry);
      const handle = (underlying as (...a: unknown[]) => unknown)(
        (...a: unknown[]) => {
          entry.fired = true;
          fn(...a);
        },
        ms,
        ...rest,
      );
      byHandle.set(handle, [...(byHandle.get(handle) ?? []), entry]);
      return handle;
    };

  const disarm =
    (underlying: unknown) =>
    (handle?: unknown): void => {
      for (const entry of byHandle.get(handle) ?? []) entry.cleared = true;
      (underlying as (h?: unknown) => void)(handle);
    };

  globalThis.setTimeout = arm('timeout', real.setTimeout) as unknown as typeof setTimeout;
  globalThis.setInterval = arm('interval', real.setInterval) as unknown as typeof setInterval;
  globalThis.clearTimeout = disarm(real.clearTimeout) as unknown as typeof clearTimeout;
  globalThis.clearInterval = disarm(real.clearInterval) as unknown as typeof clearInterval;

  return {
    outstanding: () =>
      entries.filter((e) => !e.cleared && (e.kind === 'interval' || !e.fired)),
    restore: () => {
      globalThis.setTimeout = real.setTimeout;
      globalThis.setInterval = real.setInterval;
      globalThis.clearTimeout = real.clearTimeout;
      globalThis.clearInterval = real.clearInterval;
    },
  };
}

/** Run `body` with a ledger installed, and report what it left armed. */
async function timersLeftBy(body: () => Promise<unknown>): Promise<TimerEntry[]> {
  const ledger = timerLedger();
  try {
    await body().then(
      () => undefined,
      () => undefined,
    );
  } finally {
    ledger.restore();
  }
  return ledger.outstanding();
}

/**
 * Registrations a call can leave on a signal it does not own. `AbortSignal.any` records the
 * composite in the SOURCE signal's DEPENDENT set rather than as a listener, and Node prunes none of
 * them while the source lives — so this reads both, or a leak simply moves from one to the other.
 */
const dependentsKey = (signal: AbortSignal): symbol | undefined =>
  Object.getOwnPropertySymbols(signal).find((s) => /DependantSignals/i.test(String(s.description)));

function registrationsOn(signal: AbortSignal): { listeners: number; dependents: number } {
  const key = dependentsKey(signal);
  const set =
    key === undefined ? undefined : (signal as unknown as Record<symbol, { size?: number }>)[key];
  return { listeners: getEventListeners(signal, 'abort').length, dependents: set?.size ?? 0 };
}

/** Run `n` calls against ONE caller-owned controller, and report what they left on its signal. */
async function residueLeftBy(n: number): Promise<{ listeners: number; dependents: number }> {
  const controller = new AbortController();
  let call = 0;
  vi.stubGlobal('fetch', () => Promise.resolve(res(++call % 2 === 0 ? 500 : 200, 'body')));
  for (let i = 0; i < n; i++) {
    await fetchWithRetry('https://x/y', { signal: controller.signal }, loop({ maxAttempts: 1 })).then(
      () => undefined,
      () => undefined,
    );
  }
  return registrationsOn(controller.signal);
}

describe('fetchWithRetry', () => {
  // The mechanism a plugin uses to cut a long-poll short on disconnect (telegram/matrix/zulip each
  // hold their own controller): composing the deadline must not disarm it.
  it("a caller's own abort still cancels an in-flight request", async () => {
    stubStalling();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('torn down')), 20);
    const err = await rejects(
      fetchWithRetry('https://x/y', { signal: controller.signal }, loop({ deadlineMs: 10_000 })),
    );
    expect(err.message).toBe('torn down');
  });

  it('stops on a 429 once isStopped() is true, without another request', async () => {
    const state = stubFetch([res(429)]);
    const retryAfterOf = vi.fn(() => 1);
    await expect(
      fetchWithRetry('https://x/y', {}, { ...OPTS, isStopped: () => true, retryAfterOf }),
    ).rejects.toThrow('Test GET /thing → 429 (disconnected)');
    expect(state.calls).toBe(1);
    expect(retryAfterOf).not.toHaveBeenCalled();
  });

  // A disconnect landing during the backoff must not spend another request against a backend whose
  // credentials the plugin has already torn down.
  it('does not issue another request when the stop lands during the backoff', async () => {
    const state = stubFetch([res(429), res(429)]);
    captureWaits();
    let stopped = false;
    await expect(
      fetchWithRetry(
        'https://x/y',
        {},
        {
          ...OPTS,
          isStopped: () => stopped,
          retryAfterOf: () => {
            stopped = true;
            return 1;
          },
        },
      ),
    ).rejects.toThrow('429 (disconnected)');
    expect(state.calls).toBe(1);
  });

  // REAL TIMERS on purpose: `captureWaits()` makes every `setTimeout` fire synchronously, which
  // deletes the wait this class is about. A stop that is only checked around the sleep, never
  // during it, holds `disconnect()` for the server's full stated wait — unbounded, so a routine
  // `Retry-After: 25` keeps a torn-down plugin (and the MCP process) alive for 25 seconds.
  it.each([
    [200, 0],
    [200, 10],
    [1_000, 10],
    [1_000, 50],
    [5_000, 0],
    [5_000, 50],
  ])(
    'abandons a %ims server-stated backoff when the stop lands %ims in',
    async (statedMs, stopAtMs) => {
      const state = stubForever(() => res(429, '', { 'retry-after': String(statedMs / 1000) }));
      let stopped = false;
      setTimeout(() => {
        stopped = true;
      }, stopAtMs);

      const started = Date.now();
      let err: Error | undefined;
      // Nothing may still be armed once it rejects: a backoff timer left running past the
      // rejection pins the event loop, the other half of "disconnect() cannot make the process
      // exit". Measured as the module's OWN created-vs-cleared ledger, not a global count.
      const leaked = await timersLeftBy(async () => {
        err = await rejects(
          fetchWithRetry(
            'https://x/y',
            {},
            loop({ isStopped: () => stopped, deadlineMs: 60_000, maxAttempts: 100 }),
          ),
        );
      });
      const elapsed = Date.now() - started;

      expect(err?.message).toBe('L → 429 (disconnected)');
      expect(elapsed).toBeLessThan(stopAtMs + STOP_POLL_MS + 150);
      expect(state.calls).toBe(1); // it never spent a request after the teardown
      expect(leaked).toEqual([]);
    },
  );

  // The class, not the one row: EVERY path that abandons a call must leave nothing armed. Each row
  // is an abandonment shape the loop has — a leak on any of them pins the event loop just as hard.
  it.each([
    [
      'the attempt cap on a permanent 429',
      (): Promise<unknown> => {
        stubForever(() => res(429, '', { 'retry-after': '0.001' }));
        return fetchWithRetry('https://x/y', {}, loop({ maxAttempts: 3 }));
      },
    ],
    [
      'the wall-clock deadline mid-backoff',
      (): Promise<unknown> => {
        stubForever(() => res(429, '', { 'retry-after': '0.05' }));
        return fetchWithRetry('https://x/y', {}, loop({ maxAttempts: 100, deadlineMs: 120 }));
      },
    ],
    [
      'a stop landing during the backoff',
      (): Promise<unknown> => {
        stubForever(() => res(429, '', { 'retry-after': '30' }));
        let stopped = false;
        setTimeout(() => {
          stopped = true;
        }, 10);
        return fetchWithRetry(
          'https://x/y',
          {},
          loop({ isStopped: () => stopped, deadlineMs: 60_000, maxAttempts: 100 }),
        );
      },
    ],
    [
      "the caller's own abort",
      (): Promise<unknown> => {
        stubStalling();
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('torn down')), 10);
        return fetchWithRetry('https://x/y', { signal: controller.signal }, loop({ deadlineMs: 10_000 }));
      },
    ],
    [
      'a transport failure after a backoff',
      (): Promise<unknown> => {
        let first = true;
        vi.stubGlobal('fetch', () => {
          if (first) {
            first = false;
            return Promise.resolve(res(429, '', { 'retry-after': '0.01' }));
          }
          return Promise.reject(new TypeError('fetch failed'));
        });
        return fetchWithRetry('https://x/y', {}, loop());
      },
    ],
  ])('leaves no timer armed when the call is abandoned by %s', async (_label, run) => {
    expect(await timersLeftBy(run)).toEqual([]);
  });

  // `captureWaits()` installs a `setTimeout` that fires its callback INLINE — a shape no runtime
  // has, and the module used to carry a branch existing only for it. Arming the poll and the
  // resolve before the wait is what removes the need for that branch; reverse the two and every
  // backoff under this stub leaks its 25ms interval.
  it('leaves no timer armed when the wait fires the instant it is armed', async () => {
    stubFetch([res(429, '', { 'retry-after': '2' }), res(200)]);
    captureWaits();
    const leaked = await timersLeftBy(() => fetchWithRetry('https://x/y', {}, loop()));
    expect(leaked).toEqual([]);
  });

  /**
   * The same class as the timer ledger, on the other thing a call can leave behind: a registration
   * on an object the CALLER owns. This package's own docs invite one lifetime controller per plugin
   * ("the mechanism a plugin uses to cut a long-poll short on disconnect"), and it is published, so
   * a long-poll issuing a request every 2s against one controller must not accumulate 43 200
   * registrations a day. Counted at several N so growth shows as a trend rather than a threshold.
   */
  describe('a call leaves no registration on a caller-owned signal', () => {
    it('reads registrations at all, so the rows below are not counting a renamed internal', () => {
      const controller = new AbortController();
      const before = registrationsOn(controller.signal);
      const composites = [1, 2, 3].map(() => AbortSignal.any([controller.signal]));
      controller.signal.addEventListener('abort', () => undefined);
      const after = registrationsOn(controller.signal);
      expect(composites).toHaveLength(3);
      expect(after.dependents - before.dependents).toBe(3);
      expect(after.listeners - before.listeners).toBe(1);
    });

    it.each([1, 10, 200])('after %i calls', async (n) => {
      expect(await residueLeftBy(n)).toEqual({ listeners: 0, dependents: 0 });
    });
  });

  it('still waits the full stated backoff when nothing stops it', async () => {
    const state = stubFetch([res(429, '', { 'retry-after': '0.2' }), res(200, 'ok')]);
    const started = Date.now();
    const out = await fetchWithRetry('https://x/y', {}, loop({ deadlineMs: 60_000 }));
    expect(out.status).toBe(200);
    expect(state.calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });
});
