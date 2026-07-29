import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import {
  asBackendMsgId,
  asCursor,
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
    if (this.opts.subscribeThrowsOn === topic) {
      throw new Error(`subscribe boom on ${topic}`);
    }
  }

  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.events.push({ type: 'post', topic, content });
    const id = asBackendMsgId(String(++this.seq));
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

/**
 * Every way a backend's `post` can behave on the presence path. The presence goodbye is chained
 * into `stop()`, which every teardown path awaits — so any of these must leave teardown bounded.
 * `never settles` is the production shape nobody tests: an HTTP plugin with no request timeout.
 */
const POST_BEHAVIOURS = {
  resolves: (id: BackendMsgId): Promise<BackendMsgId> => Promise.resolve(id),
  rejects: (): Promise<BackendMsgId> => Promise.reject(new Error('post boom')),
  'rejects synchronously': (): Promise<BackendMsgId> => {
    throw new Error('post boom (sync)');
  },
  'never settles': (): Promise<BackendMsgId> => new Promise<BackendMsgId>(() => {}),
  'settles long after the teardown budget': (id: BackendMsgId): Promise<BackendMsgId> =>
    new Promise<BackendMsgId>((r) => setTimeout(() => r(id), 30_000).unref?.()),
} as const;
type PostBehaviour = keyof typeof POST_BEHAVIOURS;

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
   * Rollback must cover EVERY failure point in the startup sequence, not the one that was reported.
   * Same post-conditions in every row: the call rejects, the connection is released exactly once,
   * and nothing ever announced this bridge as reachable. `connect` is the one row where there is
   * nothing to release — it never got a connection.
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

    it.each([
      ['connect', { connectThrows: true }, /connect boom/, 0],
      ['on-start catch-up', { fetchThrows: true }, /catch-up boom/, 1],
      ['subscribe of the FIRST topic', { subscribeThrowsOn: 'ctx' }, /subscribe boom/, 1],
      ['subscribe of a LATER topic', { subscribeThrowsOn: 'ops' }, /subscribe boom/, 1],
    ])(
      'a failure in %s rejects, releases the connection, and never announces presence',
      async (_name, inject, message, expectedDisconnects) => {
        const plugin = new RecordingPlugin(inject);
        const cfg = cfgWith();

        const failed = await (async () => {
          const bridge = await buildBridge(plugin, cfg).catch((e: Error) => e);
          if (bridge instanceof Error) return bridge;
          const [, serverT] = InMemoryTransport.createLinkedPair();
          return bridge.attach(serverT).then(
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
   * The presence goodbye is a best-effort side channel; teardown must never be hostage to it. Table
   * every `post` behaviour a backend can exhibit against BOTH teardown entry points on this root
   * (an explicit shutdown, and the rollback inside a failed attach) and require a bounded return
   * plus exactly one disconnect in every cell.
   */
  describe('teardown is bounded whatever the presence post does', () => {
    const behaviours = Object.keys(POST_BEHAVIOURS) as Array<keyof typeof POST_BEHAVIOURS>;

    it.each(behaviours)('shutdown() completes with a post that %s', async (post) => {
      const plugin = new RecordingPlugin({ post });
      const cfg = parseConfig({
        identity: { handle: 'agent' },
        topics: ['ctx'],
        live_push: { enabled: false },
        presence: { enabled: true, heartbeat_ms: 60_000, ttl_ms: 180_000 },
      });
      const bridge = await buildBridge(plugin, cfg);
      const [, serverT] = InMemoryTransport.createLinkedPair();
      await bridge.attach(serverT);
      expect(await within(TEARDOWN_BUDGET_MS, bridge.shutdown())).not.toBe('TIMED OUT');
      expect(plugin.disconnectCount).toBe(1);
    });

    it.each(behaviours)('a failed attach rolls back with a post that %s', async (post) => {
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
