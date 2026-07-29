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

/**
 * CLASS: no registry entry may outlive the work it describes. `liveTopics` is a claim that a running
 * `/sync` loop covers a (room, topic) pair; a blocking `fetchRecent` trusts it and declines to open
 * its own dedicated `/sync`. A phantom entry therefore costs a landed message a full slice of
 * `sync_timeout_ms` of silence — and in production `catchup.block_max_ms` is 60s.
 */
const REGISTRIES = ['liveTopics', 'waiters', 'controllers', 'rooms'] as const;

const sizeOf = (p: MatrixPlugin, name: (typeof REGISTRIES)[number]): number =>
  (p as unknown as Record<string, { size: number }>)[name]!.size;

const LIFECYCLES: Record<string, (p: MatrixPlugin) => Promise<void>> = {
  'subscribe → disconnect → connect': async (p) => {
    await p.subscribe(TOPIC, () => undefined);
    await p.disconnect();
    await p.connect(fakeConfig());
  },
  'subscribe → connect (a reconnect with no disconnect)': async (p) => {
    await p.subscribe(TOPIC, () => undefined);
    await p.connect(fakeConfig());
  },
  'a disconnect racing an in-flight subscribe': async (p) => {
    const subscribing = p.subscribe(TOPIC, () => undefined);
    await p.disconnect();
    await subscribing;
  },
};

describe('every internal registry is empty after a lifecycle that stood the loop down', () => {
  for (const [name, sequence] of Object.entries(LIFECYCLES)) {
    it(`${name}: no registry outlives it`, async () => {
      const p = await connectFake({});
      await sequence(p);

      // A `/sync` already on the wire when the sequence ended drains within one fake round-trip; a
      // registry the plugin never cleared never empties, so the timeout is the real assertion.
      await vi.waitFor(
        () => expect(REGISTRIES.map((r) => [r, sizeOf(p, r)])).toEqual(REGISTRIES.map((r) => [r, 0])),
        { timeout: 4000, interval: 10 },
      );
      await p.disconnect();
    }, 30_000);
  }

  it('a blocking fetchRecent afterwards still wakes far inside its budget', async () => {
    const p = await connectFake({ syncTimeoutMs: 8000 });
    await p.subscribe(TOPIC, () => undefined);
    await p.connect(fakeConfig({ syncTimeoutMs: 8000 }));
    await p.post(TOPIC, WRITER, 'seed');
    const tail = (await p.fetchRecent({ topic: TOPIC, limit: 10 })).nextCursor;

    const started = Date.now();
    const pending = p.fetchRecent({ topic: TOPIC, since: tail, blockMs: 3000 });
    const lands = setTimeout(() => void p.post(TOPIC, WRITER, 'fresh'), 150);
    const woke = await pending;
    clearTimeout(lands);

    expect(woke.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(Date.now() - started).toBeLessThan(1500);
    await p.disconnect();
  }, 30_000);
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
