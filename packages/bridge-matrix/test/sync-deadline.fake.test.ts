import { asHandle, asTopic } from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncDeadlineMs } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a per-plugin timing knob must stay inside every transport bound it composes with. The
 * shared `fetchWithRetry` aborts a call that gets no response within its deadline — 30s by default
 * — so a `/sync` that asks the homeserver to block for `sync_timeout_ms` must carry a deadline
 * beyond it. Otherwise the documented, unbounded knob is silently capped: at 30000 (matrix-js-sdk's
 * own default, and the obvious value for fewer round-trips) every idle long-poll is aborted
 * client-side, the live path degrades into the retry backoff, and the operator's logs blame the
 * homeserver.
 */

const { calls } = vi.hoisted(() => ({
  calls: [] as { url: string; deadlineMs: number | undefined }[],
}));

vi.mock('@sharptrick/parley-net-util', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sharptrick/parley-net-util')>();
  return {
    ...real,
    fetchWithRetry: (url: string, init: RequestInit, opts: { deadlineMs?: number }) => {
      calls.push({ url: String(url), deadlineMs: opts.deadlineMs });
      return real.fetchWithRetry(url, init, opts as never);
    },
  };
});

const WRITER = asHandle('writer');
/** 30000 is the value that breaks at the shared default; the others straddle it. */
const SYNC_TIMEOUTS = [1000, 25_000, 30_000, 60_000];

let fake: FakeSynapse;
beforeEach(() => {
  calls.length = 0;
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const syncCalls = (): { timeout: number; deadlineMs: number | undefined }[] =>
  calls
    .filter((c) => new URL(c.url).pathname.endsWith('/v3/sync'))
    .map((c) => ({
      timeout: Number(new URL(c.url).searchParams.get('timeout')),
      deadlineMs: c.deadlineMs,
    }));

describe('every /sync carries a call deadline beyond the long-poll it asked for', () => {
  for (const syncTimeoutMs of SYNC_TIMEOUTS) {
    it(`sync_timeout_ms: ${syncTimeoutMs}`, async () => {
      const p = await connectFake({ syncTimeoutMs });
      const t = asTopic('deadline');
      await p.post(t, WRITER, 'seed');
      const tail = (await p.fetchRecent({ topic: t, limit: 10 })).nextCursor;
      await p.subscribe(t, () => undefined);
      await p.fetchRecent({ topic: t, since: tail, blockMs: 120 });
      await p.disconnect();

      const syncs = syncCalls();
      // The loop's own long-poll really did ask for the configured timeout — without this the rows
      // below would grade positioning syncs (`timeout=0`) alone and could not tell the values apart.
      expect(syncs.some((s) => s.timeout === syncTimeoutMs)).toBe(true);
      for (const s of syncs) {
        expect(s.deadlineMs).toBeDefined();
        expect(s.deadlineMs).toBeGreaterThanOrEqual(s.timeout + DEFAULT_DEADLINE_MS);
      }
    }, 20_000);
  }

  it('a request that does not long-poll keeps the shared default budget', async () => {
    const p = await connectFake({});
    await p.post(asTopic('deadline'), WRITER, 'seed');
    await p.disconnect();

    const others = calls.filter((c) => !new URL(c.url).pathname.endsWith('/v3/sync'));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((c) => c.deadlineMs === undefined)).toBe(true);
  });
});

describe('the deadline a /sync asks for', () => {
  for (const timeoutMs of [0, ...SYNC_TIMEOUTS]) {
    it(`${timeoutMs}ms of long-poll leaves a full transport budget on top`, () => {
      expect(syncDeadlineMs(timeoutMs)).toBe(timeoutMs + DEFAULT_DEADLINE_MS);
    });
  }
});
