import { afterEach, describe, expect, it, vi } from 'vitest';
import { delay, fetchWithRetry } from '@sharptrick/parley-net-util';

/**
 * `fetchWithRetry` is the one HTTP-with-429-retry loop shared by all five HTTP backends (Zulip,
 * Matrix, Discord, Telegram, Slack), and it shipped with no tests of its own — its behaviour was
 * only ever exercised indirectly through one Slack regression test. These cover the loop directly.
 */

const OPTS = {
  label: 'Test GET /thing',
  isStopped: () => false,
  retryAfterOf: () => 1,
};

/** Queue up canned responses; the stub returns them in order and records every call. */
function stubFetch(responses: Response[]): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', () => {
    const res = responses[state.calls];
    state.calls++;
    if (res === undefined) throw new Error(`unexpected fetch call #${state.calls}`);
    return Promise.resolve(res);
  });
  return state;
}

const res = (status: number, body = '', headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchWithRetry', () => {
  it('returns a 2xx response without retrying', async () => {
    const state = stubFetch([res(200, 'hello')]);
    const out = await fetchWithRetry('https://x/y', {}, OPTS);
    expect(out.status).toBe(200);
    expect(await out.text()).toBe('hello');
    expect(state.calls).toBe(1);
  });

  it('passes the caller-built init straight through to fetch', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(res(200));
    });
    const init = { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{"a":1}' };
    await fetchWithRetry('https://x/y', init, OPTS);
    expect(seen).toEqual([init]);
  });

  // The five backends have genuinely different "expected" non-2xx statuses (404 for a missing
  // room, 409 for a duplicate join, …); the loop must hand those back rather than throw.
  it.each([404, 409, 410])('returns an allowStatuses status (%i) instead of throwing', async (s) => {
    stubFetch([res(s, 'nope')]);
    const out = await fetchWithRetry('https://x/y', {}, { ...OPTS, allowStatuses: [s] });
    expect(out.status).toBe(s);
  });

  it('throws `label -> status: body` on an unexpected non-2xx', async () => {
    stubFetch([res(500, 'boom')]);
    await expect(fetchWithRetry('https://x/y', {}, OPTS)).rejects.toThrow(
      'Test GET /thing → 500: boom',
    );
  });

  it('does not treat an allowStatuses entry as a licence to swallow other failures', async () => {
    stubFetch([res(503, 'unavailable')]);
    await expect(
      fetchWithRetry('https://x/y', {}, { ...OPTS, allowStatuses: [404] }),
    ).rejects.toThrow('Test GET /thing → 503: unavailable');
  });

  it('retries a 429 until success and returns the final response', async () => {
    const state = stubFetch([res(429), res(429), res(200, 'done')]);
    const out = await fetchWithRetry('https://x/y', {}, OPTS);
    expect(await out.text()).toBe('done');
    expect(state.calls).toBe(3);
  });

  it('waits exactly what retryAfterOf returns, per attempt', async () => {
    stubFetch([res(429), res(429), res(200)]);
    const waits: number[] = [];
    const retryAfterOf = vi.fn(() => {
      const ms = waits.length === 0 ? 7 : 13;
      waits.push(ms);
      return ms;
    });
    const started = Date.now();
    await fetchWithRetry('https://x/y', {}, { ...OPTS, retryAfterOf });
    expect(retryAfterOf).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([7, 13]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
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

  it('hands the 429 response itself to retryAfterOf so headers are readable', async () => {
    stubFetch([res(429, '', { 'retry-after': '2' }), res(200)]);
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
    expect(seen).toEqual(['2']);
  });

  // A disconnected plugin must not keep a retry loop alive: the check happens BEFORE the wait, so
  // shutdown is not delayed by a pending back-off, and it must not re-issue the request.
  it('stops on a 429 once isStopped() is true, without another request', async () => {
    const state = stubFetch([res(429)]);
    const retryAfterOf = vi.fn(() => 1);
    await expect(
      fetchWithRetry('https://x/y', {}, { ...OPTS, isStopped: () => true, retryAfterOf }),
    ).rejects.toThrow('Test GET /thing → 429 (disconnected)');
    expect(state.calls).toBe(1);
    expect(retryAfterOf).not.toHaveBeenCalled();
  });

  it('honours a stop that arrives mid-retry', async () => {
    const state = stubFetch([res(429), res(429)]);
    let stopped = false;
    await expect(
      fetchWithRetry(
        'https://x/y',
        {},
        {
          ...OPTS,
          isStopped: () => stopped,
          retryAfterOf: () => {
            stopped = true; // disconnect lands while we are backing off
            return 1;
          },
        },
      ),
    ).rejects.toThrow('429 (disconnected)');
    expect(state.calls).toBe(2);
  });

  // BUG-41: `Number(null) === 0`, so a 429 with no Retry-After header must NOT become a 0 ms tight
  // loop. fetchWithRetry DELEGATES that guard to each caller's retryAfterOf rather than enforcing
  // it, so this pins the delegation contract: whatever the caller returns is what is waited. The
  // matching guard on the callers' side is covered by each backend's own suite.
  it('waits precisely the caller-supplied backoff, including a pathological 0', async () => {
    stubFetch([res(429), res(200)]);
    const retryAfterOf = vi.fn(() => 0);
    const out = await fetchWithRetry('https://x/y', {}, { ...OPTS, retryAfterOf });
    expect(out.status).toBe(200);
    expect(retryAfterOf).toHaveBeenCalledTimes(1);
  });

  it('propagates a transport-level fetch rejection unchanged', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(fetchWithRetry('https://x/y', {}, OPTS)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('delay', () => {
  it('resolves after roughly the requested time', async () => {
    const started = Date.now();
    await delay(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('resolves immediately for 0', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});
