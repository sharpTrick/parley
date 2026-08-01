import net from 'node:net';
import { asCursor, asHandle, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { MAX_BLOCKING_READERS, RedisPlugin } from '../src/index.js';
import {
  FAST_MS as FAST,
  freshPrefix,
  freshTopic as mintTopic,
  isRedisUp,
  REDIS_URL,
  wipe,
  withPlugin,
} from './support.js';

const freshTopic = (): Topic => mintTopic('live-conn');

const redisUp = await isRedisUp(REDIS_URL);

interface Proxy {
  url: string;
  /** Live client sockets currently proxied — the externally observable resource count. */
  live: () => number;
  /** Every client socket ever accepted — how many connections the plugin has OPENED. */
  accepted: () => number;
  /** Stop forwarding: from here on, accept TCP and never speak a word of RESP. */
  stallNewConnections: () => void;
  /** Drop the endpoint the way a crashed server does: stop listening, destroy every socket. */
  kill: () => void;
  revive: () => Promise<void>;
  close: () => void;
}

/**
 * A TCP pass-through in front of the real Redis, so an outage can be simulated per test WITHOUT
 * shutting down a server other suites (and other agents) are using.
 */
async function startProxy(): Promise<Proxy> {
  const target = new URL(REDIS_URL);
  const host = target.hostname;
  const port = target.port === '' ? 6379 : Number(target.port);
  const sockets = new Set<net.Socket>();
  let server: net.Server;
  let listenPort = 0;
  let acceptedCount = 0;
  let stalling = false;

  const build = (): net.Server =>
    net.createServer((client) => {
      acceptedCount++;
      sockets.add(client);
      const teardown = (): void => {
        sockets.delete(client);
        client.destroy();
      };
      client.on('error', teardown).on('close', teardown);
      if (stalling) {
        client.on('data', () => undefined);
        return;
      }
      const upstream = net.connect(port, host);
      const both = (): void => {
        teardown();
        upstream.destroy();
      };
      client.on('error', both).on('close', both);
      upstream.on('error', both).on('close', both);
      client.pipe(upstream);
      upstream.pipe(client);
    });

  server = build();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  listenPort = (server.address() as net.AddressInfo).port;

  const killSockets = (): void => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  return {
    url: `redis://127.0.0.1:${listenPort}`,
    live: () => sockets.size,
    accepted: () => acceptedCount,
    stallNewConnections: () => {
      stalling = true;
    },
    kill: () => {
      server.close();
      killSockets();
    },
    revive: async () => {
      server = build();
      await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', r));
    },
    close: () => {
      server.close();
      killSockets();
    },
  };
}

interface ProxyRig {
  proxy: Proxy;
  plugin: RedisPlugin;
  prefix: string;
  topic: Topic;
}

/**
 * One plugin behind a proxy of its own, in a key namespace no other case shares, torn down and wiped
 * however `body` ends. `connect()` stays in the body, so that a case still picks its own knobs and a
 * sequence that does its own connecting is the same rig as one that does not.
 *
 * Keep the setup and the teardown here rather than restated per case, so that a change to either —
 * closing the proxy before the plugin, wiping the namespace — reaches every case instead of the
 * subset whose copy someone remembered to edit.
 */
async function withProxiedPlugin<T>(body: (rig: ProxyRig) => Promise<T>): Promise<T> {
  const proxy = await startProxy();
  const prefix = freshPrefix();
  const plugin = new RedisPlugin();
  try {
    return await body({ proxy, plugin, prefix, topic: freshTopic() });
  } finally {
    await plugin.disconnect().catch(() => undefined);
    proxy.close();
    await wipe(prefix);
  }
}

/** The most sockets `proxy` held at once while `body` ran, sampled every `everyMs`. */
async function peakLive(proxy: Proxy, everyMs: number, body: () => Promise<void>): Promise<number> {
  let peak = 0;
  const watch = setInterval(() => {
    peak = Math.max(peak, proxy.live());
  }, everyMs);
  try {
    await body();
  } finally {
    clearInterval(watch);
  }
  return peak;
}

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<'resolved' | 'rejected'> {
  const timeout = Symbol('timeout');
  const outcome = await Promise.race([
    work.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), ms)),
  ]);
  if (outcome === timeout) throw new Error(`did not settle within ${ms}ms`);
  return outcome;
}

