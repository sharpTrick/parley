import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { attachConnection, fakeJetStream, injectFake, payload } from './fake-jetstream.js';

// White-box handle onto the plugin's private stream-cache state.
type Internals = { js: unknown; jsm: unknown; ensured: Map<string, Promise<void>> };
const peek = (p: NatsPlugin): Internals => p as unknown as Internals;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Mock only `connect` so connect() needs no live server; every other nats export stays real
// (the plugin under test uses AckPolicy / DeliverPolicy / ConsumerEvents).
vi.mock('nats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nats')>();
  return {
    ...actual,
    connect: vi.fn(async () => ({
      jetstream: () => ({}),
      jetstreamManager: async () => ({}),
      drain: async () => undefined,
      close: async () => undefined,
      isClosed: () => false,
    })),
  };
});

const ORPHAN = asTopic('orphan');

describe('nats recovery — ensureStream must not cache a rejected promise', () => {
  it('evicts the cache entry on a transient failure and retries streams.add on the next call', async () => {
    const plugin = new NatsPlugin();
    let addCalls = 0;
    peek(plugin).jsm = {
      streams: {
        add: async () => {
          addCalls += 1;
          if (addCalls === 1) throw new Error('TIMEOUT'); // transient blip, not an already-exists race
          return { config: { name: 'ok' } };
        },
      },
    };
    peek(plugin).js = { publish: async () => ({ seq: 7 }) };

    const topic = asTopic('deploys');

    // First touch of the topic coincides with the blip → the post rejects with the transient error.
    await expect(plugin.post(topic, asHandle('a'), 'one')).rejects.toThrow('TIMEOUT');
    // The rejected promise must be evicted, not left to poison every later call for this topic.
    expect(peek(plugin).ensured.size).toBe(0);

    // The very next post retries streams.add (the fix) and now succeeds — with the old code it would
    // re-await the stale rejection and fail forever.
    await expect(plugin.post(topic, asHandle('a'), 'two')).resolves.toBeDefined();
    expect(addCalls).toBe(2);
    expect(peek(plugin).ensured.size).toBe(1); // a successful create is still memoized
  });

  it('clears the stream-cache on connect() so a disconnect()/connect() cycle starts clean', async () => {
    const plugin = new NatsPlugin();
    peek(plugin).ensured.set('PARLEY_stale', Promise.resolve());
    expect(peek(plugin).ensured.size).toBe(1);

    await plugin.connect({ servers: 'mock' });
    expect(peek(plugin).ensured.size).toBe(0);

    await plugin.disconnect();
  });
});

// Class: a background loop must be stoppable wherever its cycle is parked, and a stopped loop must
// stay stopped. `disconnect()` cannot rely on a flag the next `connect()` clears: a loop parked in
// its resubscribe backoff — where an outage keeps it nearly all the time — wakes after that clear,
// finds live handles, and delivers to a handler its owner already dropped, with no closer registered
// for anyone to stop it. The pause is swept across the cycle instead of picking one lucky offset.

describe('nats recovery — a loop retired by disconnect() does not resurrect on the next connect()', () => {
  for (const pauseMs of [0, 400, 800, 1200]) {
    it(`stays dead when disconnect() lands ${pauseMs}ms into the loop's cycle`, async () => {
      const fake = fakeJetStream({ records: [], silentExits: 5 });
      const plugin = new NatsPlugin();
      await plugin.connect({ servers: 'mock' });
      injectFake(plugin, fake, ORPHAN);
      attachConnection(plugin);

      const got: string[] = [];
      await plugin.subscribe(ORPHAN, (m) => {
        got.push(m.content);
      });
      await sleep(pauseMs);
      await plugin.disconnect();

      await plugin.connect({ servers: 'mock' });
      injectFake(plugin, fake, ORPHAN);
      attachConnection(plugin);
      const created = fake.state.created.length;
      fake.state.records.push({ seq: 1, data: payload('after-reconnect') });
      await sleep(1600);

      expect(got).toEqual([]);
      expect(fake.state.created.length).toBe(created);

      await plugin.disconnect();
    }, 20_000);
  }
});
