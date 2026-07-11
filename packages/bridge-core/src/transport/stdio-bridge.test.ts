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
import { buildBridge } from './stdio-bridge.js';

/**
 * A recording BackendPlugin for the lifecycle tests (BUG-27 / BUG-28). It timestamps every seam
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
    private readonly opts: { fetchThrows?: boolean; subscribeThrowsOn?: string } = {},
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(_config: BackendConfig): Promise<void> {
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
    return asBackendMsgId(String(++this.seq));
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

describe('buildBridge lifecycle: catch-up failure rollback (BUG-27)', () => {
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

describe('bridge attach ordering + rollback (BUG-28 / BUG-27)', () => {
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
