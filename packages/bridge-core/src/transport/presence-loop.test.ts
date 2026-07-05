import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { decodePresence, type PresenceKind, type PresenceRecord } from '../engine/presence.js';
import { asHandle, asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startPresenceLoop } from './presence-loop.js';

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
});