/**
 * Connect, seed a message, kill the backend, and wait out the socket-close error and the first
 * reconnect attempts — so the call a case measures next is issued into a client that has SETTLED
 * into "disconnected", the state where an offline queue swallows commands for the whole outage.
 * Only the commands in flight when the socket dies are rejected by the close itself, so measuring
 * the very first call after a kill proves nothing.
 */
async function intoSettledOutage({ proxy, plugin, prefix, topic }: ProxyRig): Promise<void> {
  await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
  await plugin.post(topic, asHandle('w'), 'before');
  proxy.kill();
  await settlesWithin(plugin.post(topic, asHandle('w'), 'flush').catch(() => undefined), 3000);
  await new Promise((r) => setTimeout(r, 300));
}

// -------------------------------------------------------------------------------------------
// CLASS: a message that lands in the gap between the catch-up query and the moment the waiter is
// armed is lost. The conformance long-poll case posts well after the fetch has registered, so it
// can never discriminate; every row here starts the post WITHOUT awaiting the fetch, so the write
// lands while the reader is still opening its connection — the arm-after-the-re-query defect.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — the long-poll query-to-wait gap', () => {
  // Only delays SHORTER than a reader handshake belong here. A longer one lands after the waiter
  // has registered, where the shipped conformance long-poll case already pins delivery, so it would
  // pass against the very defect this block exists to catch.
  it.each([0, 1, 2, 3])('delivers a post issued %ims into the long-poll', async (delayMs) =>
    withPlugin({ block_ms: 500 }, async ({ plugin }) => {
      const t = freshTopic();
      await plugin.post(t, asHandle('w'), 'seed');
      const since = (await plugin.fetchRecent({ topic: t })).nextCursor;

      const waiting = plugin.fetchRecent({ topic: t, since, blockMs: 5000 });
      const posted = new Promise<void>((r) => setTimeout(r, delayMs)).then(() =>
        plugin.post(t, asHandle('w'), 'fresh'),
      );

      const page = await waiting;
      await posted;
      expect(
        page.messages.map((m) => m.content),
        'the post landed in the query-to-wait gap and was never delivered',
      ).toEqual(['fresh']);
      expect(page.nextCursor).not.toBe(since);

      // …and the returned cursor is the one the next catch-up must resume from: re-fetching with
      // it returns nothing, so no message was skipped over on the way to it either.
      const after = await plugin.fetchRecent({ topic: t, since: page.nextCursor });
      expect(after.messages).toEqual([]);
    }));

  // CLASS: the sub-millisecond long-poll budget. `blockMs` is typed `number`, so 0.5 clears `> 0`
  // and floors to 0 — and `XREAD BLOCK 0` blocks FOREVER. The floor lives in exactly one place, so
  // grade it by its observable effect on BOTH sides: a budget that floors to nothing must open no
  // reader at all, and a budget that survives the floor must actually open one and wait.
  const budgets: Array<[string, number, 'no reader' | 'blocks']> = [
    ['0.1', 0.1, 'no reader'],
    ['0.5', 0.5, 'no reader'],
    ['0.999', 0.999, 'no reader'],
    ['1', 1, 'blocks'],
    ['400', 400, 'blocks'],
  ];

  it.each(budgets)(
    'a blockMs of %s opens a reader only when it survives the floor',
    async (_label, blockMs, outcome) =>
      withProxiedPlugin(async ({ proxy, plugin, prefix, topic: t }) => {
        await plugin.connect({ url: proxy.url, key_prefix: prefix });
        await plugin.post(t, asHandle('w'), 'seed');
        const since = (await plugin.fetchRecent({ topic: t })).nextCursor;
        const before = proxy.accepted();

        const started = Date.now();
        const page = await plugin.fetchRecent({ topic: t, since, blockMs });
        const elapsed = Date.now() - started;

        expect(page.messages).toEqual([]);
        expect(page.nextCursor).toBe(since);
        expect(elapsed, 'a sub-millisecond budget must never reach XREAD BLOCK 0').toBeLessThan(
          blockMs + 2000,
        );
        const readers = proxy.accepted() - before;
        if (outcome === 'no reader') {
          expect(readers, `a budget of ${blockMs} floors to nothing, so no reader is owed`).toBe(0);
        } else {
          expect(readers, `a budget of ${blockMs} was granted but no reader ever opened`).toBe(1);
          expect(elapsed, `a granted budget of ${blockMs}ms returned early`).toBeGreaterThanOrEqual(
            blockMs,
          );
        }
      }),
  );
});

