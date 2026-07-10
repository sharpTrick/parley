import { asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisPlugin } from '../src/index.js';

// White-box tests for RedisPlugin.subscribe() hardening (work item 22 — BUG-11 + BUG-37). These
// mock the `redis` module so connect()/disconnect()/subscribe() run with NO live server; the live
// seam conformance (post → fetchRecent, catch-up, dedup, multi-writer) is covered separately in
// conformance.test.ts and requires a real Redis.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type XReadResult = Array<{
  name: string;
  messages: Array<{ id: string; message: Record<string, string> }>;
}> | null;

interface FakeReader {
  isOpen: boolean;
  on: (...a: unknown[]) => FakeReader;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  xInfoStream: ReturnType<typeof vi.fn>;
  xRead: ReturnType<typeof vi.fn>;
}

// Shared, hoisted so the vi.mock factory (hoisted above imports) can close over it. duplicate()
// hands out one queued reader per subscribe under test.
const hoisted = vi.hoisted(() => ({ readerQueue: [] as unknown[] }));

vi.mock('redis', () => ({
  createClient: () => {
    const main: Record<string, unknown> = {
      isOpen: false,
      on: () => main,
      connect: async () => {
        main.isOpen = true;
      },
      disconnect: async () => {
        main.isOpen = false;
      },
      duplicate: () => {
        const r = hoisted.readerQueue.shift();
        if (r === undefined) throw new Error('test setup: no reader queued for duplicate()');
        return r;
      },
    };
    return main;
  },
}));

// A reader whose default XREAD BLOCKs (resolves null on a macrotask) so the read loop can never
// starve the timer queue with a tight microtask chain. Override per test.
function makeReader(overrides: Partial<FakeReader> = {}): FakeReader {
  const reader: FakeReader = {
    isOpen: false,
    on: () => reader,
    connect: vi.fn(async () => {
      reader.isOpen = true;
    }),
    disconnect: vi.fn(async () => {
      reader.isOpen = false;
    }),
    xInfoStream: vi.fn(async () => ({ lastGeneratedId: '0-0' })),
    xRead: vi.fn(
      (): Promise<XReadResult> => new Promise((resolve) => setTimeout(() => resolve(null), 20)),
    ),
    ...overrides,
  };
  return reader;
}

interface Internals {
  generation: number;
  readers: unknown[];
}
const peek = (p: RedisPlugin): Internals => p as unknown as Internals;

const queue = (r: FakeReader): void => {
  hoisted.readerQueue.push(r);
};

afterEach(() => {
  hoisted.readerQueue.length = 0;
});

describe('redis subscribe hardening — BUG-11: xInfoStream catch must not replay history', () => {
  it('surfaces a transient (non missing-key) xInfoStream error instead of seeding lastId=0', async () => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const handler = vi.fn();
    const reader = makeReader({
      // The realistic correlated case: subscribe() runs while Redis is restarting.
      xInfoStream: vi.fn(async () => {
        throw new Error('LOADING Redis is loading the dataset in memory');
      }),
    });
    queue(reader);

    // The failure is surfaced (subscribe rejects) rather than silently starting from '0'.
    await expect(plugin.subscribe(asTopic('ops'), handler)).rejects.toThrow(/LOADING/);
    // The read loop never started → zero historical entries flooded through the handler.
    expect(reader.xRead).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    // The reader was torn down and deregistered, not leaked.
    expect(reader.disconnect).toHaveBeenCalledTimes(1);
    expect(peek(plugin).readers).toHaveLength(0);

    await plugin.disconnect();
  });

  it('still seeds lastId=0 for a genuinely missing stream and delivers a later posted message', async () => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const received: Message[] = [];
    let served = false;
    const reader = makeReader({
      // node-redis surfaces `ERR no such key` for XINFO STREAM on a non-existent stream.
      xInfoStream: vi.fn(async () => {
        throw new Error('ERR no such key');
      }),
      xRead: vi.fn((): Promise<XReadResult> => {
        if (served) return new Promise((resolve) => setTimeout(() => resolve(null), 20));
        served = true;
        return Promise.resolve([
          {
            name: 'parley:new',
            messages: [{ id: '1-0', message: { sender: 'alice', content: 'hello', ts: '' } }],
          },
        ]);
      }),
    });
    queue(reader);

    await plugin.subscribe(asTopic('new'), (m) => received.push(m));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]?.content).toBe('hello');
    // First XREAD used the seeded start id '0' — no regression to first-subscribe-before-first-post.
    const firstArgs = reader.xRead.mock.calls[0]?.[0] as { id: string };
    expect(firstArgs.id).toBe('0');

    await plugin.disconnect();
  });
});

