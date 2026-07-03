import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { decodePresence, presenceTopicFor, type PresenceKind } from '../engine/presence.js';
import { asHandle, asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startPresenceLoop } from './presence-loop.js';

const NOW = 1_000_000;

async function beats(plugin: FakePlugin, realTopic: string): Promise<PresenceKind[]> {
  const { messages } = await plugin.fetchRecent({ topic: presenceTopicFor(asTopic(realTopic)) });
  return messages.map((m) => decodePresence(m.content)?.kind).filter((k): k is PresenceKind => k != null);
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

  it('posts hello to each allowlisted topic’s presence stream on start', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx', 'reviews']), {
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(0); // flush the fire-and-forget hello
    expect(await beats(plugin, 'ctx')).toEqual(['hello']);
    expect(await beats(plugin, 'reviews')).toEqual(['hello']);
    await loop.stop();
  });

  it('posts a heartbeat every interval', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(30_000); // one interval
    expect(await beats(plugin, 'ctx')).toEqual(['hello', 'heartbeat']);
    await vi.advanceTimersByTimeAsync(30_000); // another
    expect(await beats(plugin, 'ctx')).toEqual(['hello', 'heartbeat', 'heartbeat']);
    await loop.stop();
  });

  it('posts goodbye on stop and cancels further heartbeats', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(0);
    await loop.stop();
    expect(await beats(plugin, 'ctx')).toEqual(['hello', 'goodbye']);
    // timer is cancelled: advancing produces no more beats
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await beats(plugin, 'ctx')).toEqual(['hello', 'goodbye']);
  });

  it('stop is idempotent', async () => {
    const loop = startPresenceLoop(plugin, asHandle('claude-a'), new Allowlist(['ctx']), {
      heartbeatMs: 30_000,
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(0);
    await loop.stop();
    await loop.stop();
    expect(await beats(plugin, 'ctx')).toEqual(['hello', 'goodbye']);
  });
});
