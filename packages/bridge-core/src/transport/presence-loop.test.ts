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
 * synchronous (which is exactly why SQLite is immune to this race), so we need a genuinely async post
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
      handle: 'claude-a',
      topics: ['ctx', 'reviews'],
      postTopics: [],
      instanceId: 'inst-a',
    });
    await loop.stop();
  });

  /**
   * The roster keys on the handle INSIDE the record, because a backend is free not to carry the
   * posting identity. A beat that omits it degrades every session on such a backend into one
   * phantom peer, so require it on every kind of beat rather than on the hello alone.
   */
  it('stamps the emitting handle on every beat, whatever the backend attributes the post to', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      presenceTopic: PRESENCE_TOPIC,
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(30_000); // hello + one heartbeat
    await loop.stop(); // + goodbye
    const recs = await records(plugin);
    expect(recs.map((r) => r.kind)).toEqual(['hello', 'heartbeat', 'goodbye']);
    for (const r of recs) expect(r.handle).toBe('claude-a');
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

  /**
   * The default id exists for a property only observable ACROSS loops — a relaunched bridge must not
   * be reaped by the previous process's trailing `goodbye` — and every other case here injects one,
   * so a constant satisfied the whole file. Start several loops with no injected id, require the ids
   * to be pairwise distinct, then feed their REAL beats through computeRoster: with a shared id the
   * survivor's hello is clobbered and a live bridge reads offline for a full TTL window.
   */
  it.each([2, 3])(
    '%i loops with no injected instanceId mint distinct ids, so a relaunch outlives the old goodbye',
    async (n) => {
      const loops = Array.from({ length: n }, () =>
        startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
          presenceTopic: PRESENCE_TOPIC,
          heartbeatMs: 30_000,
          now: () => NOW,
        }),
      );
      await vi.advanceTimersByTimeAsync(0); // flush every hello
      const ids = new Set((await records(plugin)).map((r) => r.instanceId));
      expect(ids.size).toBe(n);
      expect(ids.has('')).toBe(false); // real ids, not the anonymous sentinel

      // The older processes exit only AFTER the newest has said hello — the relaunch overlap.
      for (const old of loops.slice(0, -1)) await old.stop();
      const { messages } = await plugin.fetchRecent({ topic: PRESENCE_TOPIC });
      expect(computeRoster(messages, NOW, { ttlMs: 90_000, sinceMs: 600_000 })).toEqual([
        { handle: 'claude-a', online: true, topics: ['ctx'], postTopics: [], lastSeenMs: NOW },
      ]);
      await loops.at(-1)!.stop();
    },
  );

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

  it('goodbye is posted only AFTER an in-flight heartbeat settles (no post-goodbye heartbeat)', async () => {
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

/**
 * `startPresenceLoop` is public API, so its cadence is whatever a caller passes; only core's config
 * schema guarantees a positive one. A clamp turned a degenerate cadence into a ~1 ms interval — a post
 * storm against the shared presence topic every peer reads — so the loop refuses it at the boundary
 * instead, and refuses it BEFORE announcing anything.
 */
describe('a degenerate heartbeat cadence is refused before the loop announces', () => {
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s', async (_name, heartbeatMs) => {
    const plugin = new FakePlugin();
    await plugin.connect({});
    expect(() =>
      startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
        presenceTopic: PRESENCE_TOPIC,
        heartbeatMs,
        now: () => NOW,
      }),
    ).toThrow(RangeError);
    // Real timers here: a clamped cadence would beat within a couple of ms of construction.
    await new Promise((r) => setTimeout(r, 20));
    expect(await beats(plugin)).toEqual([]); // no hello, so no peer ever saw it as reachable
  });
});