describe('redis subscribe hardening — BUG-37: reader lifecycle + generation gating', () => {
  it('registers the reader before connect() so a racing disconnect() tears it down (no leak)', async () => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    let releaseConnect!: () => void;
    const reader = makeReader({
      // Hold connect() open so disconnect() can win the race while it is in flight.
      connect: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = () => {
              reader.isOpen = true;
              resolve();
            };
          }),
      ),
    });
    queue(reader);

    const subP = plugin.subscribe(asTopic('ops'), vi.fn());
    // subscribe() runs synchronously up to `await reader.connect()`, so the reader is already
    // registered — the whole point of register-before-connect.
    expect(peek(plugin).readers).toContain(reader);

    // disconnect() wins the race while connect() is still pending.
    await plugin.disconnect();

    // Now let the straggling connect() resolve; subscribe() must NOT leak the connected reader.
    releaseConnect();
    await subP;

    expect(peek(plugin).readers).toHaveLength(0);
    expect(reader.isOpen).toBe(false); // torn down, not a leaked connected duplicate keeping the loop alive
    expect(reader.disconnect).toHaveBeenCalled();
  });

  it('does not revive a prior loop after disconnect()/connect() and does not cross-deliver', async () => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const firstHandler = vi.fn();
    const reader1 = makeReader({
      // Straggler reader: XREAD rejects instantly (as a closed reader would with ClientClosedError).
      xRead: vi.fn(async (): Promise<XReadResult> => {
        throw new Error('ClientClosedError');
      }),
    });
    queue(reader1);
    await plugin.subscribe(asTopic('ops'), firstHandler);

    // Let the loop iterate a few times (reject → delay(100) → retry).
    await sleep(250);
    expect(reader1.xRead.mock.calls.length).toBeGreaterThan(0);

    // disconnect() bumps the generation → reader1's loop must exit deterministically.
    await plugin.disconnect();
    await sleep(50); // allow any final in-flight iteration to settle
    const frozen = reader1.xRead.mock.calls.length;

    // Reconnect + a fresh subscription. The old shared-boolean bug would let reader1's loop resume
    // here (connect() reset stopped=false); the generation token must keep it dead.
    await plugin.connect({ url: 'redis://mock' });
    const secondHandler = vi.fn();
    let served = false;
    const reader2 = makeReader({
      xRead: vi.fn((): Promise<XReadResult> => {
        if (served) return new Promise((resolve) => setTimeout(() => resolve(null), 20));
        served = true;
        return Promise.resolve([
          {
            name: 'parley:ops',
            messages: [{ id: '9-0', message: { sender: 'bob', content: 'live', ts: '' } }],
          },
        ]);
      }),
    });
    queue(reader2);
    await plugin.subscribe(asTopic('ops'), secondHandler);

    // The new subscription is live…
    await vi.waitFor(() => expect(secondHandler).toHaveBeenCalledTimes(1));
    expect((secondHandler.mock.calls[0]?.[0] as Message).content).toBe('live');

    // …and after ample time for a revived spin loop, reader1's XREAD count never grew (dead, not
    // spinning) and its handler got nothing (no cross-delivery / no duplicate deliveries).
    await sleep(300);
    expect(reader1.xRead.mock.calls.length).toBe(frozen);
    expect(firstHandler).not.toHaveBeenCalled();

    await plugin.disconnect();
  });
});
