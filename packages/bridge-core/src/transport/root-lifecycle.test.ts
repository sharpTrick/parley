import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import { decodePresence, DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import { asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { NO_PRESENCE, remoteHttpApp } from '../testing/http-app.js';
import { createRemoteHttpApp } from './http.js';
import { buildBridge } from './stdio-bridge.js';

/**
 * One subject: starting and stopping a composition root. Both roots — the HTTP app's
 * listen()/close() and the stdio bridge's attach()/shutdown() — obey the same rules, so the tables
 * here run each rule against both: a start either binds or rejects with the real reason, a stop
 * resolves from any state and leaves nothing beating, a second start is refused, and nothing is
 * advertised to peers before the transport is live. How long a stop may TAKE is a different
 * question, graded in root-teardown-bounds.test.ts.
 */

const LIVE_PRESENCE = { presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 } };

const lifecycleCfg = (extra: Record<string, unknown> = {}): ReturnType<typeof parseConfig> =>
  parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'], ...LIVE_PRESENCE, ...extra });

const PUSHING = { live_push: { enabled: true } };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every presence post seen so far, in order. A FakePlugin records posts durably. */
async function presenceLog(p: FakePlugin): Promise<string[]> {
  const { messages } = await p.fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) });
  return messages.map((m) => m.content);
}

const beatCount = async (p: FakePlugin): Promise<number> => (await presenceLog(p)).length;

const kinds = async (p: FakePlugin): Promise<string[]> =>
  (await presenceLog(p)).map((c) => decodePresence(c)?.kind ?? 'unknown');

/** A port already bound by somebody else, and the release that frees it. */
async function occupiedPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker = createHttpServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  return {
    port: (blocker.address() as AddressInfo).port,
    release: () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  };
}

/**
 * Node reports ONE bind failure through three different channels — a synchronous throw out of
 * `app.listen` (any port outside the u16 range), the listen callback's error argument, and an
 * `'error'` event — and `listen` raises a start latch before any of them can fire. A latch lowered
 * on only some channels leaves a REJECTED listen poisoning the server: the next attempt fails with
 * "already listening" naming a socket that was never bound, which is exactly what a composition
 * root doing `try listen(cfgPort) catch listen(0)` port fallback hits. So table the SHAPES, not one
 * port, and require of every one of them: reject with the UNDERLYING error, and stay retryable with
 * NO intervening close().
 */
describe('remote HTTP: a failed listen rejects with the real error and stays retryable', () => {
  const appOn = (): ReturnType<typeof remoteHttpApp> =>
    remoteHttpApp({ insecureNoAuth: true }, NO_PRESENCE);

  type Attempt = (ctx: { takenPort: number }) => [port: number, host?: string];
  const SHAPES: Array<[name: string, code: string, attempt: Attempt]> = [
    ['synchronous throw: port above the u16 range', 'ERR_SOCKET_BAD_PORT', () => [70_000]],
    ['synchronous throw: negative port', 'ERR_SOCKET_BAD_PORT', () => [-1]],
    ['synchronous throw: non-integer port', 'ERR_SOCKET_BAD_PORT', () => [1.5]],
    ['synchronous throw: NaN port', 'ERR_SOCKET_BAD_PORT', () => [Number.NaN]],
    ['async error: the port is already bound', 'EADDRINUSE', ({ takenPort }) => [takenPort]],
    ['async error: the host is not one of ours', 'EADDRNOTAVAIL', () => [0, '203.0.113.1']],
  ];

  it.each(SHAPES)('%s', async (_name, code, attempt) => {
    const blocker = await occupiedPort();
    const { app, teardown } = await appOn();
    try {
      const [port, host] = attempt({ takenPort: blocker.port });
      // The UNDERLYING failure, never a resolved server whose address() is null and never the
      // latch's "already listening".
      await expect(app.listen(port, host)).rejects.toMatchObject({ code });
      // Retryable on the spot: no close() in between.
      const s = await app.listen(0);
      expect(s.address()).not.toBeNull();
    } finally {
      await teardown();
      await blocker.release();
    }
  });

  // EACCES is the third distinct bind-failure cause, and it is a PRIVILEGE fact, not a code fact —
  // root binds port 1. Assert that fact rather than skipping on an unchecked guess, so the row
  // cannot quietly stop testing anything on a machine where it would have applied.
  it('async error: a privileged port is refused (root binds it instead)', async () => {
    const { app, teardown } = await appOn();
    try {
      if (process.getuid?.() === 0) {
        const s = await app.listen(1);
        expect((s.address() as AddressInfo).port).toBe(1);
        return;
      }
      await expect(app.listen(1)).rejects.toMatchObject({ code: 'EACCES' });
      const s = await app.listen(0);
      expect(s.address()).not.toBeNull();
    } finally {
      await teardown();
    }
  });

  it('positive: listen(0) resolves with a bound server, and a later runtime error does not reject it', async () => {
    const { app, teardown } = await appOn();
    let settled: 'resolved' | 'rejected' | 'pending' = 'pending';
    const promise = app.listen(0).then(
      (s) => {
        settled = 'resolved';
        return s;
      },
      (e) => {
        settled = 'rejected';
        throw e;
      },
    );
    const s = await promise;
    expect(settled).toBe('resolved');
    // A genuinely BOUND server: address() is non-null.
    expect(s.address()).not.toBeNull();
    // A later runtime 'error' on the live server must NOT flip the already-settled promise into a
    // rejection (the success callback removed listen()'s reject listener).
    s.on('error', () => {}); // catcher so emit() doesn't throw (EventEmitter throws on unhandled 'error')
    s.emit('error', Object.assign(new Error('runtime boom'), { code: 'ERUNTIME' }));
    // Give any stray rejection a tick to surface, then confirm the promise is still resolved.
    await Promise.resolve();
    await expect(promise).resolves.toBe(s);
    expect(settled).toBe('resolved');
    await teardown();
  });
});

