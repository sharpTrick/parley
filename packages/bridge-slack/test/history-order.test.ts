/**
 * CLASS: a walk that reads POSITION in a vendor-controlled response body as AGE.
 *
 * `conversations.history` is documented newest-first, and `runFetch` spends that ordering three
 * times over: it breaks early once it holds `limit` (the head of the walk is the newest), it trims
 * the O(limit) buffer from the FRONT (the front is the newest), and it publishes the tail of the
 * result as `nextCursor`. Ordering is a property of a body the vendor writes, not of the call, so
 * every one of those is a claim the plugin must check rather than assume — the same lens under which
 * `MAX_HISTORY_PAGES` and the repeated-cursor guard throw instead of breaking.
 *
 * The failure this grades is silent and terminal: a walk that mis-reads age returns a window from
 * the wrong end of the channel AND publishes a cursor above it, so the skipped span sits below the
 * stored cursor where no later catch-up ever returns for it.
 *
 * The table crosses every ordering a server can serve with both walk branches, at depths above and
 * below the trim threshold. The rule each row is held to is deliberately NOT "throws": it is
 * `refuse-or-be-right`. A later round is free to make the walk genuinely order-independent, or to
 * re-sort, or to keep refusing — this file passes for all three and fails only for the one outcome
 * that is never acceptable, a wrong window returned as if it were right. Every backend that pages a
 * remote history owes the same property; this is the Slack instance of it.
 */
import { asCursor, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { compareTs, HISTORY_PAGE_LIMIT, SlackPlugin } from '../src/index.js';
import type { HistoryOrder } from './fake-slack.js';
import { startSlack } from './harness.js';

const ORDERS: HistoryOrder[] = ['newest-first', 'oldest-first', 'page-reversed', 'shuffled'];
const LIMITS = [1, 5, 100];
const SINCE_MODES = ['none', 'zero', 'mid'] as const;
const PAGE_SIZE = 50;

/**
 * Depths either side of the O(limit) trim: `shallow` never fills the retained buffer, so only the
 * early break can misread age; `deep` overruns `limit + HISTORY_PAGE_LIMIT`, which is the only depth
 * at which the trim discards anything at all. A table that stayed shallow graded half the walk.
 */
const DEPTHS = [
  { name: 'shallow', n: 60 },
  { name: 'deep', n: HISTORY_PAGE_LIMIT + 300 },
];

type Outcome = { kind: 'returned'; contents: string[]; next: string } | { kind: 'refused' };

async function fetchOutcome(
  plugin: SlackPlugin,
  topic: Topic,
  since: Cursor | undefined,
  limit: number,
): Promise<Outcome> {
  try {
    const page = await plugin.fetchRecent(
      since === undefined ? { topic, limit } : { topic, since, limit },
    );
    return {
      kind: 'returned',
      contents: page.messages.map((m) => m.content),
      next: String(page.nextCursor),
    };
  } catch {
    return { kind: 'refused' };
  }
}

describe('slack history walk refuses an ordering it cannot read, or reads it correctly', () => {
  for (const order of ORDERS) {
    for (const depth of DEPTHS) {
      for (const sinceMode of SINCE_MODES) {
        for (const limit of LIMITS) {
          it(`${order} / ${depth.name} / since=${sinceMode} / limit=${limit}`, async () => {
            const { fake, plugin, cleanup } = await startSlack({
              appToken: null,
              pageSize: PAGE_SIZE,
              arm: (f) => f.setHistoryOrder(order),
            });
            try {
              const topic = asTopic('C0ORDER');
              const seeded = fake.seed(
                topic,
                Array.from({ length: depth.n }, (_, i) => ({ text: `m${i}` })),
              );
              const midTs = seeded[Math.floor(seeded.length / 2)]!.ts;
              const since =
                sinceMode === 'none' ? undefined : asCursor(sinceMode === 'zero' ? '0' : midTs);

              const outcome = await fetchOutcome(plugin, topic, since, limit);

              // Without `since` the window is the NEWEST `limit`; with one, the OLDEST `limit`
              // strictly above the floor. Both are computed from the seed, never from the response.
              const above =
                since === undefined
                  ? seeded
                  : seeded.filter((m) => compareTs(m.ts, String(since)) > 0);
              const expected =
                since === undefined ? above.slice(-limit) : above.slice(0, limit);

              if (outcome.kind === 'refused') return;
              expect(outcome.contents, 'window').toEqual(expected.map((m) => m.text));
              expect(outcome.next, 'published cursor').toBe(expected.at(-1)!.ts);
            } finally {
              await cleanup();
            }
          });
        }
      }
    }
  }

  /**
   * `refuse-or-be-right` is satisfied by a plugin that refuses EVERYTHING, so the ordering Slack
   * actually documents is pinned separately: it must be served, and served in full. Without this row
   * the table above would green a walk that had stopped working altogether.
   */
  for (const depth of DEPTHS) {
    it(`the documented ordering is answered, not refused (${depth.name})`, async () => {
      const { fake, plugin, cleanup } = await startSlack({ appToken: null, pageSize: PAGE_SIZE });
      try {
        const topic = asTopic('C0DOCUMENTED');
        const seeded = fake.seed(
          topic,
          Array.from({ length: depth.n }, (_, i) => ({ text: `m${i}` })),
        );

        // Drain on `nextCursor` exactly as core's catch-up does: a cursor that steps over unread
        // history shows up here as messages that never arrive, which a single call cannot see.
        const seen: string[] = [];
        let cursor: Cursor = asCursor('0');
        for (let i = 0; i < 500; i++) {
          const page = await plugin.fetchRecent({ topic, since: cursor, limit: 25 });
          cursor = page.nextCursor;
          if (page.messages.length === 0) break;
          seen.push(...page.messages.map((m) => m.content));
        }

        expect(seen).toEqual(seeded.map((m) => m.text));
        expect(String(cursor)).toBe(seeded.at(-1)!.ts);
      } finally {
        await cleanup();
      }
    });
  }
});
