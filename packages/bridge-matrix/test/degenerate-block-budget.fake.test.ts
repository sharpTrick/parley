import { asCursor, asHandle, asTopic, type Cursor } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a numeric seam argument that reaches DEADLINE arithmetic with no finiteness floor.
 * `FetchRecentArgs` declares `blockMs?: number` and `limit?: number` with no bound, and this plugin
 * spends `blockMs` on two independent parks — one waiting for a peer to provision the room, one
 * waiting for a belonging event in it — each of which ends ONLY by comparing a remaining budget
 * against zero. A non-finite budget is neither `> 0` nor `<= 0`, so every such comparison answers
 * false and neither park can reach its own exit.
 *
 * A returned page cannot show that, so the rows below grade the two things a budget alone decides:
 * whether the call SETTLES inside a ceiling this table chooses, and what it spent on the homeserver
 * getting there — the second because a slice derived from `NaN` collapses to a bare tick, which
 * turns an idle wait into hundreds of `/sync`, `/context` and `/messages` requests per second.
 *
 * The room axis is load-bearing: an unprovisioned topic is the one that reaches the FIRST park, and
 * a table that only ever reads a room that already exists never enters it.
 */

/** Longer than any budget a row asks for, and short enough that a park with no exit is still red. */
const SETTLE_MS = 2000;
/** The largest REAL budget in the table: long enough to park, short enough to be free. */
const REAL_BUDGET_MS = 60;
const SEEDED = ['m0', 'm1', 'm2'];
const WRITER = asHandle('writer');

/**
 * What a call may cost the homeserver: a handful of round trips per park slice, and this fixture's
 * `sync_timeout_ms` puts at most a few slices inside the one real budget. Far above what a settled
 * call spends, far below the storm an unbounded park runs.
 */
const REQUEST_CEILING = { budgeted: 24, immediate: 6 };

type Observed = { status: 'resolved' } | { status: 'rejected'; error: unknown } | { status: 'pending' };

/** The settlement, or the fact that the ceiling arrived first — never a hang for vitest to name. */
async function observedWithin(call: Promise<unknown>, ms: number): Promise<Observed> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<Observed>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'pending' }), ms);
  });
  const settled: Promise<Observed> = call.then(
    (): Observed => ({ status: 'resolved' }),
    (error: unknown): Observed => ({ status: 'rejected', error }),
  );
  try {
    return await Promise.race([settled, ceiling]);
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
const SINCE_MODES = ['tail', 'stream-start', 'none'] as const;

let fake: FakeSynapse;
let requests: number;
beforeEach(() => {
  fake = new FakeSynapse();
  requests = 0;
  fake.onRequest = () => void requests++;
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let seq = 0;

describe('matrix fetchRecent settles on every numeric seam argument, at bounded request cost', () => {
  for (const [blockLabel, blockMs] of BLOCK_ROWS) {
    for (const [limitLabel, limit] of LIMIT_ROWS) {
      for (const sinceMode of SINCE_MODES) {
        for (const provisioned of [true, false]) {
          const room = provisioned ? 'an existing room' : 'a room no peer has created';
          it(`blockMs=${blockLabel} / limit=${limitLabel} / since=${sinceMode} / ${room}`, async () => {
            const topic = asTopic(`degenerate-${++seq}`);
            const p = await connectFake();
            try {
              let tail: Cursor = asCursor('$never-written');
              if (provisioned) {
                for (const text of SEEDED) await p.post(topic, WRITER, text);
                tail = (await p.fetchRecent({ topic, limit: 50 })).nextCursor;
              } else {
                fake.aliasExists = false;
              }

              const since = { tail, 'stream-start': asCursor(''), none: undefined }[sinceMode];
              const before = requests;
              const observed = await observedWithin(
                p.fetchRecent({
                  topic,
                  blockMs,
                  ...(limit === undefined ? {} : { limit }),
                  ...(since === undefined ? {} : { since }),
                }),
                SETTLE_MS,
              );
              const spent = requests - before;

              expect(
                observed.status,
                `one fetchRecent owes a page inside ${SETTLE_MS}ms, and answered neither`,
              ).toBe('resolved');
              const budgeted = Number.isFinite(blockMs) && blockMs > 0;
              expect(spent, 'homeserver requests for one call').toBeLessThanOrEqual(
                budgeted ? REQUEST_CEILING.budgeted : REQUEST_CEILING.immediate,
              );

              // A settlement that swallowed the topic is no answer, and a call that wedged the
              // plugin is not one either: the next read still answers from the position it has.
              const replay = await p.fetchRecent({ topic, since: asCursor(''), limit: 50 });
              expect(replay.messages.map((m) => m.content)).toEqual(provisioned ? SEEDED : []);
            } finally {
              await p.disconnect();
            }
          }, 20_000);
        }
      }
    }
  }
});
