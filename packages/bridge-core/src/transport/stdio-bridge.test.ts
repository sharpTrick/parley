import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  type BackendMsgId,
  type Handle,
  type Message,
  type Topic,
} from '../message.js';
import type {
  BackendConfig,
  BackendIdentity,
  BackendPlugin,
  FetchRecentArgs,
  FetchRecentResult,
  MessageHandler,
} from '../seam.js';
import {
  POST_BEHAVIOUR_NAMES,
  POST_BEHAVIOURS,
  unhandledDuring,
  type PostBehaviour,
} from '../testing/failure-shapes.js';
import { GOODBYE_TIMEOUT_MS } from './presence-loop.js';
import { buildBridge } from './stdio-bridge.js';

/**
 * A recording BackendPlugin for the lifecycle tests. It timestamps every seam
 * call into a single ordered `events` log so a test can assert the RELATIVE order of `subscribe`
 * (push wiring) vs `post` to the presence topic (presence hello). Failure injection is opt-in:
 * `fetchThrows` makes on-start catch-up fail; `subscribeThrowsOn` makes the push loop fail on a
 * given topic. Nothing here is SQLite-specific — it exercises the core lifecycle, not a backend.
 */
type Event =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'subscribe'; topic: string }
  | { type: 'post'; topic: string; content: string }
  | { type: 'fetchRecent'; topic: string };

class RecordingPlugin implements BackendPlugin {
  readonly events: Event[] = [];
  connectCount = 0;
  disconnectCount = 0;
  private seq = 0;

  constructor(
    private readonly opts: {
      fetchThrows?: boolean;
      subscribeThrowsOn?: string;
      connectThrows?: boolean;
      post?: PostBehaviour;
      subscribeParks?: () => Promise<void>;
    } = {},
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(_config: BackendConfig): Promise<void> {
    if (this.opts.connectThrows === true) throw new Error('connect boom');
    this.connectCount++;
    this.events.push({ type: 'connect' });
  }

  async disconnect(): Promise<void> {
    this.disconnectCount++;
    this.events.push({ type: 'disconnect' });
  }

  async subscribe(topic: Topic, _handler: MessageHandler): Promise<void> {
    this.events.push({ type: 'subscribe', topic });
    if (this.opts.subscribeParks !== undefined) await this.opts.subscribeParks();
    if (this.opts.subscribeThrowsOn === topic) {
      throw new Error(`subscribe boom on ${topic}`);
    }
  }

  // Keep this method NON-async, so that a `rejects synchronously` behaviour really throws before
  // returning a promise; an async wrapper would silently downgrade it to an ordinary rejection.
  post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.events.push({ type: 'post', topic, content });
    const id = Promise.resolve(asBackendMsgId(String(++this.seq)));
    return this.opts.post === undefined ? id : POST_BEHAVIOURS[this.opts.post](id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    this.events.push({ type: 'fetchRecent', topic: args.topic });
    if (this.opts.fetchThrows) throw new Error('catch-up boom');
    return { messages: [] as Message[], nextCursor: args.since ?? asCursor('0') };
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }
}

const PRESENCE_TOPIC = 'parley-presence';

/** What `attach` accepts — the SDK's transport interface, as the bridge declares it. */
type AnyTransport = Parameters<Awaited<ReturnType<typeof buildBridge>>['attach']>[0];

/** Wall-clock ceiling a teardown must settle inside, whatever the backend does. */
const TEARDOWN_BUDGET_MS = GOODBYE_TIMEOUT_MS + 1_500;

async function within<T>(budget: number, work: Promise<T>): Promise<T | 'TIMED OUT'> {
  return Promise.race<T | 'TIMED OUT'>([
    work,
    new Promise<'TIMED OUT'>((r) => setTimeout(() => r('TIMED OUT'), budget).unref?.()),
  ]);
}

describe('buildBridge lifecycle: catch-up failure rollback', () => {
  it('disconnects the plugin exactly once when on-start catch-up throws, then rejects', async () => {
    const plugin = new RecordingPlugin({ fetchThrows: true });
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      // catchup.on_start defaults true
      presence: { enabled: false },
    });
    await expect(buildBridge(plugin, cfg)).rejects.toThrow(/catch-up boom/);
    // The connected plugin (and its background timers) must not be orphaned: disconnect ran once.
    expect(plugin.connectCount).toBe(1);
    expect(plugin.disconnectCount).toBe(1);
    // Ordering sanity: connect happened, catch-up was attempted, then disconnect — no leak.
    expect(plugin.events.map((e) => e.type)).toEqual(['connect', 'fetchRecent', 'disconnect']);
  });
});

