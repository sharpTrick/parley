/**
 * Zulip answers a rate limit with 429 plus a hint in BOTH the `Retry-After` header and a
 * `retry-after` JSON body field (seconds). The plugin's job is to read either, and to leave the
 * default and the ceiling to the shared clamp — a locally re-implemented bound drifts from it. The
 * table pins each source, each precedence, and the two bounds, so an unread hint (waiting the
 * default instead) and an unbounded one (waiting an hour) both fail here.
 */
import { asTopic } from '@sharptrick/parley-core';
import { DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS } from '@sharptrick/parley-net-util';
import { describe, expect, it } from 'vitest';
import { rand, SENDER, useZulip } from './harness.js';

const boot = useZulip();

const POST = 'POST /api/v1/messages';

interface RetryRow {
  name: string;
  headerSeconds?: number;
  bodySeconds?: number;
  /** Inclusive bounds on how long the single retry may take, in ms. */
  window: [number, number];
}

const RETRY_ROWS: RetryRow[] = [
  { name: 'the Retry-After header alone', headerSeconds: 0.05, window: [50, 400] },
  { name: 'the retry-after JSON body alone', bodySeconds: 0.05, window: [50, 400] },
  {
    name: 'both, with the header winning',
    headerSeconds: 0.05,
    bodySeconds: 3,
    window: [50, 400],
  },
  { name: 'neither, falling back to the shared default', window: [DEFAULT_BACKOFF_MS - 50, 1500] },
  {
    name: 'an absurd hint, clamped to the shared ceiling',
    bodySeconds: 3600,
    window: [MAX_BACKOFF_MS - 200, MAX_BACKOFF_MS + 1500],
  },
];

describe('zulip 429 retry honours the hint and stays inside the shared bounds', () => {
  for (const row of RETRY_ROWS) {
    it(`waits per ${row.name}, then succeeds`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`429-${rand()}`);
      fake.rateLimit(POST, {
        times: 1,
        ...(row.headerSeconds === undefined ? {} : { headerSeconds: row.headerSeconds }),
        ...(row.bodySeconds === undefined ? {} : { bodySeconds: row.bodySeconds }),
      });

      const started = Date.now();
      await plugin.post(topic, SENDER, 'through-the-limit');
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(row.window[0]);
      expect(elapsed).toBeLessThanOrEqual(row.window[1]);
      expect(fake.requestCount(POST)).toBe(2);
      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual(['through-the-limit']);
    }, 20_000);
  }

  it('a permanently rate-limited route ends in a thrown error, not an unbounded retry loop', async () => {
    const { plugin, fake } = await boot();
    fake.rateLimit(POST, { times: Number.MAX_SAFE_INTEGER, headerSeconds: 0.05 });

    await expect(plugin.post(asTopic(`429-forever-${rand()}`), SENDER, 'x')).rejects.toThrow(
      /rate limited/i,
    );
    expect(fake.requestCount(POST)).toBeLessThan(20);
  });

  it('a 429 during teardown stops retrying instead of spending the budget', async () => {
    const { plugin, fake } = await boot();
    fake.rateLimit(POST, { times: Number.MAX_SAFE_INTEGER, headerSeconds: 1 });

    const pending = plugin.post(asTopic(`429-cut-${rand()}`), SENDER, 'x').catch((e: unknown) => e);
    await plugin.disconnect();
    const started = Date.now();
    await pending;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
