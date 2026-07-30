import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { catchUpTopic } from '../engine/catchup.js';
import { DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message, type Topic } from '../message.js';
import { NoSuchTopicError, type BackendPlugin, type MessageHandler } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { memoryReadState } from '../testing/nonconformant.js';
import { CHANNEL_NOTIFICATION_METHOD } from './channel-emit.js';
import { startPushLoop } from './push-loop.js';
import { registerTools } from './tools.js';

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
   * The pull and push paths share ONE SeenSet precisely so a message the agent already read cannot
   * arrive again as a `<channel>` event. Only the catch-up leg of that warm-up was covered; the
   * `fetch_recent` TOOL's leg was pinned by `expect(deps.seen).toBe(seen)` — wiring, not behaviour —
   * so deleting its warm-up loop left every test green while re-pushing everything the agent pulled.
   *
   * Table the ORDERS the two delivery paths can run in for the same backendMsgId, driven through the
   * real tool and a plugin whose live delivery is deferred (a real backend's live hop lands after the
   * row is already fetchable). A pull AFTER a push legitimately re-reads history — what must never
   * happen is a push after a pull.
   */
  describe('the pull and push paths never deliver the same message twice', () => {
    const T = asTopic('ctx');

    /** A plugin that buffers live delivery so a message is fetchable BEFORE it is pushed. */
    async function deferredBus() {
      const backend = new FakePlugin();
      await backend.connect({});
      const buffered: Message[] = [];
      await backend.subscribe(T, (m) => buffered.push(m));
      let coreHandler: MessageHandler | undefined;
      const plugin = {
        connect: (c) => backend.connect(c),
        disconnect: () => backend.disconnect(),
        post: (t, i, c, o) => backend.post(t, i, c, o),
        fetchRecent: (a) => backend.fetchRecent(a),
        resolveIdentity: (h) => backend.resolveIdentity(h),
        subscribe: async (_topic: Topic, handler: MessageHandler) => {
          coreHandler = handler;
        },
      } as BackendPlugin;

      const seen = new SeenSet();
      const server = new McpServer({ name: 'parley', version: '0.0.0' }, { capabilities: { tools: {} } });
      registerTools(server, {
        plugin,
        identity: asHandle('agent'),
        allow: new Allowlist(['ctx'], { reserved: [DEFAULT_PRESENCE_TOPIC] }),
        seen,
        presenceTopic: asTopic(DEFAULT_PRESENCE_TOPIC),
        presenceTtlMs: 90_000,
        blockMaxMs: 1_000,
        blockPollIntervalMs: 20,
      });
      const emits = vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
      await startPushLoop(server, plugin, new Allowlist(['ctx']), seen, {
        mentionFilter: false,
        identity: asHandle('agent'),
      });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverT), client.connect(clientT)]);

      let pulled = 0;
      const readState = memoryReadState() as unknown as ReadStateStore;
      return {
        post: () => backend.post(T, asHandle('bob'), 'the one message'),
        deliver: () => {
          for (const m of buffered.splice(0)) coreHandler?.(m);
        },
        pull: async () => {
          const res = (await client.callTool({
            name: 'parley_fetch_recent',
            arguments: { topic: 'ctx' },
          })) as { content: Array<{ text: string }> };
          const out = JSON.parse(res.content[0]!.text) as { messages: unknown[] };
          pulled += out.messages.length;
        },
        catchup: async () => {
          await catchUpTopic({ plugin, topic: T, limit: 100, readState, seen });
        },
        emitCount: () => emits.mock.calls.filter((c) => (c[0] as { method: string }).method === CHANNEL_NOTIFICATION_METHOD).length,
        pulledCount: () => pulled,
        stop: async () => {
          await client.close();
          await backend.disconnect();
        },
      };
    }

    type Step = 'post' | 'pull' | 'deliver' | 'catchup';

    const ORDERS: Array<[name: string, steps: Step[], emits: number, pulls: number]> = [
      ['pulled by the tool, then delivered live', ['post', 'pull', 'deliver'], 0, 1],
      ['pulled by the tool twice, then delivered live', ['post', 'pull', 'pull', 'deliver'], 0, 2],
      ['drained by catch-up, then pulled, then delivered live', ['post', 'catchup', 'pull', 'deliver'], 0, 1],
      ['delivered live, then pulled, then delivered again', ['post', 'deliver', 'pull', 'deliver'], 1, 1],
      ['delivered live twice', ['post', 'deliver', 'deliver'], 1, 0],
    ];

    it.each(ORDERS)('%s', async (_name, steps, emits, pulls) => {
      const bus = await deferredBus();
      try {
        for (const step of steps) await bus[step]();
        await new Promise((r) => setTimeout(r, 20)); // let any emit settle
        expect(bus.emitCount()).toBe(emits);
        expect(bus.pulledCount()).toBe(pulls); // the row really did read the message it claims to
      } finally {
        await bus.stop();
      }
    });
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

