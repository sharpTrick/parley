import { asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisPlugin } from '../src/index.js';

// White-box tests for RedisPlugin.subscribe() hardening (work item 22 — BUG-11 + BUG-37). These
// mock the `redis` module so connect()/disconnect()/subscribe() run with NO live server; the live
// seam conformance (post → fetchRecent, catch-up, dedup, multi-writer) is covered separately in
// conformance.test.ts and requires a real Redis, and the live failure surface (unreachable
// endpoint, outage, retention, stale cursors) in failure-modes.test.ts.

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
  exists: ReturnType<typeof vi.fn>;
  xInfoStream: ReturnType<typeof vi.fn>;
  xRead: ReturnType<typeof vi.fn>;
}

// Shared, hoisted so the vi.mock factory (hoisted above imports) can close over it. The plugin
// builds its readers from the same createClient() factory as its command client (they must not be
// configured differently), so a queued fake is handed out ahead of a plain command client.
const hoisted = vi.hoisted(() => ({ readerQueue: [] as unknown[] }));

vi.mock('redis', () => ({
  createClient: () => {
    const queued = hoisted.readerQueue.shift();
    if (queued !== undefined) return queued;
    const main: Record<string, unknown> = {
      isOpen: false,
      on: () => main,
      connect: async () => {
        main.isOpen = true;
      },
      ping: async () => 'PONG',
      disconnect: async () => {
        main.isOpen = false;
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
    exists: vi.fn(async () => 1),
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
  // The CLASS: the "has this stream any history?" decision must rest on server STATE, never on the
  // wording of an error string. Every wording below is a real failure on an EXISTING stream, so
  // every one must propagate — including the ones that literally contain the old `no such key`
  // substring, and the ones a Valkey/ElastiCache/proxy/future release would word differently.
  const hardFailures = [
    'LOADING Redis is loading the dataset in memory',
    'READONLY You cannot write against a read only replica',
    'NOPERM this user has no permissions to run the xinfo command',
    'Socket closed unexpectedly',
    'ERR no such key', // text says "missing"; EXISTS says otherwise → must NOT seed '0'
    'ERR unknown command XINFO, with args beginning with: STREAM',
  ];

  it.each(hardFailures)(
    'surfaces an xInfoStream failure on an existing stream (%s) instead of seeding lastId=0',
    async (message) => {
      const plugin = new RedisPlugin();
      await plugin.connect({ url: 'redis://mock' });

      const handler = vi.fn();
      const reader = makeReader({
        exists: vi.fn(async () => 1),
        xInfoStream: vi.fn(async () => {
          throw new Error(message);
        }),
      });
      queue(reader);

      // The failure is surfaced (subscribe rejects) rather than silently starting from '0'.
      await expect(plugin.subscribe(asTopic('ops'), handler)).rejects.toThrow(message);
      // The read loop never started → zero historical entries flooded through the handler.
      expect(reader.xRead).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      // The reader was torn down and deregistered, not leaked.
      expect(reader.disconnect).toHaveBeenCalledTimes(1);
      expect(peek(plugin).readers).toHaveLength(0);

      await plugin.disconnect();
    },
  );

  // The inverse half of the class: a stream that genuinely does not exist must seed '0' no matter
  // HOW the server words its XINFO error (or whether XINFO is even reached), because EXISTS is
  // what decides.
  const missingStream: Array<[string, Partial<FakeReader>]> = [
    [
      'EXISTS says 0 (XINFO never reached)',
      {
        exists: vi.fn(async () => 0),
        xInfoStream: vi.fn(async () => {
          throw new Error('test: xInfoStream must not be called for a missing stream');
        }),
      },
    ],
    [
      'deleted in the EXISTS → XINFO gap, worded "ERR no such key"',
      {
        exists: vi
          .fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValue(0) as unknown as ReturnType<typeof vi.fn>,
        xInfoStream: vi.fn(async () => {
          throw new Error('ERR no such key');
        }),
      },
    ],
    [
      'deleted in the gap, worded "NOKEY stream does not exist"',
      {
        exists: vi
          .fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValue(0) as unknown as ReturnType<typeof vi.fn>,
        xInfoStream: vi.fn(async () => {
          throw new Error('NOKEY stream does not exist');
        }),
      },
    ],
  ];

  it.each(missingStream)(
    'seeds lastId=0 for a genuinely missing stream (%s) and delivers a later posted message',
    async (_label, overrides) => {
      const plugin = new RedisPlugin();
      await plugin.connect({ url: 'redis://mock' });

      const received: Message[] = [];
      let served = false;
      const reader = makeReader({
        ...overrides,
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
    },
  );

  it('starts at the stream tail (not 0) when the stream already has history', async () => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const handler = vi.fn();
    const reader = makeReader({
      exists: vi.fn(async () => 1),
      xInfoStream: vi.fn(async () => ({ lastGeneratedId: '55-3' })),
    });
    queue(reader);

    await plugin.subscribe(asTopic('ops'), handler);
    await vi.waitFor(() => expect(reader.xRead.mock.calls.length).toBeGreaterThan(0));
    expect((reader.xRead.mock.calls[0]?.[0] as { id: string }).id).toBe('55-3');
    expect(handler).not.toHaveBeenCalled();

    await plugin.disconnect();
  });
});

// CLASS: the subscribe read loop hides a non-recoverable backend fault. subscribe() has already
// resolved and core keeps advertising this instance as subscribed, so a loop that can never deliver
// again must not be indistinguishable from a quiet topic — while a fault that DOES heal must still
// be ridden out. The axis that matters is the reason, not the retry count.
describe('redis subscribe hardening — a dead live path must not look like a quiet topic', () => {
  const reasons: Array<[string, string, 'permanent' | 'transient']> = [
    ['a bad BLOCK argument', 'ERR timeout is not an integer or out of range', 'permanent'],
    ['an unauthenticated connection', 'NOAUTH Authentication required.', 'permanent'],
    ['an ACL revoked mid-session', 'NOPERM this user has no permissions to run the xread command', 'permanent'],
    ['a wrong password after failover', 'WRONGPASS invalid username-password pair', 'permanent'],
    ['the key repurposed', 'WRONGTYPE Operation against a key holding the wrong kind of value', 'permanent'],
    ['a closed client', 'ClientClosedError', 'transient'],
    ['a reset socket', 'read ECONNRESET', 'transient'],
    ['an unexpectedly closed socket', 'Socket closed unexpectedly', 'transient'],
    ['a server still loading its dataset', 'LOADING Redis is loading the dataset in memory', 'transient'],
    ['a failover redirect', 'MOVED 3999 127.0.0.1:6381', 'transient'],
  ];

  it.each(reasons)('%s (%s) is %s', async (_label, message, kind) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const received: Message[] = [];
    let failures = 0;
    let healed = false;
    const reader = makeReader({
      xRead: vi.fn((): Promise<XReadResult> => {
        // A transient reason heals after 3 rejections; a permanent one never does.
        if (kind === 'permanent' || failures < 3) {
          failures++;
          return Promise.reject(new Error(message));
        }
        if (healed) return new Promise((resolve) => setTimeout(() => resolve(null), 20));
        healed = true;
        return Promise.resolve([
          {
            name: 'parley:ops',
            messages: [{ id: '7-0', message: { sender: 'bob', content: 'healed', ts: '' } }],
          },
        ]);
      }),
    });
    queue(reader);

    try {
      await plugin.subscribe(asTopic('ops'), (m) => received.push(m));

      if (kind === 'transient') {
        await vi.waitFor(() => expect(received.map((m) => m.content)).toEqual(['healed']), {
          timeout: 3000,
        });
        expect(stderr).not.toHaveBeenCalled();
        return;
      }

      // Surfaced: one labelled stderr line naming the topic and the server's reason.
      await vi.waitFor(() => expect(stderr).toHaveBeenCalled(), { timeout: 3000 });
      const line = String(stderr.mock.calls[0]?.[0]);
      expect(line).toMatch(/^parley-redis:/);
      expect(line).toContain('ops');
      expect(line).toContain(message);

      // …and the loop STOPPED rather than retrying a fault no retry can clear.
      const frozen = reader.xRead.mock.calls.length;
      await sleep(400);
      expect(reader.xRead.mock.calls.length).toBe(frozen);
      expect(received).toHaveLength(0);
      // The dead reader was returned, not left registered and connected.
      expect(peek(plugin).readers).toHaveLength(0);
      expect(reader.disconnect).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      await plugin.disconnect();
    }
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