// -------------------------------------------------------------------------------------------
// CLASS: every seam call must SETTLE within a bounded deadline while the backend is down, and
// the plugin must recover when it comes back.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — backend down mid-session', () => {
  it.each([
    ['post', (p: RedisPlugin, t: Topic) => p.post(t, asHandle('w'), 'during')],
    ['fetchRecent', (p: RedisPlugin, t: Topic) => p.fetchRecent({ topic: t })],
    [
      'fetchRecent since',
      (p: RedisPlugin, t: Topic) => p.fetchRecent({ topic: t, since: asCursor('1-0') }),
    ],
    [
      'fetchRecent blocking',
      (p: RedisPlugin, t: Topic) =>
        p.fetchRecent({ topic: t, since: asCursor('1-0'), blockMs: 5000 }),
    ],
    ['resolveIdentity', (p: RedisPlugin) => p.resolveIdentity(asHandle('w'))],
    ['subscribe', (p: RedisPlugin, t: Topic) => p.subscribe(t, () => undefined)],
  ] as Array<[string, (p: RedisPlugin, t: Topic) => Promise<unknown>]>)(
    '%s settles instead of queueing for the whole outage',
    async (_label, call) =>
      withProxiedPlugin(async (rig) => {
        await intoSettledOutage(rig);
        // Generous vs. the 5s blocking budget above, brutal vs. "queued for the whole outage".
        await expect(settlesWithin(call(rig.plugin, rig.topic), 3000)).resolves.toMatch(
          /resolved|rejected/,
        );
      }),
  );

  it('recovers once the backend comes back', async () =>
    withProxiedPlugin(async (rig) => {
      const { proxy, plugin, topic: t } = rig;
      await intoSettledOutage(rig);
      await expect(settlesWithin(plugin.post(t, asHandle('w'), 'during'), 3000)).resolves.toBe(
        'rejected',
      );
      await proxy.revive();
      await expect
        .poll(
          async () => {
            try {
              await plugin.post(t, asHandle('w'), 'after');
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000, interval: 200 },
        )
        .toBe(true);
      const page = await plugin.fetchRecent({ topic: t, limit: 100 });
      expect(page.messages.map((m) => m.content)).toContain('after');
    }));
});

