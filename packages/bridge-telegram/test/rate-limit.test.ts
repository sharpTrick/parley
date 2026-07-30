import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { startRig } from './rig.js';

const SENDER = asHandle('me');
const TOPIC = asTopic('-1009600001');

/**
 * Telegram rate-limits `sendMessage` aggressively, so the 429 path is this plugin's most likely
 * production error path — and the one an operator can least afford to have wrong in either
 * direction: retrying sooner than Telegram asked is what escalates a rate limit into a ban, and
 * reading its SECONDS as milliseconds turns a 30s pause into a 30ms hammer.
 *
 * Graded at the server, from the gap between the two requests the fake actually received, so it
 * measures the backoff the plugin APPLIED rather than unit-testing the parser that suggests it.
 *
 * A hint the plugin INVENTED is clamped by net-util; a wait the SERVER stated is not. `waits`
 * rows pin the gap; `ends the call` rows pin the etiquette invariant on a wait too long to fit
 * this call's deadline — the request must not be reissued at all, never reissued early. The
 * two together say: the observed gap is either at least what Telegram asked for, or there is no
 * second request. A plugin re-tuning the shared backoff policy fails one of them for every
 * stated wait, not just for the one value someone thought to pin.
 */
describe('telegram 429 backoff', () => {
  const CASES = [
    { name: 'header only', retryAfterHeader: 1, expected: 1000 },
    { name: 'body only', retryAfterBody: 1, expected: 1000 },
    { name: 'both, header wins', retryAfterHeader: 1, retryAfterBody: 4, expected: 1000 },
    { name: 'header 0 falls through to the body', retryAfterHeader: 0, retryAfterBody: 2, expected: 2000 },
    { name: 'body 0 falls through to the default', retryAfterBody: 0, expected: 500 },
    { name: 'negative body falls through to the default', retryAfterBody: -3, expected: 500 },
    { name: 'no hint at all', expected: 500 },
    { name: 'a stated wait past the invented-backoff clamp', retryAfterBody: 6, expected: 6000 },
    { name: 'a flood wait in the body', retryAfterBody: 30, expected: 'ends the call' as const },
    { name: 'a flood wait in the header', retryAfterHeader: 45, expected: 'ends the call' as const },
    { name: 'an absurd flood wait', retryAfterBody: 600, expected: 'ends the call' as const },
  ];

  it.each(CASES)(
    '$name → $expected',
    async ({ retryAfterHeader, retryAfterBody, expected }) => {
      const { fake, plugin } = await startRig();
      fake.failMethod('sendMessage', {
        status: 429,
        description: 'Too Many Requests: retry later',
        retryAfterHeader,
        retryAfterBody,
        times: 1,
      });

      if (expected === 'ends the call') {
        await expect(plugin.post(TOPIC, SENDER, 'rate-limited')).rejects.toThrow(/429/);
        // Not one early retry: the vendor's wait did not fit, so the call ended instead.
        expect(fake.callTimes('sendMessage')).toHaveLength(1);
        return;
      }

      await expect(plugin.post(TOPIC, SENDER, 'rate-limited')).resolves.toBeDefined();
      const times = fake.callTimes('sendMessage');
      expect(times).toHaveLength(2);
      const gap = (times[1] as number) - (times[0] as number);
      expect(gap).toBeGreaterThanOrEqual(expected - 50);
      expect(gap).toBeLessThan(expected + 750);
      // The retried call is the one that landed: the message is in the store exactly once.
      expect((await plugin.fetchRecent({ topic: TOPIC })).messages.map((m) => m.content)).toEqual([
        'rate-limited',
      ]);
    },
    30_000,
  );

  it('gives up loudly rather than retrying a 429 forever', async () => {
    const { fake, plugin } = await startRig();
    fake.failMethod('sendMessage', {
      status: 429,
      description: 'Too Many Requests: retry later',
      retryAfterBody: 1,
    });
    await expect(plugin.post(TOPIC, SENDER, 'never lands')).rejects.toThrow(/429/);
  }, 30_000);
});