/**
 * `m.topic` is a PLUGIN-supplied field that decides which `<channel topic=…>` the agent sees, and a
 * backend's subscribe primitive can be coarser than a topic — a NATS wildcard subject, a Matrix room
 * carrying several logical topics, a Zulip stream. Core enforces the allowlist on the SUBSCRIBE call;
 * without a re-check on delivery, an over-delivering plugin puts an unsubscribed topic (or a presence
 * beat, which DESIGN §14 says never surfaces as a `<channel>` event) straight into agent context.
 * Table what such a plugin can hand back, including near-misses that a loose comparison would admit.
 */
describe('a plugin that over-delivers cannot put an unsubscribed topic into the session', () => {
  /** A plugin whose subscribe only captures the handler, so the test decides what gets delivered. */
  async function capturing() {
    const plugin = new FakePlugin();
    await plugin.connect({});
    let deliver: MessageHandler | undefined;
    plugin.subscribe = async (_topic: Topic, handler: MessageHandler) => {
      deliver = handler;
    };
    const { server, calls } = fakeServer();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await startPushLoop(
      server,
      plugin,
      new Allowlist(['ctx'], { reserved: [DEFAULT_PRESENCE_TOPIC] }),
      new SeenSet(),
      { mentionFilter: false, identity: asHandle('me') },
    );
    let seq = 0;
    return {
      calls,
      errors,
      push: (topic: string) => {
        seq += 1;
        deliver?.({
          topic: asTopic(topic),
          senderHandle: asHandle('bob'),
          content: `body ${seq}`,
          timestamp: new Date(seq * 1000).toISOString(),
          backendMsgId: asBackendMsgId(String(seq)),
          cursor: asCursor(String(seq)),
          mentions: [],
        });
      },
    };
  }

  const DELIVERED: Array<[label: string, topic: string, emitted: boolean]> = [
    ['the subscribed topic', 'ctx', true],
    ['a sibling topic that was never allow-listed', 'ops-secret', false],
    ['the reserved presence topic', DEFAULT_PRESENCE_TOPIC, false],
    ['the subscribed topic in another case', 'CTX', false],
    ['the subscribed topic with trailing whitespace', 'ctx ', false],
    ['a topic that merely extends the subscribed one', 'ctx-other', false],
    ['the empty topic', '', false],
  ];

  it.each(DELIVERED)('%s is emitted: %s', async (_label, topic, emitted) => {
    const bus = await capturing();
    try {
      bus.push(topic);
      await new Promise((r) => setTimeout(r, 20));
      expect(bus.calls).toHaveLength(emitted ? 1 : 0);
      if (!emitted) expect(bus.errors).toHaveBeenCalled(); // the operator hears about it
    } finally {
      bus.errors.mockRestore();
    }
  });

  it('delivered all at once, exactly the subscribed topic reaches the session', async () => {
    const bus = await capturing();
    try {
      for (const [, topic] of DELIVERED) bus.push(topic);
      await new Promise((r) => setTimeout(r, 20));
      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0]!.params.meta.topic).toBe('ctx');
      // One warning for the whole loop: the topic string is untrusted, so a per-topic ledger would be
      // an unbounded map keyed by plugin input.
      expect(bus.errors).toHaveBeenCalledTimes(1);
    } finally {
      bus.errors.mockRestore();
    }
  });
});
