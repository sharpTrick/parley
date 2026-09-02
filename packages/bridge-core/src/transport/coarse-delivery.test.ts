import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { catchUpTopic } from '../engine/catchup.js';
import { DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import { asBackendMsgId, asHandle, asTopic, type Message } from '../message.js';
import { coarseDelivery, FOREIGN_TOPIC_KINDS, memoryReadState } from '../testing/nonconformant.js';
import { registerTools, type ToolDeps } from './tools.js';
import { startPushLoop } from './push-loop.js';

/**
 * ONE trust boundary, graded at EVERY path that crosses it.
 *
 * `startPushLoop` re-checks `m.topic` against the subscribed set and calls that "a trust boundary,
 * not a redundancy" — a backend's delivery primitive can be coarser than a topic (a NATS wildcard
 * subject, a Matrix room carrying several logical topics), so DESIGN §14's "the bridge only ever
 * surfaces the topics it was configured for, and never a presence beat" has to be enforced in core.
 * It was enforced on the live path alone: `parley_fetch_recent` serialised the plugin's page
 * verbatim, so the same coarse plugin put `secret-ops` and `parley-presence` straight into the
 * agent's context — and recorded their `backendMsgId`s against the REQUESTED topic's dedup window,
 * where a later genuine push colliding with one is silently suppressed.
 *
 * So the table is over PATHS as well as payloads: a guard added to one sibling and not the other is
 * exactly the defect, and a per-path test cannot see it.
 */
describe('a delivery coarser than one topic is cut down at every path, not just the live one', () => {
  const SUBSCRIBED = 'ctx';
  const PATTERN = 'ctx-.*';

  function allowlist(): Allowlist {
    return new Allowlist([SUBSCRIBED], {
      postPatterns: [PATTERN],
      reserved: [DEFAULT_PRESENCE_TOPIC],
    });
  }

  /** The low-level `notification` sink `emitChannel` reaches through `McpServer.server`. */
  function channelSink(): { server: McpServer; topics: string[] } {
    const topics: string[] = [];
    const server = {
      server: {
        notification: vi.fn((n: { params: { meta: Record<string, string> } }) => {
          topics.push(n.params.meta.topic!);
          return Promise.resolve();
        }),
      },
    } as unknown as McpServer;
    return { server, topics };
  }

  async function toolTopics(name: string, args: Record<string, unknown>): Promise<string[]> {
    const { plugin } = coarseDelivery();
    const server = new McpServer({ name: 'parley', version: '0.1.0' }, { capabilities: { tools: {} } });
    const seen = new SeenSet();
    const deps: ToolDeps = {
      plugin,
      identity: asHandle('alice'),
      allow: allowlist(),
      seen,
      presenceTopic: asTopic(DEFAULT_PRESENCE_TOPIC),
      presenceTtlMs: 90_000,
      blockMaxMs: 60_000,
      blockPollIntervalMs: 20,
      now: undefined,
    };
    registerTools(server, deps);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    const body = JSON.parse(text) as { messages?: Message[]; users?: Array<{ handle: string }> };
    return (body.messages ?? []).map((m) => m.topic);
  }

  const PATHS: Array<[name: string, run: () => Promise<string[]>]> = [
    [
      'the live push loop',
      async () => {
        const { plugin, push } = coarseDelivery();
        const { server, topics } = channelSink();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await startPushLoop(server, plugin, allowlist(), new SeenSet(), {
            mentionFilter: false,
            identity: asHandle('alice'),
          });
          push(SUBSCRIBED, 1);
          for (const [, t] of FOREIGN_TOPIC_KINDS) push(t, 2);
          await vi.waitFor(() => expect(topics.length).toBeGreaterThan(0));
          return topics;
        } finally {
          errors.mockRestore();
        }
      },
    ],
    [
      'parley_fetch_recent',
      async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          return await toolTopics('parley_fetch_recent', { topic: SUBSCRIBED });
        } finally {
          errors.mockRestore();
        }
      },
    ],
  ];

  it.each(PATHS)('%s surfaces only the topic that was asked for', async (_name, run) => {
    const topics = await run();
    expect(
      [...new Set(topics)],
      'a topic core never subscribed to reached the agent through this path',
    ).toEqual([SUBSCRIBED]);
  });

  /**
   * `parley_list_users` reads the PRESENCE topic, so what is foreign to it is every real topic — a
   * message on one that happens to decode as a beat must mint no peer.
   */
  const FOREIGN_TO_PRESENCE: Array<[name: string, topic: string]> = [
    ['the caller’s own subscribed topic', SUBSCRIBED],
    ...FOREIGN_TOPIC_KINDS.filter(([, t]) => t !== DEFAULT_PRESENCE_TOPIC),
  ];

  it.each(FOREIGN_TO_PRESENCE)(
    'parley_list_users mints no peer from %s carried alongside the beats',
    async (_name, topic) => {
      const { plugin } = coarseDelivery([SUBSCRIBED]);
      const beat = JSON.stringify({
        v: 2,
        kind: 'hello',
        at: Date.now(),
        handle: 'phantom',
        topics: [SUBSCRIBED],
        postTopics: [],
        instanceId: 'i-1',
      });
      const original = plugin.fetchRecent.bind(plugin);
      plugin.fetchRecent = async (args) => {
        const page = await original(args);
        return {
          ...page,
          messages: page.messages.map((m) =>
            m.topic === (topic as Message['topic']) ? { ...m, content: beat } : m,
          ),
        };
      };
      const server = new McpServer({ name: 'p', version: '0.1.0' }, { capabilities: { tools: {} } });
      const deps: ToolDeps = {
        plugin,
        identity: asHandle('alice'),
        allow: allowlist(),
        seen: new SeenSet(),
        presenceTopic: asTopic(DEFAULT_PRESENCE_TOPIC),
        presenceTtlMs: 90_000,
        blockMaxMs: 60_000,
        blockPollIntervalMs: 20,
        now: undefined,
      };
      registerTools(server, deps);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '0.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      const res = await client.callTool({ name: 'parley_list_users', arguments: {} });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
        users: Array<{ handle: string }>;
      };
      expect(
        body.users.map((u) => u.handle),
        'a message off the presence topic was folded into the roster',
      ).not.toContain('phantom');
    },
  );

  /**
   * The same page also warms a per-topic dedup window. A foreign message's `backendMsgId` recorded
   * under the REQUESTED topic makes the next genuine live push carrying that id vanish, so this is a
   * correctness leak of the boundary even where nothing reaches the agent.
   */
  it.each([
    [
      'parley_fetch_recent',
      async (seen: SeenSet): Promise<void> => {
        const { plugin } = coarseDelivery();
        const server = new McpServer({ name: 'p', version: '0.1.0' }, { capabilities: { tools: {} } });
        const deps: ToolDeps = {
          plugin,
          identity: asHandle('alice'),
          allow: allowlist(),
          seen,
          presenceTopic: asTopic(DEFAULT_PRESENCE_TOPIC),
          presenceTtlMs: 90_000,
          blockMaxMs: 60_000,
          blockPollIntervalMs: 20,
          now: undefined,
        };
        registerTools(server, deps);
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '0.0.0' }, { capabilities: {} });
        await Promise.all([server.connect(serverT), client.connect(clientT)]);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: SUBSCRIBED } });
        } finally {
          errors.mockRestore();
        }
      },
    ],
    [
      'cold-start catch-up',
      async (seen: SeenSet): Promise<void> => {
        const { plugin } = coarseDelivery();
        await catchUpTopic({
          plugin,
          topic: asTopic(SUBSCRIBED),
          seen,
          readState: memoryReadState() as unknown as ReadStateStore,
          limit: 10,
        });
      },
    ],
  ])('%s never records a foreign message id against the requested topic', async (_name, run) => {
    const seen = new SeenSet();
    await run(seen);
    for (const [kind] of FOREIGN_TOPIC_KINDS.entries()) {
      expect(
        seen.firstSeen(asTopic(SUBSCRIBED), asBackendMsgId(String(kind + 2))),
        'a foreign message id was already burned into this topic’s dedup window',
      ).toBe(true);
    }
  });
});
