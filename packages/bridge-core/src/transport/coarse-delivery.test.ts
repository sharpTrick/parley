import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { catchUpTopic } from '../engine/catchup.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { LiveDeliveryLedger } from '../engine/live-delivery.js';
import { SeenSet } from '../engine/seen-set.js';
import { fetchRecentBlocking } from '../engine/blocking-fetch.js';
import { asBackendMsgId, asHandle, asTopic, type Message } from '../message.js';
import { coarseDelivery, FOREIGN_TOPIC_KINDS, memoryReadState } from '../test-support/nonconformant.js';
import { registerTools, type ToolDeps } from './tools.js';
import { startPushLoop } from './push-loop.js';

/**
 * ONE trust boundary, graded at EVERY path that crosses it.
 *
 * `startPushLoop` re-checks `m.topic` against the subscribed set and calls that "a trust boundary,
 * not a redundancy" — a backend's delivery primitive can be coarser than a topic (a NATS wildcard
 * subject, a Matrix room carrying several logical topics), so DESIGN §14's "the bridge only ever
 * surfaces the topics it was configured for" has to be enforced in core. It was enforced on the
 * live path alone: `parley_fetch_recent` serialised the plugin's page verbatim, so the same coarse
 * plugin put `secret-ops` straight into the agent's context — and recorded its
 * `backendMsgId` against the REQUESTED topic's dedup window,
 * where a later genuine push colliding with one is silently suppressed.
 *
 * So the table is over PATHS as well as payloads: a guard added to one sibling and not the other is
 * exactly the defect, and a per-path test cannot see it.
 */
describe('a delivery coarser than one topic is cut down at every path, not just the live one', () => {
  const SUBSCRIBED = 'ctx';
  const PATTERN = 'ctx-.*';

  function allowlist(): Allowlist {
    return new Allowlist([SUBSCRIBED], { postPatterns: [PATTERN] });
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
      blockMaxMs: 60_000,
      blockPollIntervalMs: 20,
      live: new LiveDeliveryLedger([asTopic(SUBSCRIBED)]),
    };
    registerTools(server, deps);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    const body = JSON.parse(text) as { messages?: Message[] };
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
            live: new LiveDeliveryLedger([asTopic(SUBSCRIBED)]),
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
    [
      'parley_fetch_recent holding a long poll',
      async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          return await toolTopics('parley_fetch_recent', { topic: SUBSCRIBED, block_ms: 100 });
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
          blockMaxMs: 60_000,
          blockPollIntervalMs: 20,
          live: new LiveDeliveryLedger([asTopic(SUBSCRIBED)]),
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

  /**
   * The long poll decides ARRIVAL from the same page. A page of purely foreign traffic is what the
   * caller's filter then empties, so counting it as arrival hands the agent an empty answer one
   * millisecond in and turns `block_ms` back into a single fetch — the token burn the field exists
   * to prevent, once per message anybody posts to the shared room.
   *
   * Driven on an injected clock, so the row grades the number of polls rather than a wall clock.
   */
  const BUDGET_MS = 1_000;
  const CADENCE_MS = 250;

  function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it.each([
    ['a page carrying the requested topic', true, 1],
    ['a page carrying only other topics', false, BUDGET_MS / CADENCE_MS + 1],
  ])('%s is arrival only when it carries that topic', async (_name, carryOwn, expectedPolls) => {
    const { plugin } = coarseDelivery([], { carryOwn });
    let polls = 0;
    const inner = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (a) => {
      polls++;
      return inner(a);
    };
    const { now, sleep } = virtualClock();
    const page = await fetchRecentBlocking(
      plugin,
      { topic: asTopic(SUBSCRIBED) },
      { blockMs: BUDGET_MS, pollIntervalMs: CADENCE_MS, now, sleep },
    );
    expect(polls, 'the long poll was ended by traffic that is not the caller’s').toBe(expectedPolls);
    expect(page.messages.some((m) => m.topic === asTopic(SUBSCRIBED))).toBe(carryOwn);
  });
});
