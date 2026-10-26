import { afterEach, describe, expect, it, vi } from 'vitest';
import { delay } from '@sharptrick/parley-net-util';
import { sleepUnlessStopped } from '../src/timing.js';

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

/**
 * A wait either side of the longest delay a Node timer holds, and past it by one piece and by
 * several. Handed to `setTimeout` whole, every row past 2^31-1 wraps and fires at 1ms. Fake timers
 * reproduce that wrap, so these rows can wait out the full figure without waiting it out for real.
 */
const LONG_WAITS: readonly number[] = [
  2 ** 31 - 2,
  2 ** 31 - 1,
  2 ** 31,
  30 * 24 * 60 * 60 * 1000,
  2 * (2 ** 31 - 1) + 5,
];

/** Advance fake time by `ms` and report whether `settled` flipped. */
async function settledAfter(ms: number, settled: () => boolean): Promise<boolean> {
  await vi.advanceTimersByTimeAsync(ms);
  return settled();
}

describe('a wait past the timer range is honoured in full', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(LONG_WAITS)('delay(%i) resolves at that wait, not before', async (ms) => {
    vi.useFakeTimers();
    let done = false;
    void delay(ms).then(() => (done = true));
    expect(await settledAfter(100, () => done)).toBe(false);
    expect(await settledAfter(ms - 101, () => done)).toBe(false);
    expect(await settledAfter(1, () => done)).toBe(true);
  });

  // Only the wait timer is faked: the stop poll stays real, or a month of fake time would run
  // a hundred million of its 25ms ticks.
  const fakeWaitTimerOnly = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  };

  it.each(LONG_WAITS)('sleepUnlessStopped(%i) waits it out when nothing stops it', async (ms) => {
    fakeWaitTimerOnly();
    let waited: boolean | undefined;
    void sleepUnlessStopped(ms, () => false).then((v) => (waited = v));
    expect(await settledAfter(100, () => waited !== undefined)).toBe(false);
    expect(await settledAfter(ms - 101, () => waited !== undefined)).toBe(false);
    expect(await settledAfter(1, () => waited === true)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stop after the first piece fires cancels the piece armed after it', async () => {
    fakeWaitTimerOnly();
    let stopped = false;
    const sleeping = sleepUnlessStopped(2 ** 31 + 5, () => stopped);
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(vi.getTimerCount()).toBe(1);
    stopped = true;
    expect(await sleeping).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
