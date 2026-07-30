import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { LOCK_WAIT_MS, PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand, settleWithin, sleep, withAdmin } from './pg-harness.js';

// Both server-side locks this plugin takes are acquired with a POOLED connection already checked
// out and held for the length of the wait: post()'s per-topic write lock, and connect()'s bootstrap
// lock. So an outside session sitting on either one does not just delay that call — it spends this
// instance's pool capacity, and once `pool_size` calls are parked there, every read (fetchRecent,
// resolveIdentity, the subscription drain) queues behind them. Unbounded, that is not a slow bridge
// but a wedged one, with no error and no diagnostic anywhere.
//
// The property is therefore not "the lock is fast": it is that a wait on a server-side lock is
// BOUNDED and named, so the capacity it borrows always comes back and the caller learns why.

const READ_BUDGET_MS = LOCK_WAIT_MS + 5000;
/** A read that needs none of the parked capacity must not wait on it at all. */
const SPARE_CAPACITY_BUDGET_MS = 2000;

/** How many concurrent posts are parked on the lock, relative to the pool they share. */
function blockedCounts(poolSize: number): number[] {
  return [...new Set([1, poolSize, poolSize + 1])];
}

interface Offence {
  cell: string;
  detail: string;
}

if (await isUp(PG_URL)) {
  describe('a seam call parked on a server-side lock never spends the pool indefinitely', () => {
    // Concurrent: each row parks its posts for a whole lock budget, and the rows share nothing but
    // the table — running them in series would cost the file three budgets to grade three sizes.
    it.concurrent.each([[1], [2], [5]])(
      'pool_size %i keeps serving reads while posts are locked out',
      async (poolSize) => {
        const table = `parley_lock_${rand()}`;
        const bootstrap = new PostgresPlugin();
        await bootstrap.connect({ url: PG_URL, table_name: table });
        await bootstrap.disconnect();

        const offences: Offence[] = [];
        try {
          await withAdmin(async (admin) => {
            await Promise.all(
              blockedCounts(poolSize).map(async (blocked) => {
                const cell = `pool_size ${poolSize}, ${blocked} blocked post(s)`;
                const locked = asTopic(`locked-${rand()}`);
                const free = asTopic(`free-${rand()}`);
                await admin.query('SELECT pg_advisory_lock(hashtext($1))', [locked]);

                const plugin = new PostgresPlugin();
                await plugin.connect({ url: PG_URL, table_name: table, pool_size: poolSize });
                try {
                  const posts = Array.from({ length: blocked }, () =>
                    settleWithin(
                      plugin.post(locked, asHandle('u'), 'blocked'),
                      LOCK_WAIT_MS + 10000,
                    ),
                  );
                  await sleep(300);

                  // A read needs no lock at all. It must still come back — on the contended topic
                  // and on an untouched one, whether or not the parked posts have left it any
                  // spare connection.
                  const budget =
                    blocked < poolSize ? SPARE_CAPACITY_BUDGET_MS : READ_BUDGET_MS;
                  for (const [what, topic] of [
                    ['the contended topic', locked],
                    ['an untouched topic', free],
                  ] as const) {
                    const started = Date.now();
                    const outcome = await settleWithin(
                      plugin.fetchRecent({ topic, since: '0' as never }),
                      budget,
                    );
                    if (outcome !== 'resolved') {
                      offences.push({
                        cell,
                        detail: `fetchRecent on ${what} was ${outcome} after ${Date.now() - started}ms`,
                      });
                    }
                  }

                  // And the post that borrowed the capacity has to give it back with a message
                  // that says which topic it was for, not park on the lock forever.
                  for (const outcome of await Promise.all(posts)) {
                    const named =
                      outcome.startsWith('rejected: parley-postgres:') &&
                      outcome.includes(String(locked));
                    if (!named) {
                      offences.push({ cell, detail: `the parked post was ${outcome}` });
                    }
                  }
                } finally {
                  await plugin.disconnect();
                  await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [locked]);
                }
              }),
            );
          });
        } finally {
          await dropTable(table);
        }

        expect(offences, 'a lock wait spent pool capacity it never gave back').toEqual([]);
      },
      120000,
    );

    // The same shape one resource up: connect()'s idempotent bootstrap takes an advisory lock on
    // the TABLE with a pooled client held across the wait, so a session sitting on that key would
    // otherwise make connect() hang forever with nothing to report.
    it('connect() gives up on a held bootstrap lock instead of hanging', async () => {
      const table = `parley_lock_${rand()}`;
      try {
        await withAdmin(async (admin) => {
          await admin.query('SELECT pg_advisory_lock(hashtext($1))', [table]);
          const plugin = new PostgresPlugin();
          const started = Date.now();
          const outcome = await settleWithin(
            plugin.connect({ url: PG_URL, table_name: table }),
            LOCK_WAIT_MS + 10000,
          );
          await plugin.disconnect();
          await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [table]);
          expect(outcome, `connect() after ${Date.now() - started}ms`).toMatch(
            /^rejected: parley-postgres:/,
          );
          expect(outcome, 'the failure must say which table it was for').toContain(table);
        });
      } finally {
        await dropTable(table);
      }
    }, 60000);
  });
} else {
  describe.skip(`server-side lock waits (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