describe('bridge attach ordering + rollback', () => {
  it('wires the push loop (subscribe) BEFORE announcing presence (hello post)', async () => {
    const plugin = new RecordingPlugin();
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      live_push: { enabled: true },
      presence: { enabled: true, heartbeat_ms: 60_000, ttl_ms: 180_000 },
    });
    const bridge = await buildBridge(plugin, cfg);
    const [, serverT] = InMemoryTransport.createLinkedPair();
    await bridge.attach(serverT);
    // The presence hello is posted on a microtask after attach() returns; wait for it to land.
    await vi.waitFor(() =>
      expect(plugin.events.some((e) => e.type === 'post' && e.topic === PRESENCE_TOPIC)).toBe(true),
    );
    const firstSubscribe = plugin.events.findIndex((e) => e.type === 'subscribe');
    const firstPresencePost = plugin.events.findIndex(
      (e) => e.type === 'post' && e.topic === PRESENCE_TOPIC,
    );
    expect(firstSubscribe).toBeGreaterThanOrEqual(0);
    expect(firstPresencePost).toBeGreaterThan(firstSubscribe);
    await bridge.shutdown();
  });

  /**
   * Rollback must cover EVERY awaited call in the startup sequence, not the one that was reported —
   * including the transport handshake, which is not a seam call and so is easy to leave outside the
   * rollback window while the table still reads as exhaustive. Same post-conditions in every row:
   * the call rejects, the connection is released exactly once, and nothing ever announced this
   * bridge as reachable. `connect` is the one row where there is nothing to release — it never got
   * a connection.
   */
  describe('every startup failure point rolls back identically', () => {
    const cfgWith = (over: Record<string, unknown> = {}) =>
      parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx', 'ops'],
        live_push: { enabled: true },
        presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 },
        ...over,
      });

    const liveTransport = (): AnyTransport => InMemoryTransport.createLinkedPair()[1];
    const failingTransport = (): AnyTransport => {
      const [, t] = InMemoryTransport.createLinkedPair();
      t.start = (): Promise<void> => Promise.reject(new Error('transport boom'));
      return t;
    };

    it.each([
      ['connect', { connectThrows: true }, /connect boom/, 0, liveTransport],
      ['on-start catch-up', { fetchThrows: true }, /catch-up boom/, 1, liveTransport],
      ['the transport handshake', {}, /transport boom/, 1, failingTransport],
      ['subscribe of the FIRST topic', { subscribeThrowsOn: 'ctx' }, /subscribe boom/, 1, liveTransport],
      ['subscribe of a LATER topic', { subscribeThrowsOn: 'ops' }, /subscribe boom/, 1, liveTransport],
    ])(
      'a failure in %s rejects, releases the connection, and never announces presence',
      async (_name, inject, message, expectedDisconnects, transport) => {
        const plugin = new RecordingPlugin(inject);
        const cfg = cfgWith();

        const failed = await (async () => {
          const bridge = await buildBridge(plugin, cfg).catch((e: Error) => e);
          if (bridge instanceof Error) return bridge;
          return bridge.attach(transport()).then(
            () => new Error('startup unexpectedly succeeded'),
            (e: Error) => e,
          );
        })();

        expect(failed.message).toMatch(message);
        expect(plugin.disconnectCount).toBe(expectedDisconnects);
        // Give the (20ms) heartbeat several cycles: a rolled-back startup never advertises itself.
        await new Promise((r) => setTimeout(r, 120));
        expect(plugin.events.filter((e) => e.type === 'post' && e.topic === PRESENCE_TOPIC)).toEqual(
          [],
        );
      },
    );
  });

  /**
   * `shutdown()` racing `attach()`. Every await inside attach is a point where the latch can already
   * be set by the time it resolves, and the steps AFTER it must not run — a presence loop started
   * past teardown beats on forever, advertising a disconnected bridge as reachable, with shutdown()
   * already spent. Park each await in turn, land a full shutdown() while it is parked, then release:
   * one row per await point, so an await added to attach without a matching latch recheck fails its
   * own row rather than riding along on a neighbour's.
   *
   * The release is deliberately UNLATCHED and therefore runs TWICE here — the parked step finishes
   * AFTER shutdown released everything, re-acquiring what it was in the middle of (a transport
   * handshake that completes after `server.close()`; a subscription registered after
   * `plugin.disconnect()`), so the rollback has to release it again. The rows pin that: both the
   * repeat count and the post-conditions it exists to produce.
   */
  describe('shutdown() landing mid-attach', () => {
    /** A latch a parked step waits on, plus a signal that the step has reached it. */
    function gate(): { park: () => Promise<void>; arrived: Promise<void>; open: () => void } {
      let open!: () => void;
      const opened = new Promise<void>((r) => {
        open = r;
      });
      let reached!: () => void;
      const arrived = new Promise<void>((r) => {
        reached = r;
      });
      return {
        park: async () => {
          reached();
          await opened;
        },
        arrived,
        open,
      };
    }

    type Gate = ReturnType<typeof gate>;
    type Armed = { plugin: RecordingPlugin; transport: AnyTransport };

    const PARK_POINTS: Array<[name: string, arm: (g: Gate) => Armed]> = [
      [
        'the transport handshake (server.connect)',
        (g) => {
          const [, transport] = InMemoryTransport.createLinkedPair();
          const start = transport.start.bind(transport);
          transport.start = async (): Promise<void> => {
            await g.park();
            return start();
          };
          return { plugin: new RecordingPlugin(), transport };
        },
      ],
      [
        'the push loop (plugin.subscribe)',
        (g) => ({
          plugin: new RecordingPlugin({ subscribeParks: g.park }),
          transport: InMemoryTransport.createLinkedPair()[1],
        }),
      ],
    ];

    // A seam whose `disconnect` is NOT idempotent is the case the double release exposes: the second
    // call must stay absorbed, never escaping as an unhandled rejection or a different attach error.
    const DISCONNECTS = ['resolves every time', 'rejects on the second call'] as const;

    it.each(
      PARK_POINTS.flatMap(([name, arm]) =>
        DISCONNECTS.map((d) => [name, d, arm] as [string, (typeof DISCONNECTS)[number], (g: Gate) => Armed]),
      ),
    )('parked in %s, with a disconnect that %s', async (_name, disconnects, arm) => {
      const g = gate();
      const { plugin, transport } = arm(g);
      if (disconnects !== 'resolves every time') {
        const real = plugin.disconnect.bind(plugin);
        plugin.disconnect = async (): Promise<void> => {
          await real();
          if (plugin.disconnectCount > 1) throw new Error('disconnect boom (not idempotent)');
        };
      }
      // ONE topic, so the parked step is the whole of its stage: `startPushLoop` iterates topics
      // with no latch of its own, and a second topic would subscribe after teardown no matter which
      // recheck is in place — hiding the recheck this row exists to witness.
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        live_push: { enabled: true },
        presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 },
      });
      const bridge = await buildBridge(plugin, cfg);
      const closeSpy = vi.spyOn(bridge.server, 'close');

      const escaped = await unhandledDuring(async () => {
        const attaching = bridge.attach(transport).then(
          () => 'resolved',
          (e: Error) => e.message,
        );
        await g.arrived;
        expect(await within(TEARDOWN_BUDGET_MS, bridge.shutdown())).not.toBe('TIMED OUT');
        g.open();
        expect(await within(TEARDOWN_BUDGET_MS, attaching)).toMatch(/bridge shut down while attaching/);
        // Several heartbeat periods: a presence loop started past the latch would beat forever.
        await new Promise((r) => setTimeout(r, 120));
      });

      expect(plugin.events.filter((e) => e.type === 'post' && e.topic === PRESENCE_TOPIC)).toEqual([]);
      expect(escaped).toEqual([]);
      // The step that resumes after teardown must start nothing further: once the bridge has
      // disconnected, the only seam call left to make is the rollback's own second disconnect. This
      // is what makes EVERY recheck falsifiable — the one guarding a later await would otherwise
      // cover for a missing one guarding an earlier await, and the row would stay green.
      const released = plugin.events.findIndex((e) => e.type === 'disconnect');
      expect(plugin.events.slice(released + 1).filter((e) => e.type !== 'disconnect')).toEqual([]);
      // Released TWICE, on purpose: the parked step finished after shutdown had already released
      // everything, so a subscription it registered on a disconnected plugin is only reclaimed by
      // the rollback's own second release. Latching that away leaves it dangling.
      expect(plugin.disconnectCount).toBe(2);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * The presence goodbye is a best-effort side channel; teardown must never be hostage to it. Table
   * every `post` behaviour a backend can exhibit against BOTH teardown entry points on this root
   * (an explicit shutdown, and the rollback inside a failed attach) and require a bounded return
   * plus exactly one disconnect in every cell.
   */
  describe('teardown is bounded whatever the presence post does', () => {
    it.each(POST_BEHAVIOUR_NAMES)('shutdown() completes with a post that %s', async (post) => {
      const plugin = new RecordingPlugin({ post });
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        live_push: { enabled: false },
        // A live cadence, so the heartbeat site is exercised too and not just hello + goodbye.
        presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 180_000 },
      });
      const escaped = await unhandledDuring(async () => {
        const bridge = await buildBridge(plugin, cfg);
        const [, serverT] = InMemoryTransport.createLinkedPair();
        await bridge.attach(serverT);
        await new Promise((r) => setTimeout(r, 60)); // several heartbeats
        expect(await within(TEARDOWN_BUDGET_MS, bridge.shutdown())).not.toBe('TIMED OUT');
      });
      expect(plugin.disconnectCount).toBe(1);
      // A best-effort beat may fail; it may never take the process down with it.
      expect(escaped).toEqual([]);
    });

    it.each(POST_BEHAVIOUR_NAMES)('a failed attach rolls back with a post that %s', async (post) => {
      const plugin = new RecordingPlugin({ post, subscribeThrowsOn: 'ops' });
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx', 'ops'],
        live_push: { enabled: true },
        presence: { enabled: true, heartbeat_ms: 60_000, ttl_ms: 180_000 },
      });
      const bridge = await buildBridge(plugin, cfg);
      const [, serverT] = InMemoryTransport.createLinkedPair();
      const outcome = await within(
        TEARDOWN_BUDGET_MS,
        bridge.attach(serverT).then(
          () => 'resolved',
          (e: Error) => e.message,
        ),
      );
      expect(outcome).toMatch(/subscribe boom/);
      expect(plugin.disconnectCount).toBe(1);
      // shutdown() after a rolled-back attach must not disconnect a second time.
      await bridge.shutdown();
      expect(plugin.disconnectCount).toBe(1);
    });

    /**
     * A teardown step that REJECTS is the case the table above cannot reach: every `post` behaviour
     * it injects is swallowed by the best-effort presence beat. Latching the "already torn down"
     * flag and then short-circuiting on the first rejection skipped `server.close()` forever and made
     * every retry a silent no-op — on the stdio root that leaves stdin resumed, so an operator's
     * signal handler awaiting shutdown() never returns. Cross the failing step with both teardown
     * entry points and require, in every cell, that the OTHER steps still ran exactly once.
     */
    describe('a rejecting teardown step never cancels the others', () => {
      const STEPS = ['plugin.disconnect', 'server.close', 'both'] as const;
      const ENTRIES = ['shutdown()', 'the rollback inside a failed attach'] as const;

      it.each(STEPS.flatMap((step) => ENTRIES.map((entry) => [step, entry] as const)))(
        '%s rejects, torn down via %s',
        async (step, entry) => {
          const failingAttach = entry !== 'shutdown()';
          const plugin = new RecordingPlugin(failingAttach ? { subscribeThrowsOn: 'ops' } : {});
          if (step !== 'server.close') {
            plugin.disconnect = (): Promise<void> => {
              plugin.disconnectCount++;
              return Promise.reject(new Error('disconnect boom'));
            };
          }
          const cfg = parseConfig({
            identity: { handle: 'agent' },
            topics: ['ctx', 'ops'],
            live_push: { enabled: failingAttach },
            presence: { enabled: true, heartbeat_ms: 60_000, ttl_ms: 180_000 },
          });
          const bridge = await buildBridge(plugin, cfg);
          const closeSpy = vi.spyOn(bridge.server, 'close');
          if (step !== 'plugin.disconnect') closeSpy.mockRejectedValue(new Error('close boom'));

          const [, serverT] = InMemoryTransport.createLinkedPair();
          const first = failingAttach
            ? await within(TEARDOWN_BUDGET_MS, bridge.attach(serverT).catch((e: Error) => e.message))
            : await (async () => {
                await bridge.attach(serverT);
                return within(TEARDOWN_BUDGET_MS, bridge.shutdown().then(() => 'resolved', (e: Error) => e.message));
              })();

          expect(first).not.toBe('TIMED OUT');
          // Every step ran exactly once, whichever one of them rejected.
          expect(plugin.disconnectCount).toBe(1);
          expect(closeSpy).toHaveBeenCalledTimes(1);

          // A retry is a no-op rather than a second release — and never hangs.
          expect(
            await within(TEARDOWN_BUDGET_MS, bridge.shutdown().then(() => 'resolved', () => 'rejected')),
          ).not.toBe('TIMED OUT');
          expect(plugin.disconnectCount).toBe(1);
          expect(closeSpy).toHaveBeenCalledTimes(1);
        },
      );
    });

    it('the sync-throw behaviour reaches the bridge as a real synchronous throw', () => {
      const plugin = new RecordingPlugin({ post: 'rejects synchronously' });
      expect(() => plugin.post(asTopic('ctx'), asHandle('agent'), 'x')).toThrow();
    });
  });

  it('a failed attach (subscribe rejects) rejects and leaves NO presence loop beating', async () => {
    const plugin = new RecordingPlugin({ subscribeThrowsOn: 'ops' });
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx', 'ops'],
      live_push: { enabled: true },
      presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 },
    });
    const bridge = await buildBridge(plugin, cfg);
    const [, serverT] = InMemoryTransport.createLinkedPair();
    await expect(bridge.attach(serverT)).rejects.toThrow(/subscribe boom/);
    // Because push is wired BEFORE presence, a subscribe failure means presence was never started —
    // the bridge is not left half-live advertising reachability. Give the (short) heartbeat several
    // cycles: still no presence post ever appears.
    await new Promise((r) => setTimeout(r, 120));
    const presencePosts = plugin.events.filter(
      (e) => e.type === 'post' && e.topic === PRESENCE_TOPIC,
    );
    expect(presencePosts).toHaveLength(0);
    await bridge.shutdown().catch(() => {});
  });
});
