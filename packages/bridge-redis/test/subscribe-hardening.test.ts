import { asTopic, type Cursor, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisPlugin } from '../src/index.js';

// White-box tests for RedisPlugin.subscribe() hardening. These
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
      exists: async () => 1,
      xInfoStream: async () => ({ lastGeneratedId: '999999999999-0' }),
      xRange: async () => [],
      xRevRange: async () => [],
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

describe('redis subscribe hardening — xInfoStream catch must not replay history', () => {
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

// CLASS: the same backend fault is diagnosed on one delivery path and swallowed on another. Both
// `subscribe` and a blocking `fetchRecent` issue XREAD on a reader of their own, so both meet the
// same refusals — but a caller of either has already been told the call succeeded, so a fault no
// retry can clear must reach the operator on BOTH, while one that heals must be ridden out on both.
// The axes that matter are the path and the reason, never the retry count.
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

describe('redis hardening — a refusal is diagnosed on every XREAD path', () => {
  const paths = ['subscribe', 'blocking fetchRecent'] as const;

  const rows = paths.flatMap((path) =>
    reasons.map(
      ([reason, message, kind]) =>
        [`${path}: ${reason} (${message}) is ${kind}`, path, message, kind] as [
          string,
          (typeof paths)[number],
          string,
          'permanent' | 'transient',
        ],
    ),
  );

  it.each(rows)('%s', async (_label, path, message, kind) => {
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
      let failure: Error | undefined;
      if (path === 'subscribe') {
        await plugin.subscribe(asTopic('ops'), (m) => received.push(m));
        if (kind === 'transient') {
          // The loop rides it out and delivers, so waiting for the delivery IS the settle point.
          await vi.waitFor(() => expect(received.map((m) => m.content)).toEqual(['healed']), {
            timeout: 3000,
          });
        } else {
          await vi.waitFor(() => expect(stderr).toHaveBeenCalled(), { timeout: 3000 });
        }
      } else {
        const page = await plugin
          .fetchRecent({ topic: asTopic('ops'), since: '1-0' as unknown as Cursor, blockMs: 200 })
          .catch((err: Error) => {
            failure = err;
            return undefined;
          });
        // A long poll has no retry loop of its own — core polls the remaining budget — so a
        // transient fault is answered by the empty page the caller can always be handed.
        if (kind === 'transient') {
          expect(page?.messages).toEqual([]);
          expect(page?.nextCursor).toBe('1-0');
        }
      }

      // The class invariant, identical on both paths: a fault no retry can clear reaches the
      // operator — as a rejected seam call or as a stderr line — and one that heals reaches nobody.
      const diagnosed = failure !== undefined || stderr.mock.calls.length > 0;
      expect(
        diagnosed,
        kind === 'permanent'
          ? `${path} swallowed a permanent refusal: no error, no stderr, nothing to fix`
          : `${path} reported a fault that heals on its own`,
      ).toBe(kind === 'permanent');

      if (kind === 'transient') return;

      if (failure !== undefined) {
        expect(failure.message).toMatch(/^parley-redis:/);
        expect(failure.message, 'the operator cannot tell WHICH topic failed').toContain('ops');
        expect(failure.message, 'the operator cannot tell which Redis key failed').toContain(
          'parley:ops',
        );
        expect(failure.message).toContain(message);
      } else {
        const line = String(stderr.mock.calls[0]?.[0]);
        expect(line).toMatch(/^parley-redis:/);
        expect(line).toContain('ops');
        expect(line).toContain(message);
      }

      // …and the path STOPPED rather than retrying a fault no retry can clear.
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

// CLASS: a permanent/transient axis with no DURATION to it. "Transient" is a judgement about
// whether a retry could clear the fault, not an observation that one did — a `MOVED` this
// non-cluster client can never follow, or a replica stuck `LOADING`, is classified transient and
// retried forever. Every row above heals within three reads, so none of them can reach the state
// that matters: `subscribe()` resolved, core still advertises the topic as subscribed, live
// delivery has been dead since startup, and nothing was ever written anywhere.
//
// Driven off the same reason list, so a code added to the classifier is graded on both axes.
// On fake timers, because the loop's own backoff is what makes a sustained fault take seconds of
// wall clock to reach.
describe('redis hardening — a transient fault that never clears is still reported', () => {
  const transient = reasons.filter(([, , kind]) => kind === 'transient');

  /** After how many failed reads the fake starts answering; `never` = the fault never clears. */
  const durations: Array<[string, number | 'never']> = [
    ['never clears', 'never'],
    ['clears long after the loop went quiet', 7],
  ];

  const rows = transient.flatMap(([reason, message]) =>
    durations.map(
      ([duration, healAfter]) =>
        [`${reason} (${message}) that ${duration}`, message, healAfter] as [
          string,
          string,
          number | 'never',
        ],
    ),
  );

  const linesMatching = (stderr: { mock: { calls: unknown[][] } }, re: RegExp): string[] =>
    stderr.mock.calls.map((c) => String(c[0])).filter((line) => re.test(line));

  it.each(rows)('%s', async (_label, message, healAfter) => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const delivered: string[] = [];
    let failures = 0;
    let served = false;
    const reader = makeReader({
      xRead: vi.fn((): Promise<XReadResult> => {
        if (healAfter === 'never' || failures < healAfter) {
          failures++;
          return Promise.reject(new Error(message));
        }
        if (served) return new Promise((resolve) => setTimeout(() => resolve(null), 20));
        served = true;
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
      await plugin.subscribe(asTopic('ops'), (m) => delivered.push(m.content));
      await vi.advanceTimersByTimeAsync(30_000);

      const degraded = linesMatching(stderr, /DEGRADED/);
      expect(
        degraded,
        'a fault classified transient failed every read and was never reported at all, so the ' +
          'topic is indistinguishable from a quiet one',
      ).toHaveLength(1);
      expect(degraded[0]).toMatch(/^parley-redis:/);
      expect(degraded[0], 'the operator cannot tell WHICH topic stopped delivering').toContain(
        'ops',
      );
      expect(degraded[0], 'the line names no cause to act on').toContain(message);
      expect(
        linesMatching(stderr, /STOPPED/),
        'a fault a retry can clear was reported as terminal',
      ).toEqual([]);

      if (healAfter === 'never') {
        const reads = reader.xRead.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(
          reader.xRead.mock.calls.length,
          'the loop gave up instead of riding the fault out',
        ).toBeGreaterThan(reads);
        expect(
          linesMatching(stderr, /DEGRADED/),
          'one sustained fault floods stderr with a line per failed read',
        ).toHaveLength(1);
        expect(delivered).toEqual([]);
      } else {
        expect(delivered, 'the loop never recovered once the fault cleared').toEqual(['healed']);
        const resumed = linesMatching(stderr, /RESUMED/);
        expect(resumed, 'the recovery from a reported outage was never reported').toHaveLength(1);
        expect(resumed[0]).toContain('ops');
      }
    } finally {
      stderr.mockRestore();
      await plugin.disconnect();
      vi.useRealTimers();
    }
  });
});

// CLASS: a blocking read armed at the TAIL SIGIL instead of the caller's cursor. '$' only resolves
// to "the last id" when the read registers server-side, so every entry written between the catch-up
// query and that moment is lost — a defect no wall-clock behavioural test can pin down reliably,
// because the gap is a connection handshake wide. Pin the START ID directly instead.
describe('redis long-poll — the blocking read starts at the caller cursor, never the tail', () => {
  const cursors = ['500-0', '1-0', '123', '999999998-4'];

  it.each(cursors)('XREADs from %s', async (since) => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });
    const reader = makeReader({ xRead: vi.fn(async (): Promise<XReadResult> => null) });
    queue(reader);

    const page = await plugin.fetchRecent({
      topic: asTopic('ops'),
      since: since as unknown as Cursor,
      blockMs: 50,
    });

    expect(reader.xRead).toHaveBeenCalledTimes(1);
    const [streams, opts] = reader.xRead.mock.calls[0] as [
      { key: string; id: string },
      { BLOCK: number },
    ];
    expect(streams.id, "'$' loses every entry written during the reader's handshake").toBe(since);
    expect(streams.key).toBe('parley:ops');
    expect(opts.BLOCK).toBe(50);
    expect(page.messages).toEqual([]);
    expect(page.nextCursor).toBe(since);

    await plugin.disconnect();
  });
});

// CLASS: a supersession gate that exists on every lifecycle path but is graded on only one. Every
// reader-opening path captures the connect generation and re-checks it at each continuation, but the
// checks were asserted for `subscribe` alone — both of the long poll's could be deleted with the
// whole suite green. A reader that outlives the `disconnect()` which superseded it holds a socket
// for the rest of the granted budget and can hand back messages written after teardown, which the
// conformance clause "disconnect stops the plugin serving" forbids.
//
// Two axes: the PATH that opened the reader, and WHERE `disconnect()` wins the race — inside the
// handshake (which `tearDown` deliberately leaves alone, so only the gate can close it) or parked in
// the read (where the entries are already in flight). Held on deferreds rather than timing, so the
// window is exact instead of likely.
describe('redis hardening — a superseded reader serves nobody, on every path', () => {
  function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  }

  const paths = ['subscribe', 'blocking fetchRecent'] as const;
  const races = ['the reader handshake', 'the blocking read'] as const;

  const cells = paths.flatMap((path) =>
    races.map(
      (race) =>
        [`${path}: disconnect() during ${race}`, path, race] as [
          string,
          (typeof paths)[number],
          (typeof races)[number],
        ],
    ),
  );

  it.each(cells)('%s', async (_label, path, race) => {
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock' });

    const late: XReadResult = [
      {
        name: 'parley:ops',
        messages: [{ id: '9-0', message: { sender: 'bob', content: 'late', ts: '' } }],
      },
    ];
    const handshake = deferred<void>();
    const parked = deferred<XReadResult>();
    const reader = makeReader({
      connect: vi.fn(async () => {
        if (race === 'the reader handshake') await handshake.promise;
        reader.isOpen = true;
      }),
      xRead: vi.fn(
        (): Promise<XReadResult> =>
          race === 'the blocking read' ? parked.promise : Promise.resolve(late),
      ),
    });
    queue(reader);

    const delivered: string[] = [];
    const run =
      path === 'subscribe'
        ? plugin.subscribe(asTopic('ops'), (m) => delivered.push(m.content))
        : plugin
            .fetchRecent({
              topic: asTopic('ops'),
              since: '1-0' as unknown as Cursor,
              blockMs: 2000,
            })
            .then((page) => {
              delivered.push(...page.messages.map((m) => m.content));
            });

    if (race === 'the reader handshake') {
      // Registered while its connect() is still held: every reader-opening path registers BEFORE
      // connecting, so `disconnect()` can always find one whose handshake it must not interrupt.
      await vi.waitFor(() => expect(peek(plugin).readers).toContain(reader), { timeout: 3000 });
    } else {
      await vi.waitFor(() => expect(reader.xRead).toHaveBeenCalled(), { timeout: 3000 });
    }

    await plugin.disconnect();
    handshake.settle();
    parked.settle(late);
    await run;
    await sleep(100); // a straggling loop would deliver here

    expect(
      delivered,
      'a superseded reader handed back a message that landed after disconnect()',
    ).toEqual([]);
    expect(peek(plugin).readers, 'the superseded reader is still registered').toHaveLength(0);
    expect(reader.disconnect, 'the superseded reader was never closed').toHaveBeenCalled();
    expect(reader.isOpen, 'the superseded reader still holds its socket').toBe(false);
    if (race === 'the reader handshake') {
      expect(
        reader.xRead,
        'XREAD BLOCK was issued on a connection disconnect() had already superseded, so the ' +
          'socket lives for the whole granted budget past teardown',
      ).not.toHaveBeenCalled();
    }
  });
});

describe('redis subscribe hardening — reader lifecycle + generation gating', () => {
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

// CLASS: a background loop a lifecycle call tore down still issues work, or still holds a timer.
// The generation gate is the only thing that ends the read loop, and NOTHING graded that it does:
// both of its checks on the failure path can be deleted with the whole suite green. The mutant is
// not benign — after `disconnect()` the reader socket is destroyed, `xRead` rejects with a
// `ClientClosedError` that is (correctly) classified transient, and the loop then retries a doomed
// read on the 100ms→2s ladder for the life of the process, holding the event loop open at shutdown.
//
// Two axes: HOW the loop was left when the lifecycle call landed — each leaves it at a different
// continuation, and the checks are per-continuation — and WHICH lifecycle call did it, since
// `connect()` re-baselines the generation through the same `tearDown` that `disconnect()` uses.
// Both halves are graded: no further reads, and no timer left armed. The existing 'superseded
// reader' and 'does not revive a prior loop' cases grade only DELIVERY, which a loop spinning
// forever against a dead socket never produces.
describe('redis subscribe hardening — a torn-down read loop issues no further work', () => {
  const entry = (id: string): XReadResult => [
    { name: 'parley:ops', messages: [{ id, message: { sender: 'bob', content: 'live', ts: '' } }] },
  ];

  /** How the loop is left when the lifecycle call lands — one per continuation the gate guards. */
  const leftAs: Array<[string, () => FakeReader['xRead']]> = [
    [
      'a read that keeps succeeding',
      () => {
        let seq = 0;
        return vi.fn(
          (): Promise<XReadResult> =>
            new Promise((resolve) => setTimeout(() => resolve(entry(`${++seq}-0`)), 20)),
        );
      },
    ],
    ['a read that keeps timing out', () => makeReader().xRead],
    [
      'a read that keeps failing transiently',
      () =>
        vi.fn(
          (): Promise<XReadResult> =>
            new Promise((_r, reject) =>
              setTimeout(() => reject(new Error('ClientClosedError')), 20),
            ),
        ),
    ],
    [
      'a read that failed permanently',
      () =>
        vi.fn(
          (): Promise<XReadResult> =>
            Promise.reject(new Error('NOPERM this user has no permissions to run the xread command')),
        ),
    ],
  ];

  const lifecycles: Array<[string, (p: RedisPlugin) => Promise<void>]> = [
    ['disconnect()', (p) => p.disconnect()],
    ['connect() re-baselining the generation', (p) => p.connect({ url: 'redis://mock' })],
  ];

  const rows = leftAs.flatMap(([leftLabel, mint]) =>
    lifecycles.map(
      ([lifecycleLabel, run]) =>
        [`${lifecycleLabel} after ${leftLabel}`, mint, run] as [
          string,
          () => FakeReader['xRead'],
          (p: RedisPlugin) => Promise<void>,
        ],
    ),
  );

  it.each(rows)('%s', async (_label, mint, lifecycle) => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plugin = new RedisPlugin();
    await plugin.connect({ url: 'redis://mock', block_ms: 50 });
    const reader = makeReader({ xRead: mint() });
    queue(reader);

    try {
      await plugin.subscribe(asTopic('ops'), () => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        reader.xRead.mock.calls.length,
        'the loop never issued a read, so this row grades nothing',
      ).toBeGreaterThan(0);

      await lifecycle(plugin);
      await vi.advanceTimersByTimeAsync(100); // let the in-flight iteration settle
      const frozen = reader.xRead.mock.calls.length;

      // Many times `block_ms`, and past the whole 100ms→2s retry ladder several times over — long
      // enough that a loop merely sleeping out its backoff has woken, re-checked and exited.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        reader.xRead.mock.calls.length,
        'the torn-down loop kept issuing reads on a reader nothing can ever close',
      ).toBe(frozen);
      expect(
        vi.getTimerCount(),
        'the torn-down loop still holds a timer, so it keeps the event loop open at shutdown',
      ).toBe(0);
    } finally {
      stderr.mockRestore();
      await plugin.disconnect();
      vi.useRealTimers();
    }
  });
});