// -------------------------------------------------------------------------------------------
// CLASS: repeated lifecycle calls must not leak backend resources. Counted on the proxy, which
// is an EXTERNAL observation of live sockets — the in-process `readers` array stays clean even
// when connections are orphaned.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — lifecycle must not leak connections', () => {
  const sequences: Array<[string, (p: RedisPlugin, url: string, t: Topic) => Promise<void>]> = [
    [
      'connect·connect·disconnect',
      async (p, url) => {
        await p.connect({ url });
        await p.connect({ url });
        await p.disconnect();
      },
    ],
    [
      'connect·subscribe·connect·disconnect',
      async (p, url, t) => {
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.connect({ url });
        await p.disconnect();
      },
    ],
    [
      'connect·disconnect·disconnect',
      async (p, url) => {
        await p.connect({ url });
        await p.disconnect();
        await p.disconnect();
      },
    ],
    [
      'connect·subscribe·disconnect·connect·subscribe·disconnect',
      async (p, url, t) => {
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.disconnect();
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.disconnect();
      },
    ],
    [
      'connect·fetchRecent(blocking)·connect·disconnect',
      async (p, url, t) => {
        await p.connect({ url, block_ms: 200 });
        await p.fetchRecent({ topic: t, since: asCursor('1-0'), blockMs: 200 });
        await p.connect({ url });
        await p.disconnect();
      },
    ],
  ];

  // OVERLAPPING lifecycle calls, which every sequence above misses by construction: each one reads
  // plugin state before the other has written it, so a client can end up referenced by nothing and
  // closeable by nobody. The final disconnect() is the assertion point — after it, zero sockets.
  const overlapping: Array<[string, (p: RedisPlugin, url: string, t: Topic) => Promise<void>]> = [
    [
      'connect ∥ connect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.connect({ url })]);
      },
    ],
    [
      'connect ∥ connect ∥ connect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.connect({ url }), p.connect({ url })]);
      },
    ],
    [
      'connect ∥ disconnect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.disconnect()]);
      },
    ],
    [
      'connect ∥ subscribe',
      async (p, url, t) => {
        await Promise.allSettled([p.connect({ url }), p.subscribe(t, () => undefined)]);
      },
    ],
    [
      'connect·(disconnect ∥ subscribe)',
      async (p, url, t) => {
        await p.connect({ url });
        await Promise.allSettled([p.disconnect(), p.subscribe(t, () => undefined)]);
      },
    ],
    [
      'connect·(connect ∥ fetchRecent(blocking))',
      async (p, url, t) => {
        await p.connect({ url, block_ms: 200 });
        await Promise.allSettled([
          p.connect({ url }),
          p.fetchRecent({ topic: t, since: asCursor('1-0'), blockMs: 500 }),
        ]);
      },
    ],
  ];

  it.each([...sequences, ...overlapping])('%s returns every socket', async (_label, run) =>
    withProxiedPlugin(async ({ proxy, plugin, topic: t }) => {
      await run(plugin, proxy.url, t);
      await plugin.disconnect();
      await expect.poll(() => proxy.live(), { timeout: 5000, interval: 50 }).toBe(0);
    }));

  // The reader-open FAILURE paths, which every sequence above misses by construction: their proxy
  // completes every handshake promptly, so `connectReader` never rejects and no error path is ever
  // walked. Here the first connection is a real Redis and every LATER one accepts TCP and then never
  // speaks RESP, so each reader dies on the whole-handshake deadline instead.
  //
  // The mid-session ceiling is the assertion that matters: cleanup that only runs on the success
  // path still passes the after-disconnect check, because tearDown() is a backstop that closes
  // whatever is still registered. Only a per-call ceiling sees a reader accumulate per long-poll.
  const failingReaders: Array<
    [string, (p: RedisPlugin, t: Topic, since: Cursor) => Promise<void>]
  > = [
    [
      'subscribe',
      async (p, t) => {
        await p.subscribe(t, () => undefined).catch(() => undefined);
      },
    ],
    [
      'one blocking fetchRecent',
      async (p, t, since) => {
        await p.fetchRecent({ topic: t, since, blockMs: 2000 });
      },
    ],
    [
      'three blocking fetchRecents',
      async (p, t, since) => {
        for (let i = 0; i < 3; i++) await p.fetchRecent({ topic: t, since, blockMs: 2000 });
      },
    ],
  ];

  it.each(failingReaders)(
    'returns every socket when a reader never finishes its handshake: %s',
    async (_label, run) =>
      withProxiedPlugin(async ({ proxy, plugin, prefix, topic: t }) => {
        await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
        // A cursor AT the tail is what makes the blocking rows open a reader at all: below the tail
        // XRANGE answers immediately, and past it the stale-cursor heal answers immediately.
        await plugin.post(t, asHandle('w'), 'seed');
        const since = (await plugin.fetchRecent({ topic: t })).nextCursor;
        proxy.stallNewConnections();
        const openedBefore = proxy.accepted();

        const peak = await peakLive(proxy, 10, () => run(plugin, t, since));
        expect(
          proxy.accepted() - openedBefore,
          'no reader was opened at all, so this row grades nothing',
        ).toBeGreaterThan(0);
        expect(
          peak,
          'a reader that failed its handshake was not returned before the next one opened',
        ).toBeLessThanOrEqual(2);

        await plugin.disconnect();
        await expect.poll(() => proxy.live(), { timeout: 5000, interval: 50 }).toBe(0);
      }),
  );
});

