import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { SeenSet } from '../engine/seen-set.js';
import { asBackendMsgId, asHandle, asTopic } from '../message.js';
import { NoSuchTopicError } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { CHANNEL_NOTIFICATION_METHOD } from './channel-emit.js';
import { startPushLoop } from './push-loop.js';

interface Captured {
  method: string;
  params: { content: string; meta: Record<string, string> };
}

function fakeServer() {
  const calls: Captured[] = [];
  // emitChannel reaches the low-level Server via McpServer's `.server`, so nest the spy there.
  const server = {
    server: {
      notification: vi.fn((n: Captured) => {
        calls.push(n);
        return Promise.resolve();
      }),
    },
  } as unknown as McpServer;
  return { server, calls };
}

async function wired(opts: { mentionFilter: boolean; identity: string }) {
  const plugin = new FakePlugin();
  await plugin.connect({});
  const { server, calls } = fakeServer();
  const seen = new SeenSet();
  const allow = new Allowlist(['ctx']);
  await startPushLoop(server, plugin, allow, seen, {
    mentionFilter: opts.mentionFilter,
    identity: asHandle(opts.identity),
  });
  return { plugin, calls, seen };
}

describe('startPushLoop (core emit handler)', () => {
  it('emits a channel notification for a new message', async () => {
    const { plugin, calls } = await wired({ mentionFilter: false, identity: 'me' });
    await plugin.post(asTopic('ctx'), asHandle('bob'), 'hi');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe(CHANNEL_NOTIFICATION_METHOD);
    expect(calls[0]!.params.content).toBe('hi');
    expect(calls[0]!.params.meta.topic).toBe('ctx');
    expect(calls[0]!.params.meta.sender).toBe('bob');
  });

  it('dedups: a message already marked seen (e.g. via catch-up) is not pushed', async () => {
    const { plugin, calls, seen } = await wired({ mentionFilter: false, identity: 'me' });
    seen.markSeen(asTopic('ctx'), asBackendMsgId('1')); // pretend already pulled
    await plugin.post(asTopic('ctx'), asHandle('bob'), 'dup'); // becomes id 1
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it('mention filter: only messages mentioning identity are pushed', async () => {
    const { plugin, calls } = await wired({ mentionFilter: true, identity: 'agent' });
    await plugin.post(asTopic('ctx'), asHandle('bob'), 'nothing for me');
    await plugin.post(asTopic('ctx'), asHandle('bob'), 'ping @agent');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.params.content).toBe('ping @agent');
  });

  /**
   * `subscribe` is the other seam call seam.ts declares NoSuchTopicError for. A chat channel that
   * does not exist yet must cost that ONE topic its live path, not the whole attach; anything else
   * is a real failure and has to propagate.
   */
  describe('an absent topic loses only its own subscription', () => {
    async function wireOver(topics: string[], failOn: string, err: () => Error) {
      const plugin = new FakePlugin();
      await plugin.connect({});
      const subscribed: string[] = [];
      const orig = plugin.subscribe.bind(plugin);
      plugin.subscribe = async (topic, handler) => {
        if (topic === failOn) throw err();
        subscribed.push(topic);
        return orig(topic, handler);
      };
      const { server, calls } = fakeServer();
      const start = startPushLoop(server, plugin, new Allowlist(topics), new SeenSet(), {
        mentionFilter: false,
        identity: asHandle('me'),
      });
      return { plugin, subscribed, calls, start };
    }

    it.each([
      ['the FIRST topic', 'ctx'],
      ['a LATER topic', 'ops'],
    ])('NoSuchTopicError on %s still wires the others', async (_where, failOn) => {
      const others = ['ctx', 'ops'].filter((t) => t !== failOn);
      const { subscribed, calls, start, plugin } = await wireOver(
        ['ctx', 'ops'],
        failOn,
        () => new NoSuchTopicError(failOn),
      );
      await expect(start).resolves.toBeUndefined();
      expect(subscribed).toEqual(others);
      await plugin.post(asTopic(others[0]!), asHandle('bob'), 'still live');
      await vi.waitFor(() => expect(calls).toHaveLength(1));
    });

    it('a generic subscribe failure still fails the whole wiring', async () => {
      const { start } = await wireOver(['ctx', 'ops'], 'ops', () => new Error('subscribe boom'));
      await expect(start).rejects.toThrow(/subscribe boom/);
    });
  });
});
