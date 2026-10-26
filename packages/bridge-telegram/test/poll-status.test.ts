import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The poll loop's fatal-status branch is the difference between a loud stop and a bridge that
 * hammers a revoked token forever at 500ms intervals. net-util carries the status as a FIELD on
 * `HttpStatusError` and exports `statusOf` to read it; a plugin that instead recovers it by regex
 * over the error's PROSE keeps working only until someone rewords that message.
 *
 * So the failure is injected as an error whose status is reachable only through the field: same
 * class, same status, a message with no `→ <status>` in it. A loop reading the prose reclassifies
 * it as retryable and never stops.
 */
type NetUtil = typeof import('@sharptrick/parley-net-util');

/** How the mocked `fetchWithRetry` fails a `getUpdates`, and every attempt it has seen. */
const failure: { as?: 'status shape' | 'reworded message' | 'no status at all' } = {};
const pollAttempts: number[] = [];

vi.mock('@sharptrick/parley-net-util', async (importOriginal) => {
  const actual = await importOriginal<NetUtil>();
  return {
    ...actual,
    fetchWithRetry: async (
      url: string,
      init: RequestInit,
      opts: Parameters<NetUtil['fetchWithRetry']>[2],
    ): Promise<Response> => {
      if (!opts.label.includes('/getUpdates')) return actual.fetchWithRetry(url, init, opts);
      pollAttempts.push(Date.now());
      if (failure.as === 'no status at all') {
        throw new Error(`${opts.label} → transport: ECONNRESET`);
      }
      const err = new actual.HttpStatusError(opts.label, 401, 'Unauthorized');
      if (failure.as === 'reworded message') {
        Object.defineProperty(err, 'message', { value: 'Unauthorized (401) polling for updates' });
      }
      throw err;
    },
  };
});

const { captureStderr, connectTo, startFake, storePath } = await import('./rig.js');

afterEach(() => {
  failure.as = undefined;
  pollAttempts.length = 0;
});

const CASES = [
  { as: 'status shape' as const, fatal: true },
  { as: 'reworded message' as const, fatal: true },
  { as: 'no status at all' as const, fatal: false },
];

describe('telegram poll-loop status classification', () => {
  it.each(CASES)('a getUpdates failure delivered as a $as stops ingestion: $fatal', async ({ as, fatal }) => {
    const stderr = captureStderr();
    const fake = await startFake();
    failure.as = as;
    await connectTo(fake, storePath());

    await vi.waitFor(() => expect(pollAttempts.length).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 10,
    });
    if (fatal) {
      await vi.waitFor(() => expect(stderr.join('')).toMatch(/ingestion stopped/), {
        timeout: 3000,
        interval: 10,
      });
      const spent = pollAttempts.length;
      await new Promise((r) => setTimeout(r, 800));
      expect(pollAttempts.length).toBe(spent);
      return;
    }
    // No recoverable status is not a fatal one: an unclassifiable failure must keep retrying.
    await vi.waitFor(() => expect(pollAttempts.length).toBeGreaterThan(1), {
      timeout: 5000,
      interval: 20,
    });
    expect(stderr.join('')).toMatch(/retrying/);
  }, 20_000);
});
