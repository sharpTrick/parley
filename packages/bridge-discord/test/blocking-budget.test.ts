import { asCursor, asTopic, type Cursor, type FetchRecentResult, type Topic } from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { PAGE_LIMIT, startFakeDiscord, type FakeDiscord } from './fake-discord.js';
import { settleOf, type Settlement } from './harness.js';

// CLASS: a bounded call that answers a REFUSAL it could have absorbed with a failure the agent
// reads as a broken backend. `fetchRecent` with a `blockMs` promises to settle inside it — core
// sizes that against the client's tool timeout — and the seam's answer when a leg cannot finish
// inside that budget is the empty REPLAYABLE page core polls on, not a rejection. Two ways to break
// it: run past the budget (an unbounded leg), or fail inside it (a refusal treated as fatal). One
// routine 429 does the second, and it gets worse as the budget drains, because core re-issues with
// `blockMs: remaining`.
//
// So the cells are over WHICH LEG is refused, HOW, and what the seam owes for that leg — and every
// one names its expected SETTLEMENT. A cell that graded elapsed time alone was satisfied by a call
// that threw.

const BLOCK_MS = 1500;
/** Orchestration and one localhost round trip; far below any unbounded leg's own wait. */
const SLACK_MS = 900;
/** A response that will not arrive inside a bounded call's budget. */
const stallFor = (budgetMs: number): number => budgetMs * 4 + 2000;

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

/**
 * What the seam owes a leg that could not finish. `empty` and `gathered` are the two replayable
 * answers — the caller's own position, or everything the walk did reach; `failure` is the answer a
 * read with NO replayable position can give, because there is no cursor it could hand back that
 * does not rewind the topic.
 */
type Owed = 'empty' | 'gathered' | 'failure';

interface Refusal {
  label: string;
  /** Script it at `path`, against a call whose whole budget is `budgetMs`. */
  inject: (fake: FakeDiscord, path: string, budgetMs: number) => void;
  /** A stall is only reachable by a call whose OWN budget ends before the provider answers. */
  boundedOnly?: boolean;
}

const REFUSALS: Refusal[] = [
  {
    label: 'a 429 asking for longer than the budget',
    inject: (fake, path, budgetMs) =>
      fake.injectFault({
        status: 429,
        body: { retry_after: (budgetMs * 4) / 1000 + 5 },
        path,
        times: 6,
      }),
  },
  {
    label: 'a 429 asking for less, over and over',
    inject: (fake, path) =>
      fake.injectFault({ status: 429, body: { retry_after: 0.05 }, path, times: 40 }),
  },
  {
    label: 'a response that never comes',
    boundedOnly: true,
    inject: (fake, path, budgetMs) =>
      fake.injectFault({ status: 200, body: [], path, delayMs: stallFor(budgetMs), times: 6 }),
  },
];

interface Cell {
  leg: string;
  /** The whole wall-clock budget the call under this cell runs under. */
  budgetMs: number;
  owed: Owed;
  /** Set up the refusal and start the call; resolves once it is under way. */
  start: (ctx: {
    fake: FakeDiscord;
    plugin: DiscordPlugin;
    topic: Topic;
    channelId: string;
    refuse: (path: string) => void;
  }) => Promise<{ settled: Promise<Settlement> }>;
  /** A gateway url other than the fake's, when the cell is about the connect leg. */
  gatewayUrl?: () => Promise<{ url: string; close: () => Promise<void> }>;
  /** Cells that script their own stall rather than taking one from {@link REFUSALS}. */
  refusals?: Refusal[];
}

const SINCE = asCursor('1');
const messagesOf = (channelId: string): string => `/channels/${channelId}/messages`;

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

/** A healthy first page, so the refusal that follows lands on a LATER page of the same walk. */
const OVER_ONE_PAGE = 250;
const servePageZero = (fake: FakeDiscord, channelId: string): void => {
  fake.injectFault({ status: 200, body: fullPage(channelId), path: messagesOf(channelId), times: 1 });
};

