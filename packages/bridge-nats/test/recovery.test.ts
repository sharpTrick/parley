import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { NatsPlugin } from '../src/index.js';

// White-box handle onto the plugin's private stream-cache state (BUG-01 is about that cache).
type Internals = { js: unknown; jsm: unknown; ensured: Map<string, Promise<void>> };
const peek = (p: NatsPlugin): Internals => p as unknown as Internals;

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
    })),
  };
});

describe('nats recovery — BUG-01: ensureStream must not cache a rejected promise', () => {
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