// -------------------------------------------------------------------------------------------
// CLASS: a HANDLER's failure ending the live path. `subscribe()` has already resolved, core keeps
// advertising this instance as subscribed, catch-up goes on working and nothing writes a line — so
// a topic whose push loop died looks exactly like a quiet one, and the dedicated reader it parked
// is never returned. Nothing in this package or in the shared conformance suite passed a handler
// that misbehaves at all, so the guarantee was carried by a comment.
//
// Two axes: HOW the handler fails (the shapes a `(msg) => void` seam type does not forbid — one bad
// message, every message, a non-Error, and an `async` handler whose rejection the loop never sees),
// and WHAT must survive it (later messages still delivered, in order, and the reader still held and
// still returned by disconnect()). Reader accounting is read off the proxy — an external count of
// live sockets — because the in-process `readers` array stays clean either way.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — a misbehaving handler never disables live push', () => {
  const misbehaviours: Array<[string, (nth: number) => unknown]> = [
    [
      'throws on the first message',
      (nth) => {
        if (nth === 0) throw new Error('handler blew up');
      },
    ],
    [
      'throws on every message',
      () => {
        throw new Error('handler blew up');
      },
    ],
    [
      'throws something that is not an Error',
      () => {
        throw 'handler blew up';
      },
    ],
    ['rejects asynchronously', () => Promise.reject(new Error('handler blew up'))],
  ];

  it.each(misbehaviours)('%s', async (_label, misbehave) =>
    withProxiedPlugin(async ({ proxy, plugin, prefix, topic: t }) => {
      // A rejection the loop never attached to reaches the process, where Node's default ends the
      // whole bridge. Collected here rather than left to the runner's global error accounting, so the
      // row that produced it is the row that fails.
      const escaped: unknown[] = [];
      const collect = (reason: unknown): void => {
        escaped.push(reason);
      };
      process.on('unhandledRejection', collect);
      try {
        await plugin.connect({ url: proxy.url, key_prefix: prefix, block_ms: 100 });
        const baseline = proxy.live();
        const seen: string[] = [];
        let nth = 0;
        // Whatever the handler produces is RETURNED, so a rejected promise reaches the loop rather
        // than being swallowed by this fixture — which is the only way the async row grades anything.
        await plugin.subscribe(t, (m) => {
          seen.push(m.content);
          return misbehave(nth++);
        });
        const held = proxy.live() - baseline;
        expect(held, 'subscribe() parked no reader, so the leak arm below grades nothing').toBe(1);

        const sent = ['first', 'second', 'third'];
        for (const c of sent) await plugin.post(t, asHandle('w'), c);
        await expect
          .poll(() => seen, { timeout: 5000, interval: 25 })
          .toEqual(sent); // every message after the failure, in order

        await plugin.disconnect();
        await expect.poll(() => proxy.live(), { timeout: 5000, interval: 50 }).toBe(0);
        expect(
          escaped,
          'a handler failure escaped the read loop as an unhandled rejection, which ends the whole ' +
            'bridge process on Node\'s default --unhandled-rejections=throw',
        ).toEqual([]);
      } finally {
        process.off('unhandledRejection', collect);
      }
    }));
});

