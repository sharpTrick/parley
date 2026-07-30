import { asCursor, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { PAGE_LIMIT, startFakeDiscord, type FakeDiscord } from './fake-discord.js';

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

// CLASS: a bound expressed as a per-attempt DURATION inside a loop that repeats the attempt. The
// cells above all fit in one REST page, so the paging loop is invisible to them — and a duration
// handed unchanged to each page restarts the clock on every round trip, so `limit` alone multiplies
// the budget the caller set. `limit` is a model-supplied knob (core clamps it at 1000), so one tool
// call could occupy 10x the wait core sized for the client's tool timeout. The axis is therefore
// LIMIT, crossed with whether the read is a catch-up (`since`) or the default window.

/** Strictly below BLOCK_MS: one page always fits, so only the PAGING can overrun the budget. */
const PAGE_DELAY_MS = 200;
/** Pages needed for `limit` when every page comes back full. */
const pagesFor = (limit: number): number => Math.ceil(limit / PAGE_LIMIT);

describe('a blocking fetchRecent spends ONE budget across every page it walks', () => {
  let fake: FakeDiscord;

  beforeEach(async () => {
    fake = await startFakeDiscord();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => {
    await fake.close();
    vi.restoreAllMocks();
  });

  const POSITIONS: Array<[string, Cursor | undefined]> = [
    ['since', asCursor('1')],
    ['no since', undefined],
  ];
  const LIMITS = [1, PAGE_LIMIT, PAGE_LIMIT + 1, 3 * PAGE_LIMIT, 1000];

  for (const [position, since] of POSITIONS) {
    for (const limit of LIMITS) {
      const pages = pagesFor(limit);
      const fits = pages * PAGE_DELAY_MS < BLOCK_MS;
      it(`${position}, limit ${limit} (${pages} full page${pages === 1 ? '' : 's'})`, async () => {
        const channelId = freshChannelId();
        fake.createChannel(channelId);
        const path = `/channels/${channelId}/messages`;
        // Every page comes back FULL and slow, so the walk is forced to keep going.
        fake.injectFault({
          status: 200,
          body: fullPage(channelId),
          path,
          delayMs: PAGE_DELAY_MS,
          times: 2 * pages + 2,
        });

        const plugin = new DiscordPlugin();
        await plugin.connect({
          token: 'fake-token',
          api_url: fake.apiUrl,
          gateway_url: fake.gatewayUrl,
          handshake_timeout_ms: 120_000,
        });
        try {
          const started = Date.now();
          await settle(
            plugin.fetchRecent({
              topic: asTopic(channelId),
              ...(since !== undefined ? { since } : {}),
              limit,
              blockMs: BLOCK_MS,
            }),
          );
          const elapsed = Date.now() - started;
          const queries = fake.requestCount(path);

          expect(
            elapsed,
            'the walk ran past the budget core sized for the tool timeout',
          ).toBeLessThanOrEqual(BLOCK_MS + SLACK_MS);
          // A ceiling alone is satisfied by returning nothing at all, so each cell also pins that
          // the pages it could afford were actually walked.
          if (fits) {
            expect(queries, 'the walk stopped short of the pages it had budget for').toBe(pages);
            expect(elapsed).toBeGreaterThanOrEqual(pages * PAGE_DELAY_MS * 0.8);
          } else {
            expect(queries, 'the budget never cut the walk short').toBeLessThan(pages);
            expect(elapsed).toBeGreaterThanOrEqual(BLOCK_MS * 0.7);
          }
        } finally {
          await plugin.disconnect();
        }
      });
    }
  }
});

/** A full `GET .../messages` page, newest-first as Discord returns it. */
function fullPage(channelId: string): unknown[] {
  return Array.from({ length: PAGE_LIMIT }, (_, i) => ({
    id: String(300_000_000_000_000 + i),
    channel_id: channelId,
    content: `m${i}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    author: { id: '5', username: 'human' },
  })).reverse();
}