const CELLS: Cell[] = [
  {
    leg: 'the gateway connect',
    budgetMs: BLOCK_MS,
    owed: 'empty',
    gatewayUrl: blackHole,
    refusals: [
      {
        label: 'a socket that never answers the upgrade',
        inject: () => undefined,
      },
    ],
    start: async ({ plugin, topic }) => ({
      settled: settleOf(plugin.fetchRecent({ topic, since: SINCE, blockMs: BLOCK_MS })),
    }),
  },
  {
    leg: 'the first REST query of a blocking read',
    budgetMs: BLOCK_MS,
    owed: 'empty',
    start: async ({ plugin, topic, channelId, refuse }) => {
      refuse(messagesOf(channelId));
      return { settled: settleOf(plugin.fetchRecent({ topic, since: SINCE, blockMs: BLOCK_MS })) };
    },
  },
  {
    leg: 'the post-wake REST query of a blocking read',
    budgetMs: BLOCK_MS,
    owed: 'empty',
    start: async ({ fake, plugin, topic, channelId, refuse }) => {
      await plugin.subscribe(topic, () => undefined);
      const settled = settleOf(plugin.fetchRecent({ topic, since: SINCE, blockMs: BLOCK_MS }));
      // The waiter is armed once the first (empty) query has come back; only the SECOND is refused.
      await vi.waitFor(
        () => expect(fake.requestCount(messagesOf(channelId))).toBeGreaterThan(0),
        { timeout: 3000 },
      );
      refuse(messagesOf(channelId));
      fake.deliver(channelId, { content: 'wake up' });
      return { settled };
    },
  },
  {
    leg: 'a later page of a blocking walk',
    budgetMs: BLOCK_MS,
    owed: 'gathered',
    start: async ({ fake, plugin, topic, channelId, refuse }) => {
      servePageZero(fake, channelId);
      refuse(messagesOf(channelId));
      return {
        settled: settleOf(
          plugin.fetchRecent({ topic, since: SINCE, limit: OVER_ONE_PAGE, blockMs: BLOCK_MS }),
        ),
      };
    },
  },
  {
    leg: 'a later page of a catch-up walk',
    budgetMs: DEFAULT_DEADLINE_MS,
    owed: 'gathered',
    start: async ({ fake, plugin, topic, channelId, refuse }) => {
      servePageZero(fake, channelId);
      refuse(messagesOf(channelId));
      return {
        settled: settleOf(plugin.fetchRecent({ topic, since: SINCE, limit: OVER_ONE_PAGE })),
      };
    },
  },
  // The two reads with NO replayable position. A since-less read can only answer cursor '0', and
  // core adopts a returned cursor as the next `since` — so swallowing here would slide the topic
  // to the start of history and answer the OLDEST window to a caller who asked for the newest.
  {
    leg: 'the first REST query of a since-less blocking read',
    budgetMs: BLOCK_MS,
    owed: 'failure',
    start: async ({ plugin, topic, channelId, refuse }) => {
      refuse(messagesOf(channelId));
      return { settled: settleOf(plugin.fetchRecent({ topic, blockMs: BLOCK_MS })) };
    },
  },
  {
    leg: 'the first REST query of a catch-up walk',
    budgetMs: DEFAULT_DEADLINE_MS,
    owed: 'failure',
    start: async ({ plugin, topic, channelId, refuse }) => {
      refuse(messagesOf(channelId));
      return { settled: settleOf(plugin.fetchRecent({ topic, since: SINCE })) };
    },
  },
];

const resolvedPage = (outcome: Settlement): FetchRecentResult => {
  if (outcome.status === 'rejected') {
    return expect.fail(
      `the bounded call rejected where the seam owes a replayable page: ${String(outcome.error)}`,
    );
  }
  return outcome.value as FetchRecentResult;
};

function expectOwed(outcome: Settlement, owed: Owed): void {
  if (owed === 'failure') {
    if (outcome.status === 'resolved') {
      const { messages, nextCursor } = outcome.value as FetchRecentResult;
      return expect.fail(
        `a read with no replayable position answered ${messages.length} message(s) at cursor ` +
          `${String(nextCursor)}; core adopts that as the next since`,
      );
    }
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error), 'the failure never names the call').toContain('Discord');
    return;
  }
  const { messages, nextCursor } = resolvedPage(outcome);
  if (owed === 'empty') {
    expect(messages, 'a refused leg invented messages').toEqual([]);
    expect(nextCursor, 'the cursor moved off the position the caller must replay').toBe(SINCE);
    return;
  }
  expect(messages.length, 'the walk dropped the page it had already read').toBe(PAGE_LIMIT);
  expect(nextCursor, 'the cursor does not name the last message kept').toBe(messages.at(-1)?.cursor);
  expect(BigInt(nextCursor as string)).toBeGreaterThan(BigInt(SINCE as string));
}

describe('a bounded fetchRecent answers the seam when it is refused on', () => {
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
    const refusals = (cell.refusals ?? REFUSALS).filter(
      (r) => r.boundedOnly !== true || cell.budgetMs <= BLOCK_MS,
    );
    for (const refusal of refusals) {
      it(`${cell.leg} — ${refusal.label}`, async () => {
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
          const { settled } = await cell.start({
            fake,
            plugin,
            topic: asTopic(channelId),
            channelId,
            refuse: (path) => refusal.inject(fake, path, cell.budgetMs),
          });
          expectOwed(await settled, cell.owed);
          expect(
            Date.now() - started,
            'the call ran past the budget core sized for the tool timeout',
          ).toBeLessThanOrEqual(cell.budgetMs + SLACK_MS);
        } finally {
          await plugin.disconnect();
          await gateway?.close();
        }
      });
    }
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
    ['since', SINCE],
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
        const path = messagesOf(channelId);
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
          const outcome = await settleOf(
            plugin.fetchRecent({
              topic: asTopic(channelId),
              ...(since !== undefined ? { since } : {}),
              limit,
              blockMs: BLOCK_MS,
            }),
          );
          const elapsed = Date.now() - started;
          const queries = fake.requestCount(path);
          const { messages, nextCursor } = resolvedPage(outcome);

          expect(
            elapsed,
            'the walk ran past the budget core sized for the tool timeout',
          ).toBeLessThanOrEqual(BLOCK_MS + SLACK_MS);
          // A ceiling alone is satisfied by returning nothing at all, so each cell also pins that
          // the pages it could afford were actually walked, and that they crossed the seam.
          expect(messages.length, 'the walk answered no page at all').toBeGreaterThan(0);
          expect(nextCursor).toBe(messages.at(-1)?.cursor);
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