// -------------------------------------------------------------------------------------------
// CLASS: a seam call that allocates a backend connection must allocate a BOUNDED number of them.
// `XREAD BLOCK` holds its connection for the whole wait, core imposes no concurrency limit on
// `fetch_recent`, and its wrapper ABANDONS an aborted long-poll rather than cancelling the plugin
// call — so without a cap one plugin instance parks one socket per in-flight call, for the whole
// granted budget, against the Redis every peer session shares. Every long-poll row elsewhere in
// this package and in the conformance suite issues exactly ONE blocking fetch at a time, which
// makes fan-out structurally unobservable there.
//
// Three axes: the CONCURRENCY (the bound must hold at, below and far above it), whether the caller
// still AWAITS the calls (an abandoned one is the shape that exhausts a server), and — the row that
// keeps the fix honest — `subscribe`, which is one reader per subscribed topic and must NOT be
// capped. Counted on the proxy, an external observation of live sockets, because the in-process
// `readers` array stays clean either way.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — a blocking fetch opens a bounded number of readers', () => {
  const concurrency = [1, MAX_BLOCKING_READERS, 8 * MAX_BLOCKING_READERS];
  const dispositions = ['awaited', 'abandoned'] as const;

  const rows = concurrency.flatMap((n) =>
    dispositions.map(
      (how) =>
        [`${n} concurrent, ${how}`, n, how] as [string, number, (typeof dispositions)[number]],
    ),
  );

  it.each(rows)('%s', async (_label, n, how) =>
    withProxiedPlugin(async ({ proxy, plugin, prefix, topic: t }) => {
      const budget = 1500;
      await plugin.connect({ url: proxy.url, key_prefix: prefix });
      // A cursor AT the tail is what makes every call reach the long poll: below it XRANGE answers
      // at once, past it the stale-cursor heal does.
      await plugin.post(t, asHandle('w'), 'seed');
      const since = (await plugin.fetchRecent({ topic: t })).nextCursor;
      const baseline = proxy.live();
      const openedBefore = proxy.accepted();

      const peak = await peakLive(proxy, 5, async () => {
        const calls = Array.from({ length: n }, () =>
          plugin.fetchRecent({ topic: t, since, blockMs: budget }),
        );
        if (how === 'awaited') {
          await Promise.all(calls);
        } else {
          for (const call of calls) void call.catch(() => undefined);
          await new Promise((r) => setTimeout(r, 500));
        }
        // Whether anyone is still holding the promises or not, the sockets come back on the
        // plugin's own budget — the abandoned arm is what core's cancel path actually does.
        await expect
          .poll(() => proxy.live(), { timeout: budget + 5000, interval: 25 })
          .toBe(baseline);
      });

      const opened = proxy.accepted() - openedBefore;
      expect(opened, 'no reader was opened at all, so this row grades nothing').toBeGreaterThan(0);
      expect(
        opened,
        `${n} concurrent long-polls opened ${opened} readers; a call past the cap must be served ` +
          `the empty page it can always be handed, not a socket of its own`,
      ).toBeLessThanOrEqual(Math.min(n, MAX_BLOCKING_READERS));
      expect(
        peak - baseline,
        `${n} concurrent long-polls held ${peak - baseline} sockets at once against a ` +
          `shared Redis, past the declared MAX_BLOCKING_READERS of ${MAX_BLOCKING_READERS}`,
      ).toBeLessThanOrEqual(MAX_BLOCKING_READERS);
    }));

  // The inverse arm, and the one a cap applied to the wrong place breaks: `subscribe` readers are
  // one per subscribed topic, live for the session, and are NOT long-polls — capping them silently
  // kills live push for every topic past the cap behind a `subscribe()` that resolved.
  it('subscribe is not capped — every subscribed topic keeps a reader of its own', async () =>
    withProxiedPlugin(async ({ proxy, plugin, prefix }) => {
      const topics = 2 * MAX_BLOCKING_READERS;
      await plugin.connect({ url: proxy.url, key_prefix: prefix });
      const baseline = proxy.live();
      const subscribed = Array.from({ length: topics }, () => freshTopic());
      const live: string[] = [];
      for (const t of subscribed) await plugin.subscribe(t, (m) => live.push(m.content));
      expect(
        proxy.live() - baseline,
        `${topics} subscriptions hold ${proxy.live() - baseline} readers; a cap meant for the ` +
          `long poll was applied to live push`,
      ).toBe(topics);
      // …and the last one — the one a cap would have dropped — really delivers.
      const last = subscribed.at(-1) as Topic;
      await plugin.post(last, asHandle('w'), 'pushed');
      await expect.poll(() => live, { timeout: 5000, interval: 50 }).toEqual(['pushed']);
    }));
});
