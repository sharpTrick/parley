import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import {
  computeRoster,
  decodePresence,
  type PresenceKind,
  type PresenceRecord,
} from '../engine/presence.js';
import {
  asHandle,
  asTopic,
  type BackendMsgId,
  type Handle,
  type Topic,
} from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startPresenceLoop } from './presence-loop.js';

/**
 * A FakePlugin whose `post` can be held mid-flight — the shipped `FakePlugin.post` is effectively
 * synchronous (which is exactly why SQLite is immune to BUG-26), so we need a genuinely async post
 * to reproduce the stop()/heartbeat race on network backends.
 */
class DeferredFakePlugin extends FakePlugin {
  private release?: () => void;
  private holdNext = false;
  /** Arm the NEXT post to block until {@link releaseHeld}. */
  hold(): void {
    this.holdNext = true;
  }
  releaseHeld(): void {
    this.release?.();
    this.release = undefined;
  }
  override async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>((res) => {
        this.release = res;
      });
    }
    return super.post(topic, identity, content, opts);
  }
}

const NOW = 1_000_000;
const PRESENCE_TOPIC = asTopic('parley-presence');

async function records(plugin: FakePlugin): Promise<PresenceRecord[]> {
  const { messages } = await plugin.fetchRecent({ topic: PRESENCE_TOPIC });
  return messages.map((m) => decodePresence(m.content)).filter((r): r is PresenceRecord => r != null);
}

async function beats(plugin: FakePlugin): Promise<PresenceKind[]> {
  return (await records(plugin)).map((r) => r.kind);
}

describe('presence loop', () => {
  let plugin: FakePlugin;
  beforeEach(async () => {
    vi.useFakeTimers();
    plugin = new FakePlugin();
    await plugin.connect({});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a single hello to the shared presence topic carrying the subscribed topics', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx', 'reviews']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
      instanceId: 'inst-a',
    });
    await vi.advanceTimersByTimeAsync(0); // flush the fire-and-forget hello
    const recs = await records(plugin);
    // One beat = ONE message total, even across a multi-topic allowlist.
    expect(recs).toHaveLength(1);
    // No post_topics ⇒ postTopics advertised as [].
    expect(recs[0]).toEqual({
      v: 2,
      kind: 'hello',
      at: NOW,
      topics: ['ctx', 'reviews'],
      postTopics: [],
      instanceId: 'inst-a',
    });
    await loop.stop();
  });

  it('stamps a stable per-process instanceId on every beat, defaulting to a fresh random id', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(30_000); // hello + one heartbeat
    const recs = await records(plugin);
    expect(recs).toHaveLength(2);
    const ids = new Set(recs.map((r) => r.instanceId));
    expect(ids.size).toBe(1); // one process ⇒ one id across all its beats
    expect([...ids][0]).not.toBe(''); // a real random id, not the anonymous sentinel
    await loop.stop();
  });

  it('advertises the post_topics reach (pattern sources) on every beat', async () => {
    const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*', 'general'] });
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), allow, {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(30_000); // hello + one heartbeat
    const recs = await records(plugin);
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.topics).toEqual(['ctx']);
      expect(r.postTopics).toEqual(['ctx-.*', 'general']);
    }
    await loop.stop();
  });

  it('posts a heartbeat every interval', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(30_000); // one interval
    expect(await beats(plugin)).toEqual(['hello', 'heartbeat']);
    await vi.advanceTimersByTimeAsync(30_000); // another
    expect(await beats(plugin)).toEqual(['hello', 'heartbeat', 'heartbeat']);
    await loop.stop();
  });

  it('posts goodbye on stop and cancels further heartbeats', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(0);
    await loop.stop();
    expect(await beats(plugin)).toEqual(['hello', 'goodbye']);
    // timer is cancelled: advancing produces no more beats
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await beats(plugin)).toEqual(['hello', 'goodbye']);
  });

  it('stop is idempotent', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(0);
    await loop.stop();
    await loop.stop();
    expect(await beats(plugin)).toEqual(['hello', 'goodbye']);
  });

  it('BUG-26 — goodbye is posted only AFTER an in-flight heartbeat settles (no post-goodbye heartbeat)', async () => {
    const deferred = new DeferredFakePlugin();
    await deferred.connect({});
    const loop = startPresenceLoop(deferred, asHandle('claude-a'), new Allowlist(['ctx']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
      instanceId: 'inst-a',
    });
    await vi.advanceTimersByTimeAsync(0); // flush the hello (not held)
    deferred.hold(); // arm the NEXT post — the heartbeat — to stall in flight
    await vi.advanceTimersByTimeAsync(30_000); // fire the heartbeat; its post now hangs
    const stopPromise = loop.stop(); // enqueues goodbye BEHIND the stalled heartbeat
    await Promise.resolve(); // give the chain a tick — goodbye must NOT slip ahead
    deferred.releaseHeld(); // let the stalled heartbeat settle
    await stopPromise; // ...then goodbye
    // Serialized chain ⇒ goodbye lands LAST, never before the released heartbeat.
    expect(await beats(deferred)).toEqual(['hello', 'heartbeat', 'goodbye']);
    // ...and the roster over the recorded beats reads the cleanly-stopped instance as offline.
    const { messages } = await deferred.fetchRecent({ topic: PRESENCE_TOPIC });
    const roster = computeRoster(messages, NOW, { ttlMs: 90_000, sinceMs: 600_000 });
    expect(roster.find((e) => e.handle === 'claude-a')?.online).toBe(false);
  });
});
