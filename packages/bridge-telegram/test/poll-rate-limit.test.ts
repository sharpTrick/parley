import { describe, expect, it, vi } from 'vitest';
import { captureStderr, connectFresh, startFake } from './rig.js';

/**
 * A 429 on the ONE ingestion loop is a statement about the bot token, and retrying it sooner than
 * Telegram asked is what escalates a flood wait into a ban. net-util ends a call whose stated wait
 * does not fit its deadline rather than waiting it out, so the loop above it is where that wait is
 * either honoured or ignored — graded at the server, from the gaps between the polls the fake
 * actually received, for every place a 429 can state its wait and for one that states none.
 */
describe('telegram getUpdates rate limit', () => {
  /** The gaps between consecutive polls the fake received, from the `from`th poll on. */
  const gapsOf = (times: number[], from = 0): number[] =>
    times.slice(from + 1).map((t, i) => t - (times[from + i] as number));

  /**
   * Graded on the timers the loop leaves behind rather than on requests: a wait that ignores the
   * disconnect issues nothing either — it only keeps the process alive for the rest of a flood wait.
   */
  it('lets a disconnect end a stated wait instead of holding it', async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    /** Timers armed from the poll loop's own module that have neither fired nor been cleared. */
    const outstanding = new Set<unknown>();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const fromLoop = /src[\\/]poll\.ts/.test(new Error().stack ?? '');
      const handle: unknown = realSet(
        (...a: unknown[]) => {
          outstanding.delete(handle);
          fn(...a);
        },
        ms,
        ...args,
      );
      if (fromLoop) outstanding.add(handle);
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => {
      outstanding.delete(handle);
      realClear(handle as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout);

    const fake = await startFake();
    captureStderr();
    fake.failMethod('getUpdates', { status: 429, description: 'Too Many Requests', retryAfterBody: 60 });
    const plugin = await connectFresh(fake, { poll_timeout_s: 1 });
    await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBe(1), { timeout: 5000, interval: 20 });
    // Positive control: the loop is inside the wait, and the probe sees the timer it holds.
    await vi.waitFor(() => expect(outstanding.size).toBeGreaterThan(0), { timeout: 2000, interval: 5 });

    await plugin.disconnect();
    await vi.waitFor(() => expect(outstanding.size).toBe(0), { timeout: 1000, interval: 20 });
    await new Promise((r) => realSet(r, 200));
    expect(outstanding.size).toBe(0);
    expect(fake.callCount('getUpdates')).toBe(1);
  }, 20_000);

  const SHAPES = [
    { name: 'a Retry-After past the poll deadline', failure: { retryAfterHeader: 4 }, floorMs: 4000 },
    { name: 'a retry_after past the poll deadline', failure: { retryAfterBody: 4 }, floorMs: 4000 },
    { name: 'a Retry-After inside the poll deadline', failure: { retryAfterHeader: 1 }, floorMs: 1000 },
    { name: 'a retry_after inside the poll deadline', failure: { retryAfterBody: 1 }, floorMs: 1000 },
    { name: 'no stated wait', failure: {}, floorMs: 500 },
  ];

  it.each(SHAPES)(
    'never re-polls sooner than $name allows',
    async ({ failure, floorMs }) => {
      const fake = await startFake();
      captureStderr();
      fake.failMethod('getUpdates', { status: 429, description: 'Too Many Requests', ...failure });
      await connectFresh(fake, { poll_timeout_s: 1 });

      await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBeGreaterThanOrEqual(3), {
        timeout: 15_000,
        interval: 20,
      });
      expect(Math.min(...gapsOf(fake.callTimes('getUpdates')))).toBeGreaterThanOrEqual(floorMs);
    },
    20_000,
  );

  it('backs off further on each 429 that states no wait', async () => {
    const fake = await startFake();
    captureStderr();
    fake.failMethod('getUpdates', { status: 429, description: 'Too Many Requests' });
    await connectFresh(fake, { poll_timeout_s: 1 });

    const longestGap = (): number => Math.max(0, ...gapsOf(fake.callTimes('getUpdates')));
    // A flat retry interval never opens a gap as long as the second backoff; a growing one does.
    await vi.waitFor(() => expect(longestGap()).toBeGreaterThanOrEqual(2000), {
      timeout: 15_000,
      interval: 50,
    });
  }, 20_000);

  it('starts the backoff over once a poll has succeeded', async () => {
    const fake = await startFake();
    captureStderr();
    const limited = { status: 429, description: 'Too Many Requests' };
    fake.failMethod('getUpdates', limited);
    await connectFresh(fake, { poll_timeout_s: 1 });
    const longest = (): number => Math.max(0, ...gapsOf(fake.callTimes('getUpdates')));
    await vi.waitFor(() => expect(longest()).toBeGreaterThanOrEqual(2000), {
      timeout: 15_000,
      interval: 50,
    });

    fake.failMethod('getUpdates', undefined);
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(1), { timeout: 10_000, interval: 20 });
    const recovered = fake.callCount('getUpdates');
    fake.failMethod('getUpdates', limited);
    // The first wait after the next rate-limited call ends: the first backoff, not the one the
    // earlier storm had grown to.
    await vi.waitFor(
      () => expect(gapsOf(fake.callTimes('getUpdates'), recovered).some((g) => g >= 900)).toBe(true),
      { timeout: 15_000, interval: 50 },
    );
    const after = gapsOf(fake.callTimes('getUpdates'), recovered).find((g) => g >= 900) as number;
    expect(after).toBeLessThan(2000);
  }, 45_000);

  /**
   * net-util drops a body wait past its credibility ceiling rather than letting one vendor JSON
   * number decide a call's fate, and the loop must read the same wait it did: honouring one the
   * call itself refused would park the only ingestion path for as long as that number says.
   */
  it('keeps polling past a retry_after too long to be a wait', async () => {
    const fake = await startFake();
    captureStderr();
    fake.failMethod('getUpdates', { status: 429, description: 'Too Many Requests', retryAfterBody: 7_200 });
    await connectFresh(fake, { poll_timeout_s: 1 });
    // A gap longer than the call's own hintless retries, CLOSED by a poll: the loop came back after
    // the call gave up, instead of parking for the two hours the body names.
    await vi.waitFor(
      () => expect(gapsOf(fake.callTimes('getUpdates')).some((g) => g >= 900)).toBe(true),
      { timeout: 15_000, interval: 50 },
    );
  }, 20_000);
});
