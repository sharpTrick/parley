import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand, sleep, withAdmin } from './pg-harness.js';

// Retention DELETES. Postgres is the backend DESIGN §10 sells as multi-machine, so the process that
// prunes is routinely not the process that wrote, and DESIGN §5/§6 and CLAUDE.md both say the
// timestamp is never load-bearing. The class being guarded is therefore: a backend that owns its
// store must not decide a deletion on a value a PEER's clock produced. Whether a row survives is a
// property of when the DATABASE stored it, and of nothing else — so the writer's clock is walked
// over ten days either side of the truth and must not move the answer by one row in any cell.
//
// The package's other retention cases cannot see this: every row they seed takes `ts` from the same
// process clock that later computes the cutoff, so the two can never disagree.

/** How far the writer's wall clock is from the truth when it calls post(). */
const CLOCK_OFFSETS_MS: [label: string, offsetMs: number][] = [
  ['ten days slow', -10 * 86_400_000],
  ['an hour slow', -3_600_000],
  ['a second slow', -1000],
  ['correct', 0],
  ['a second fast', 1000],
  ['an hour fast', 3_600_000],
  ['ten days fast', 10 * 86_400_000],
];

/** The pruner's window. Both seeded rows sit unambiguously on one side of it, server-side. */
const RETENTION_DAYS = 1;

/** How long the prune gets to remove the row that is genuinely outside the window. */
const PRUNE_BUDGET_MS = 8000;
/** Grace after that, in which a row inside the window must still be there. */
const SETTLE_MS = 400;

afterEach(() => {
  vi.useRealTimers();
});

if (await isUp(PG_URL)) {
  describe('retention decides on the store’s clock, never on the writer’s', () => {
    it.each(CLOCK_OFFSETS_MS.map(([label, offsetMs]) => [label, offsetMs] as const))(
      'a writer whose clock is %s neither loses a fresh message nor immortalises an old one',
      async (_label, offsetMs) => {
        const table = `parley_clk_${rand()}`;
        const topic = asTopic(`clk-${rand()}`);

        const writer = new PostgresPlugin();
        await writer.connect({ url: PG_URL, table_name: table });
        vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
        vi.setSystemTime(new Date(Date.now() + offsetMs));
        const writerStart = Date.now();
        await writer.post(topic, asHandle('u'), 'stored two days ago');
        await writer.post(topic, asHandle('u'), 'stored just now');
        const writerEnd = Date.now();
        vi.useRealTimers();
        await writer.disconnect();

        // Age the first row the only way that is true regardless of any client: server-side. Its
        // `ts` still says whatever the skewed writer wrote, which is exactly the disagreement.
        await withAdmin(async (admin) => {
          await admin.query(
            `UPDATE "${table}" SET created_at = now() - interval '2 days' WHERE content = $1`,
            ['stored two days ago'],
          );
        });

        const pruner = new PostgresPlugin();
        await pruner.connect({ url: PG_URL, table_name: table, retention_days: RETENTION_DAYS });
        try {
          const deadline = Date.now() + PRUNE_BUDGET_MS;
          let contents = (await pruner.fetchRecent({ topic })).messages.map((m) => m.content);
          while (contents.length > 1 && Date.now() < deadline) {
            await sleep(50);
            contents = (await pruner.fetchRecent({ topic })).messages.map((m) => m.content);
          }
          await sleep(SETTLE_MS);
          const { messages } = await pruner.fetchRecent({ topic });
          expect(
            messages.map((m) => m.content),
            'survival moved with the writer’s clock instead of with the store’s',
          ).toEqual(['stored just now']);
          // `ts` stays the poster's wall clock (DESIGN §5) — informational, and not quietly
          // replaced by the server stamp retention now uses.
          const stamped = Date.parse(String(messages[0]?.timestamp));
          expect(stamped, 'ts is no longer the poster’s own clock').toBeGreaterThanOrEqual(
            writerStart,
          );
          expect(stamped, 'ts is no longer the poster’s own clock').toBeLessThanOrEqual(writerEnd);
        } finally {
          await pruner.disconnect();
          await dropTable(table);
        }
      },
      60000,
    );
  });
} else {
  describe.skip(`retention clock independence (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