/**
 * Teardown is called on paths nobody chose: a `try { await listen() } finally { await close() }`
 * root, a signal handler racing an explicit shutdown, a retry after a failed bind. Table the ORDERS
 * `listen`/`close` can arrive in and require every close() to RESOLVE — and no presence loop to
 * survive it. Cleanup here deliberately does NOT swallow: a `close()` that rejects is the defect,
 * and a `.catch(() => {})` in cleanup is what let it ship.
 */
describe('remote HTTP: close() resolves in whatever order the lifecycle runs', () => {
  type Op = 'listen-ok' | 'listen-fail' | 'close';

  const SEQUENCES: Array<[name: string, ops: Op[]]> = [
    ['close before any listen', ['close']],
    ['a failed bind, then close', ['listen-fail', 'close']],
    ['listen, close, close again', ['listen-ok', 'close', 'close']],
    ['listen, close, listen again, close', ['listen-ok', 'close', 'listen-ok', 'close']],
    ['a failed bind, a good one, then close', ['listen-fail', 'listen-ok', 'close']],
  ];

  it.each(SEQUENCES)('%s', async (_name, ops) => {
    const blocker = await occupiedPort();
    const { plugin, app } = await remoteHttpApp({ insecureNoAuth: true }, LIVE_PRESENCE);
    const bound: Array<Awaited<ReturnType<typeof app.listen>>> = [];
    try {
      for (const op of ops) {
        if (op === 'listen-ok') bound.push(await app.listen(0));
        else if (op === 'listen-fail') {
          await expect(app.listen(blocker.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
        } else await app.close();
      }
      for (const s of bound) expect(s.listening).toBe(false);
      const atStop = await beatCount(plugin);
      await sleep(80); // several heartbeat cadences
      expect(await beatCount(plugin)).toBe(atStop);
    } finally {
      await plugin.disconnect();
      await blocker.release();
    }
  });
});

/**
 * Every row of the table above AWAITS its start, so none of them can reach the window a teardown
 * actually races: a start that has been ASKED for but has not settled. In it a stop finds nothing
 * bound yet, walks away, and the start then completes behind it — a socket and a presence loop with
 * nothing left that can stop them, which is the same orphan a second overlapping start would make.
 * One rule, both composition roots: after ANY interleaving of one start and one stop, nothing this
 * root owns is still running, nothing beats, and a further stop still resolves.
 */
describe('a start interleaved with a stop leaves nothing running', () => {
  type Op = 'start' | 'start-pending' | 'stop' | 'await-starts';

  interface Root {
    /** Begin a start. Rejections are the caller's to tolerate — an interleaved start may lose. */
    start: () => Promise<unknown>;
    stop: () => Promise<void>;
    /** Anything this root still owns and a stop should already have released. */
    running: () => boolean;
  }

  const ROOTS: Record<string, (p: FakePlugin) => Promise<Root>> = {
    'http listen()/close()': async (p) => {
      const app = createRemoteHttpApp(p, lifecycleCfg(PUSHING), { insecureNoAuth: true });
      const bound: Array<Awaited<ReturnType<typeof app.listen>>> = [];
      return {
        start: async () => bound.push(await app.listen(0)),
        stop: () => app.close(),
        running: () => bound.some((s) => s.listening),
      };
    },
    'stdio attach()/shutdown()': async (p) => {
      const bridge = await buildBridge(p, lifecycleCfg(PUSHING));
      return {
        start: () => bridge.attach(InMemoryTransport.createLinkedPair()[1]),
        stop: () => bridge.shutdown(),
        // The stdio root owns the plugin connection (and with it the poll timers), not a socket.
        running: () => p.connected,
      };
    },
  };

  const SEQUENCES: Array<[name: string, ops: Op[]]> = [
    ['stop before any start', ['stop']],
    ['a settled start, then stop twice', ['start', 'stop', 'stop']],
    ['stop while the start is still in flight', ['start-pending', 'stop', 'await-starts']],
    ['stop twice while the start is still in flight', ['start-pending', 'stop', 'stop', 'await-starts']],
    ['stop mid-start, then stop once it has settled', ['start-pending', 'stop', 'await-starts', 'stop']],
    ['two overlapping starts, then stop', ['start-pending', 'start-pending', 'stop', 'await-starts']],
  ];

  const CELLS = Object.keys(ROOTS).flatMap((root) =>
    SEQUENCES.map(([name, ops]) => [root, name, ops] as const),
  );

  it.each(CELLS)('%s: %s', async (rootName, _name, ops) => {
    const p = new FakePlugin();
    await p.connect({});
    const root = await ROOTS[rootName]!(p);
    const pending: Array<Promise<unknown>> = [];
    const settle = async (): Promise<void> => {
      await Promise.allSettled(pending.splice(0));
    };
    try {
      for (const op of ops) {
        if (op === 'start') await root.start().catch(() => undefined);
        else if (op === 'start-pending') pending.push(root.start());
        else if (op === 'stop') await root.stop();
        else await settle();
      }
      await settle();

      expect(root.running()).toBe(false);
      const atStop = await beatCount(p);
      await sleep(100); // several heartbeat cadences
      expect(await beatCount(p)).toBe(atStop);
      await expect(root.stop()).resolves.toBeUndefined();
    } finally {
      await p.disconnect();
    }
  });
});

/**
 * Presence is a liveness advertisement: peers use `parley_list_users` to pick a hand-off target, so
 * an announcement must never precede a delivery path that can answer. Both composition roots have
 * to obey one rule, so table them together — the HTTP root announced at CONSTRUCTION time (before
 * any bind, and even when the bind failed) while the stdio root deliberately waited.
 */
describe('presence is announced only once the transport is actually live', () => {
  const settle = (): Promise<void> => sleep(120); // several heartbeat cadences

  it('http root: nothing is announced before listen() resolves', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const app = createRemoteHttpApp(p, lifecycleCfg(PUSHING), { insecureNoAuth: true });
    await settle();
    expect(await presenceLog(p)).toEqual([]); // constructed, never listened ⇒ never advertised
    const s = await app.listen(0);
    expect(s.address()).not.toBeNull();
    await vi.waitFor(async () => expect((await presenceLog(p)).length).toBeGreaterThan(0));
    await app.close();
    await p.disconnect();
  });

  it('http root: a failed bind never announces', async () => {
    const blocker = await occupiedPort();
    const p = new FakePlugin();
    await p.connect({});
    const app = createRemoteHttpApp(p, lifecycleCfg(PUSHING), { insecureNoAuth: true });
    await expect(app.listen(blocker.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await settle();
    expect(await presenceLog(p)).toEqual([]);
    await app.close();
    await p.disconnect();
    await blocker.release();
  });

  it('stdio root: nothing is announced before attach(), and a failed attach never announces', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const bridge = await buildBridge(p, lifecycleCfg(PUSHING));
    await settle();
    expect(await presenceLog(p)).toEqual([]); // built, never attached ⇒ never advertised
    const [, serverT] = InMemoryTransport.createLinkedPair();
    await bridge.attach(serverT);
    await vi.waitFor(async () => expect((await presenceLog(p)).length).toBeGreaterThan(0));
    await bridge.shutdown();

    const failing = new FakePlugin();
    await failing.connect({});
    failing.subscribe = (): Promise<void> => Promise.reject(new Error('subscribe boom'));
    const doomed = await buildBridge(failing, lifecycleCfg(PUSHING));
    const [, t2] = InMemoryTransport.createLinkedPair();
    await expect(doomed.attach(t2)).rejects.toThrow(/subscribe boom/);
    await settle();
    expect(await presenceLog(failing)).toEqual([]);
  });
});

/**
 * Starting a composition root twice must fail, not silently double up: the second start would
 * overwrite the first server + presence loop, leaving a socket bound and a loop beating that no
 * teardown can ever reach — so `parley_list_users` reports a shut-down bridge as online forever.
 * One rule, both roots.
 */
describe('a composition root can only be started once', () => {
  interface Started {
    startAgain: () => Promise<unknown>;
    stop: () => Promise<void>;
    stillBound: () => boolean;
  }

  const roots: Record<string, (p: FakePlugin) => Promise<Started>> = {
    'http listen()': async (p) => {
      const app = createRemoteHttpApp(p, lifecycleCfg(), { insecureNoAuth: true });
      const s = await app.listen(0);
      return {
        startAgain: () => app.listen(0),
        stop: () => app.close(),
        stillBound: () => s.listening,
      };
    },
    'stdio attach()': async (p) => {
      const bridge = await buildBridge(p, lifecycleCfg());
      await bridge.attach(InMemoryTransport.createLinkedPair()[1]);
      return {
        startAgain: () => bridge.attach(InMemoryTransport.createLinkedPair()[1]),
        stop: () => bridge.shutdown(),
        stillBound: () => false,
      };
    },
  };

  it.each(Object.keys(roots))(
    '%s rejects a second start, runs exactly one presence loop, and goes quiet on teardown',
    async (name) => {
      const p = new FakePlugin();
      await p.connect({});
      const started = await roots[name]!(p);
      await vi.waitFor(async () => expect((await kinds(p)).length).toBeGreaterThan(0));

      await expect(started.startAgain()).rejects.toThrow();
      await sleep(80); // several heartbeat cadences

      // A second loop would announce itself with its own hello.
      expect((await kinds(p)).filter((k) => k === 'hello')).toHaveLength(1);

      await started.stop();
      expect(started.stillBound()).toBe(false);
      const atStop = (await kinds(p)).length;
      await sleep(100);
      expect((await kinds(p)).length).toBe(atStop); // nothing beats past teardown
      await p.disconnect();
    },
  );

  /**
   * Every row above AWAITS the first start, so none of them enters the window the guard actually has
   * to cover: between `app.listen()` and its `listening` event, `server.listening` reports false, and
   * a guard reading it lets a second overlapping call bind too — orphaning the first socket and its
   * presence loop where no `close()` can ever reach them.
   */
  const overlapping: Record<
    string,
    (p: FakePlugin) => Promise<{ starts: Array<Promise<unknown>>; stop: () => Promise<void> }>
  > = {
    'http listen()': async (p) => {
      const app = createRemoteHttpApp(p, lifecycleCfg(), { insecureNoAuth: true });
      return { starts: [app.listen(0), app.listen(0)], stop: () => app.close() };
    },
    'stdio attach()': async (p) => {
      const bridge = await buildBridge(p, lifecycleCfg());
      return {
        starts: [
          bridge.attach(InMemoryTransport.createLinkedPair()[1]),
          bridge.attach(InMemoryTransport.createLinkedPair()[1]),
        ],
        stop: () => bridge.shutdown(),
      };
    },
  };

  it.each(Object.keys(overlapping))('%s rejects a second start that OVERLAPS the first', async (name) => {
    const p = new FakePlugin();
    await p.connect({});
    const { starts, stop } = await overlapping[name]!(p);
    const settled = await Promise.allSettled(starts);

    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    await sleep(80); // several heartbeat cadences
    expect((await kinds(p)).filter((k) => k === 'hello')).toHaveLength(1);

    await stop();
    for (const s of settled) {
      const bound =
        s.status === 'fulfilled' ? (s.value as { listening?: boolean } | undefined)?.listening : undefined;
      if (bound !== undefined) expect(bound).toBe(false); // teardown reached whatever bound
    }
    const atStop = (await kinds(p)).length;
    await sleep(100);
    expect((await kinds(p)).length).toBe(atStop);
    await p.disconnect();
  });
});
