import { asCursor, asTopic, type Topic } from '@sharptrick/parley-core';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';

// CLASS: a call that overruns its own declared budget on a leg nobody bounded. `fetchRecent` with a
// `blockMs` promises to settle inside it — core sizes that against the client's tool timeout — but
// the promise only holds for the legs that carry a deadline. Wrapping the gateway connect and
// leaving the two REST queries on net-util's 30 s default let ONE call run 40x its budget on a
// routine rate limit. So the cells are over WHICH LEG stalls and HOW, and every one asserts the
// same thing: the call settles, either way, inside the budget it was given.

const BLOCK_MS = 1500;
/** Orchestration and one localhost round trip; far below any unbounded leg's own wait. */
const SLACK_MS = 900;
/** A stated 429 wait no sane budget can absorb — net-util must refuse it, not sleep it. */
const HINT_S = 20;
/** A response that will not arrive inside the budget. */
const STALL_MS = 8000;

let seq = 0;
const freshChannelId = (): string =>
  String(780_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

/** A TCP listener that accepts the connection and never answers the websocket upgrade. */
async function blackHole(): Promise<{ url: string; close: () => Promise<void> }> {
  const held: Socket[] = [];
  const server: Server = createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Cell {
  leg: string;
  stall: string;
  /** Set up the stall and start the call; resolves once it is under way. */
  start: (ctx: {
    fake: FakeDiscord;
    plugin: DiscordPlugin;
    topic: Topic;
    channelId: string;
  }) => Promise<{ settled: Promise<unknown> }>;
  /** A gateway url other than the fake's, when the cell is about the connect leg. */
  gatewayUrl?: () => Promise<{ url: string; close: () => Promise<void> }>;
}

const settle = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => 'resolved',
    () => 'rejected',
  );

const STALLS: Array<[string, (fake: FakeDiscord, path: string) => void]> = [
  [
    `a 429 asking for ${HINT_S}s`,
    (fake, path) =>
      fake.injectFault({ status: 429, body: { retry_after: HINT_S }, path, times: 4 }),
  ],
  [
    'a response that never comes',
    (fake, path) => fake.injectFault({ status: 200, body: [], path, delayMs: STALL_MS, times: 4 }),
  ],
];

const CELLS: Cell[] = [
  {
    leg: 'the gateway connect',
    stall: 'a socket that never answers the upgrade',
    gatewayUrl: blackHole,
    start: async ({ plugin, topic }) => ({
      settled: settle(plugin.fetchRecent({ topic, since: asCursor('1'), blockMs: BLOCK_MS })),
    }),
  },
  ...STALLS.map(([label, inject]): Cell => ({
    leg: 'the first REST query',
    stall: label,
    start: async ({ fake, plugin, topic, channelId }) => {
      inject(fake, `/channels/${channelId}/messages`);
      return {
        settled: settle(plugin.fetchRecent({ topic, since: asCursor('1'), blockMs: BLOCK_MS })),
      };
    },
  })),
  ...STALLS.map(([label, inject]): Cell => ({
    leg: 'the post-wake REST query',
    stall: label,
    start: async ({ fake, plugin, topic, channelId }) => {
      await plugin.subscribe(topic, () => undefined);
      const settled = settle(
        plugin.fetchRecent({ topic, since: asCursor('1'), blockMs: BLOCK_MS }),
      );
      // The waiter is armed once the first (empty) query has come back; only the SECOND query stalls.
      await vi.waitFor(
        () => expect(fake.requestCount(`/channels/${channelId}/messages`)).toBeGreaterThan(0),
        { timeout: 3000 },
      );
      inject(fake, `/channels/${channelId}/messages`);
      fake.deliver(channelId, { content: 'wake up' });
      return { settled };
    },
  })),
];

describe('a blocking fetchRecent settles inside blockMs when it stalls on', () => {
  let fake: FakeDiscord;

  beforeEach(async () => {
    fake = await startFakeDiscord();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => {
    await fake.close();
    vi.restoreAllMocks();
  });

  for (const cell of CELLS) {
    it(`${cell.leg} — ${cell.stall}`, async () => {
      const channelId = freshChannelId();
      fake.createChannel(channelId);
      const gateway = await cell.gatewayUrl?.();
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 'fake-token',
        api_url: fake.apiUrl,
        gateway_url: gateway?.url ?? fake.gatewayUrl,
        // Far out, so that only the call's OWN budget can end a stalled handshake.
        handshake_timeout_ms: 120_000,
      });

      try {
        const started = Date.now();
        const { settled } = await cell.start({ fake, plugin, topic: asTopic(channelId), channelId });
        await settled;
        expect(
          Date.now() - started,
          'the call ran past the budget core sized for the tool timeout',
        ).toBeLessThanOrEqual(BLOCK_MS + SLACK_MS);
      } finally {
        await plugin.disconnect();
        await gateway?.close();
      }
    });
  }
});
