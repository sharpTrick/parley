import { asTopic } from '@sharptrick/parley-core';
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

describe('subscribe loop does not silently hot-retry a permanent /sync failure', () => {
  for (const kind of Object.keys(FAILURES) as (keyof typeof FAILURES)[]) {
    it(`${kind}: reports it on stderr and backs off`, async () => {
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

      expect(errors.mock.calls.length).toBeGreaterThan(0);
      expect(String(errors.mock.calls[0]![0])).toContain('/sync failed');
      // The gap between retries GROWS. A flat delay makes these two roughly equal.
      expect(a3 - a2).toBeGreaterThan((a1 - a0) * 2);
    }, 20_000);
  }
});
