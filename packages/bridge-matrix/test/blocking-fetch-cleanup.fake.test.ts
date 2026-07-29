import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: an error thrown anywhere inside a blocking primitive must leave nothing behind — no armed
 * timer, no registered waiter, no in-flight `/sync`. A flapping homeserver otherwise accumulates one
 * orphaned wait per failed call, each holding the event loop for the full `catchup.block_max_ms`
 * (60s by default in production).
 */

const WRITER = asHandle('writer');

interface Internals {
  waiters: Map<string, Set<unknown>>;
  controllers: Set<AbortController>;
}
const internals = (p: MatrixPlugin): Internals => p as unknown as Internals;

/** WHICH `/messages` read inside the blocking fetch is faulted, and how that phase is reached. */
const INJECTION_POINTS = {
  'the pre-park recheck': {
    // The dedicated bounded `/sync` is armed immediately before the recheck runs.
    arm: (fake: FakeSynapse, fault: () => void) => {
      fake.onRequest = (_m, path) => {
        if (path.endsWith('/v3/sync')) fault();
      };
    },
    wakesWithAPost: false,
  },
  'the post-park re-query': {
    arm: () => undefined,
    wakesWithAPost: true,
  },
} as const;

const FAILURE_MODES = {
  'HTTP 500': { mode: 'status', status: 500 },
  'network reject': { mode: 'network', status: 0 },
} as const;

let fake: FakeSynapse;
const timers: ReturnType<typeof setTimeout>[] = [];
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  // Keep this drain, so that a timer armed by one case cannot post into the next case's fake.
  for (const t of timers.splice(0)) clearTimeout(t);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a failed read inside a blocking fetchRecent leaves nothing parked', () => {
  for (const [pointName, point] of Object.entries(INJECTION_POINTS)) {
    for (const [modeName, mode] of Object.entries(FAILURE_MODES)) {
      it(`${pointName} / ${modeName}: rejects and drains its waiter, timer and sync`, async () => {
        const p = await connectFake({});
        const t = asTopic('flaky');
        await p.post(t, WRITER, 'seed');
        const tail = (await p.fetchRecent({ topic: t, limit: 10 })).nextCursor;

        const fault = (): void => {
          fake.onRequest = () => undefined;
          fake.messagesFailureMode = mode.mode;
          fake.messagesFailureStatus = mode.status;
          fake.messagesFailures = Number.POSITIVE_INFINITY;
        };
        point.arm(fake, fault);
        if (point.wakesWithAPost) {
          timers.push(
            setTimeout(() => {
              fault();
              void p.post(t, WRITER, 'fresh');
            }, 150),
          );
        }

        const started = Date.now();
        await expect(p.fetchRecent({ topic: t, since: tail, blockMs: 5000 })).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(3000);

        expect([...internals(p).waiters.values()].flatMap((s) => [...s])).toEqual([]);
        expect([...internals(p).controllers]).toEqual([]);
        await p.disconnect();
      }, 20_000);
    }
  }
});
