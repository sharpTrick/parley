import { asCursor, asHandle, asTopic, type Cursor } from '@sharptrick/parley-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';
import { settleOf, type Settlement } from './harness.js';

/**
 * CLASS: a numeric seam argument that reaches DEADLINE arithmetic with no finiteness floor.
 * `FetchRecentArgs` declares `blockMs?: number` and `limit?: number` with no bound, and this plugin
 * turns `blockMs` into the one absolute `deadline` shared by the connect race, the long-poll waiter
 * and every page's own budget. A non-finite budget is neither `> 0` nor `<= 0`, so EVERY comparison
 * drawn from it answers false: the call holds the caller for a default it never asked for, or hands
 * `Infinity` to a timer, which throws a RangeError out of a seam method that owes a page.
 *
 * Neither shows up in a returned page, so the rows below grade the two things only a budget can
 * break: whether the call SETTLES inside a ceiling of this table's own choosing, and how many REST
 * reads it spent getting there. Each row then replays the topic, so a clamp that settles by
 * answering nothing at all — and losing the history behind it — cannot pass either.
 *
 * The live-socket axis is load-bearing: the waiter is only armed when the gateway is up, and it is
 * the waiter that a budget nothing can compare against parks on.
 */

/** Longer than any budget a row asks for, and far below the unbounded default one row used to take. */
const SETTLE_MS = 2500;
/** The largest REAL budget in the table: long enough to arm a waiter, short enough to be free. */
const REAL_BUDGET_MS = 60;
const SEEDED = ['m0', 'm1', 'm2'];
const WRITER = asHandle('writer');

const PENDING = { status: 'pending' } as const;
type Observed = Settlement | typeof PENDING;

/** The settlement, or the fact that the ceiling arrived first — never a hang for vitest to name. */
async function observedWithin(call: Promise<unknown>, ms: number): Promise<Observed> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<Observed>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([settleOf(call), ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

const BLOCK_ROWS: Array<[string, number]> = [
  ['NaN', Number.NaN],
  ['+Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['0', 0],
  [String(REAL_BUDGET_MS), REAL_BUDGET_MS],
];
const LIMIT_ROWS: Array<[string, number | undefined]> = [
  ['NaN', Number.NaN],
  ['+Infinity', Number.POSITIVE_INFINITY],
  ['0', 0],
  ['default', undefined],
];
const SINCE_MODES = ['tail', 'zero', 'none'] as const;

let seq = 0;
const freshChannelId = (): string =>
  String(795_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

describe('discord fetchRecent settles on every numeric seam argument, at bounded read cost', () => {
  let fake: FakeDiscord;

  beforeAll(async () => {
    fake = await startFakeDiscord();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [blockLabel, blockMs] of BLOCK_ROWS) {
    for (const [limitLabel, limit] of LIMIT_ROWS) {
      for (const sinceMode of SINCE_MODES) {
        for (const live of [true, false]) {
          it(`blockMs=${blockLabel} / limit=${limitLabel} / since=${sinceMode} / gateway ${live ? 'up' : 'down'}`, async () => {
            const channelId = freshChannelId();
            fake.createChannel(channelId);
            const topic = asTopic(channelId);
            const path = `/channels/${channelId}/messages`;
            const plugin = new DiscordPlugin();
            await plugin.connect({
              token: 'fake-token',
              api_url: fake.apiUrl,
              gateway_url: fake.gatewayUrl,
              handshake_timeout_ms: 120_000,
            });

            try {
              let tail: Cursor = asCursor('0');
              for (const text of SEEDED) tail = asCursor(String(await plugin.post(topic, WRITER, text)));
              if (live) await plugin.subscribe(topic, () => undefined);

              const since = { tail, zero: asCursor('0'), none: undefined }[sinceMode];
              const before = fake.requestCount(path);
              const observed = await observedWithin(
                plugin.fetchRecent({
                  topic,
                  blockMs,
                  ...(limit === undefined ? {} : { limit }),
                  ...(since === undefined ? {} : { since }),
                }),
                SETTLE_MS,
              );
              const reads = fake.requestCount(path) - before;

              expect(
                observed.status,
                `one fetchRecent owes a page inside ${SETTLE_MS}ms, and answered neither`,
              ).toBe('resolved');
              // The exclusive query, plus the one re-query a woken waiter may run. A budget the
              // plugin cannot reason about spends this without limit, on a channel it re-reads.
              const budgeted = Number.isFinite(blockMs) && blockMs > 0;
              expect(reads, 'REST reads for one call').toBeLessThanOrEqual(budgeted ? 3 : 2);

              // A settlement that swallowed the topic is no answer: what the degenerate call
              // withheld must still be reachable from the position it was given.
              const replay = await plugin.fetchRecent({ topic, since: asCursor('0'), limit: 50 });
              expect(replay.messages.map((m) => m.content)).toEqual(SEEDED);
            } finally {
              await plugin.disconnect();
            }
          });
        }
      }
    }
  }
});
