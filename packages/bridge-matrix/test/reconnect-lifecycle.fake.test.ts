import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { connectFake, fakeConfig, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: no background loop may outlive the `disconnect()` that stopped it — including across a
 * subsequent `connect()`. A loop that only watches a shared stopped flag is resurrected the moment
 * that flag clears, and then runs against a stale token, room and handler, invisible to every map
 * `disconnect()` cleared. Parameterized over WHERE the loop was parked when the disconnect landed,
 * because each parking spot re-reads the flag at a different point.
 */

const WRITER = asHandle('writer');
const TOPIC = asTopic('lifecycle');
/** Longer than the retry backoff the loop is parked in, so a resurrected loop has time to show. */
const OBSERVE_MS = 3000;

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Park the subscribe loop the way this case wants, then hand back the plugin. */
const PARKED_IN = {
  'an in-flight /sync': async (p: MatrixPlugin) => {
    await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(3), {
      timeout: 4000,
      interval: 5,
    });
  },
  'the retry backoff after a failed /sync': async () => {
    fake.syncFailures = Number.POSITIVE_INFINITY;
    await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(4), {
      timeout: 8000,
      interval: 5,
    });
  },
} as const;

describe('a subscribe loop does not survive disconnect + connect', () => {
  for (const [name, park] of Object.entries(PARKED_IN)) {
    it(`parked in ${name}: the pre-disconnect handler goes quiet and issues no more requests`, async () => {
      const p = await connectFake({});
      const got: string[] = [];
      await p.subscribe(TOPIC, (m) => got.push(m.content));
      await park(p);

      await p.disconnect();
      await settle(50); // let a request already on the wire at the disconnect be recorded.
      const attemptsAtDisconnect = fake.syncAttempts.length;
      await p.connect(fakeConfig());
      fake.syncFailures = 0;
      fake.addMessage(String(TOPIC), 'after-reconnect');

      await settle(OBSERVE_MS);

      expect(got).toEqual([]);
      expect(fake.syncAttempts.length).toBe(attemptsAtDisconnect);
      await p.disconnect();
    }, 30_000);
  }
});

describe('a dedicated bounded /sync does not survive disconnect + connect', () => {
  it('the blocking fetch returns at the disconnect and issues no more requests', async () => {
    const p = await connectFake({});
    await p.post(TOPIC, WRITER, 'seed');
    const tail = (await p.fetchRecent({ topic: TOPIC, limit: 10 })).nextCursor;

    const pending = p.fetchRecent({ topic: TOPIC, since: tail, blockMs: 30_000 });
    await settle(100);
    await p.disconnect();
    expect((await pending).messages).toEqual([]);

    const attemptsAtDisconnect = fake.syncAttempts.length;
    await p.connect(fakeConfig());
    fake.addMessage(String(TOPIC), 'after-reconnect');
    await settle(OBSERVE_MS);

    expect(fake.syncAttempts.length).toBe(attemptsAtDisconnect);
    await p.disconnect();
  }, 30_000);
});
