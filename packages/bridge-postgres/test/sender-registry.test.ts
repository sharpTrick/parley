import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand, sleep, withAdmin } from './pg-harness.js';

// `<table>_senders` is the one relation this plugin creates whose contents nothing in the plugin's
// own happy path can distinguish: resolveIdentity's fallback answers `backendRef = handle`, which is
// byte-identical to the only row the plugin ever writes itself. So every write to it — and the DDL
// that creates it — used to be deletable with the whole suite green, which is the same thing as
// having no registry.
//
// Its observable behaviour is the row an OPERATOR puts there: `ON CONFLICT (handle) DO NOTHING` on
// both registration paths is what makes a hand-registered `backend_ref` survive and be returned. So
// these cells assert BOTH halves — the answer resolveIdentity gives, and the rows that are actually
// in the table — because only the second can see a write that stopped happening.

interface Row {
  handle: string;
  backend_ref: string;
}

async function registry(table: string): Promise<Row[]> {
  return withAdmin(async (admin) => {
    const res = await admin.query(`SELECT handle, backend_ref FROM "${table}_senders" ORDER BY handle`);
    return res.rows as Row[];
  });
}

type Origin = 'never-seen' | 'via-post' | 'pre-registered' | 'concurrent-posts';

const ORIGINS: Origin[] = ['never-seen', 'via-post', 'pre-registered', 'concurrent-posts'];

if (await isUp(PG_URL)) {
  describe('the sender registry is read, written, and never overwrites an operator row', () => {
    it.each(ORIGINS)('%s', async (origin) => {
      const table = `parley_snd_${rand()}`;
      const topic: Topic = asTopic(`snd-${rand()}`);
      const handle = asHandle(`alice-${rand()}`);
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: PG_URL, table_name: table });
      const extras: PostgresPlugin[] = [];

      try {
        const operatorRef = `${handle}@corp.example`;
        if (origin === 'pre-registered') {
          await withAdmin(async (admin) => {
            await admin.query(`INSERT INTO "${table}_senders" (handle, backend_ref) VALUES ($1, $2)`, [
              handle,
              operatorRef,
            ]);
          });
        }
        if (origin === 'via-post' || origin === 'pre-registered') {
          await plugin.post(topic, handle, 'hello');
        }
        if (origin === 'concurrent-posts') {
          for (let i = 0; i < 3; i++) {
            const p = new PostgresPlugin();
            await p.connect({ url: PG_URL, table_name: table });
            extras.push(p);
          }
          await Promise.all(extras.map((p, i) => p.post(topic, handle, `concurrent-${i}`)));
        }

        // Whatever produced the row, the registry must hold exactly one for this handle...
        if (origin !== 'never-seen') {
          expect(await registry(table), 'registry row missing for a handle that posted').toEqual([
            { handle: String(handle), backend_ref: origin === 'pre-registered' ? operatorRef : String(handle) },
          ]);
        } else {
          expect(await registry(table)).toEqual([]);
        }

        // ...and resolveIdentity must answer from it, not from its fallback.
        expect(await plugin.resolveIdentity(handle)).toEqual({
          handle: String(handle),
          backendRef: origin === 'pre-registered' ? operatorRef : String(handle),
        });

        // A resolveIdentity on an unknown handle registers it; a second call is idempotent.
        expect(await plugin.resolveIdentity(handle)).toEqual({
          handle: String(handle),
          backendRef: origin === 'pre-registered' ? operatorRef : String(handle),
        });
        expect(await registry(table), 'registry row missing after resolveIdentity').toEqual([
          { handle: String(handle), backend_ref: origin === 'pre-registered' ? operatorRef : String(handle) },
        ]);
      } finally {
        await Promise.all([plugin, ...extras].map((p) => p.disconnect()));
        await dropTable(table);
      }
    }, 60000);
  });

  // The registry write must not ride inside post()'s advisory-locked transaction: every same-topic
  // post from every bridge process serializes on that lock, and the row it inserts is not part of
  // the message. A lock held across a statement nothing reads is pure contention.
  it('a stalled registry write does not hold the per-topic advisory lock', async () => {
    const table = `parley_snd_${rand()}`;
    const topic: Topic = asTopic(`snd-${rand()}`);
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: PG_URL, table_name: table });
    try {
      const advisoryWasFree = await withAdmin(async (blocker) => {
        // Hold the registry against writers, so post()'s upsert stalls somewhere observable.
        await blocker.query('BEGIN');
        await blocker.query(`LOCK TABLE "${table}_senders" IN EXCLUSIVE MODE`);
        const posting = plugin.post(topic, asHandle('locked'), 'hi');
        await sleep(600);
        const free = await withAdmin(async (probe) => {
          await probe.query('BEGIN');
          const res = await probe.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got', [
            topic,
          ]);
          await probe.query('ROLLBACK');
          return (res.rows[0] as { got: boolean }).got;
        });
        await blocker.query('ROLLBACK');
        await posting;
        return free;
      });
      expect(
        advisoryWasFree,
        'the registry upsert is inside post()s advisory-locked transaction: every same-topic ' +
          'post in the deployment queues behind a row nothing reads',
      ).toBe(true);
    } finally {
      await plugin.disconnect();
      await dropTable(table);
    }
  }, 30000);
} else {
  describe.skip(`sender registry (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
