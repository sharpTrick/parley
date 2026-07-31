import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { schemaNames } from '../src/schema.js';
import { dropTable, isUp, PG_URL, rand, sleep, withAdmin } from './pg-harness.js';

// The deployment this plugin is FOR is N bridge processes sharing one table, and every one of them
// runs the idempotent bootstrap on start. So `connect()` is not a one-off cost: a rolling deploy, a
// crash loop or a config reload runs it again and again against a table other processes are actively
// writing. `CREATE INDEX` takes SHARE and `CREATE TRIGGER` SHARE ROW EXCLUSIVE — both conflict with
// the ROW EXCLUSIVE an INSERT holds, and the `IF NOT EXISTS` spelling takes the lock anyway — so a
// bootstrap that re-issues them unconditionally stalls every other process's post() cluster-wide for
// the duration of every process start.
//
// Two properties, and each is trivially cheatable without the other: "does not block" is satisfied by
// emitting no DDL at all, and "creates what is missing" is satisfied by emitting all of it every
// time. So every cell asserts BOTH — what connect() waited for, and that the relations and the live
// doorbell exist afterwards. The cell whose trigger was removed by hand is the control: there the
// bootstrap genuinely has something to create, so it MUST wait, which is what proves the lock probe
// in the other cells can see a conflict at all.

/** A connect() that has not settled within this is waiting on the writer's lock. */
const CONNECT_BUDGET_MS = 2000;

interface Cell {
  label: string;
  /** Applied to an already-bootstrapped table before the observed connect(). */
  damage?: (table: string) => Promise<void>;
  bootstrapped: boolean;
  /** What connect() must do while another session holds ROW EXCLUSIVE on the message table. */
  whileWriterHoldsLock: 'connected' | 'blocked';
}

const CELLS: Cell[] = [
  { label: 'already bootstrapped', bootstrapped: true, whileWriterHoldsLock: 'connected' },
  {
    label: 'trigger dropped by hand',
    bootstrapped: true,
    whileWriterHoldsLock: 'blocked',
    damage: async (table) => {
      await withAdmin(async (admin) => {
        await admin.query(
          `DROP TRIGGER "${schemaNames(table).notifyTrigger}" ON "${schemaNames(table).messages}"`,
        );
      });
    },
  },
  {
    label: 'index dropped by hand',
    bootstrapped: true,
    whileWriterHoldsLock: 'blocked',
    damage: async (table) => {
      await withAdmin(async (admin) => {
        await admin.query(`DROP INDEX "${schemaNames(table).topicSeqIndex}"`);
      });
    },
  },
  // What a table bootstrapped before retention stopped trusting the poster's clock looks like: the
  // server-stamped column has to be added and the index that resolved the old window removed, so
  // this bootstrap has genuine table-level work to do.
  {
    label: 'a table from the version that pruned on the poster’s timestamp',
    bootstrapped: true,
    whileWriterHoldsLock: 'blocked',
    damage: async (table) => {
      await withAdmin(async (admin) => {
        const names = schemaNames(table);
        await admin.query(`ALTER TABLE "${names.messages}" DROP COLUMN created_at`);
        await admin.query(`DROP INDEX IF EXISTS "${names.createdAtIndex}"`);
        await admin.query(`CREATE INDEX "${names.messages}_ts" ON "${names.messages}" (ts)`);
      });
    },
  },
];

/**
 * Read the relation names OUT of the schema module. Restating them here is how a suffix rename
 * leaves this file checking for something the plugin no longer creates, or missing something it
 * now does — either way the cell passes and grades nothing.
 */
async function relationsPresent(table: string): Promise<Record<string, boolean>> {
  const names = schemaNames(table);
  return withAdmin(async (admin) => {
    const res = await admin.query(
      `SELECT to_regclass($1) IS NOT NULL AS topic_seq,
              to_regclass($2) IS NOT NULL AS created_at_index,
              to_regclass($5) IS NOT NULL AS superseded_ts_index,
              EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = to_regclass($3) AND attname = 'created_at'
                        AND NOT attisdropped) AS created_at_column,
              EXISTS (SELECT 1 FROM pg_trigger
                      WHERE tgrelid = to_regclass($3) AND tgname = $4 AND NOT tgisinternal) AS trigger`,
      [
        `"${names.topicSeqIndex}"`,
        `"${names.createdAtIndex}"`,
        `"${names.messages}"`,
        names.notifyTrigger,
        `"${names.messages}_ts"`,
      ],
    );
    return res.rows[0] as Record<string, boolean>;
  });
}

const EVERY_RELATION = {
  topic_seq: true,
  created_at_index: true,
  created_at_column: true,
  trigger: true,
  // An index on a column nothing queries costs every INSERT in the deployment, forever.
  superseded_ts_index: false,
};

async function pushWorks(table: string, topic: Topic): Promise<string[]> {
  const plugin = new PostgresPlugin();
  await plugin.connect({ url: PG_URL, table_name: table });
  const seen: Message[] = [];
  try {
    await plugin.subscribe(topic, (m) => seen.push(m));
    await plugin.post(topic, asHandle('u'), 'pushed');
    for (let i = 0; i < 60 && seen.length === 0; i++) await sleep(25);
    return seen.map((m) => m.content);
  } finally {
    await plugin.disconnect();
  }
}

if (await isUp(PG_URL)) {
  describe('connect() creates only what is missing, and waits only when it has to', () => {
    it('a fresh table gets every index and the doorbell', async () => {
      const table = `parley_boot_${rand()}`;
      const topic: Topic = asTopic(`boot-${rand()}`);
      try {
        expect(await pushWorks(table, topic)).toEqual(['pushed']);
        expect(await relationsPresent(table)).toEqual(EVERY_RELATION);
      } finally {
        await dropTable(table);
      }
    }, 60000);

    it.each(CELLS.map((c) => [c.label, c] as const))('%s', async (_label, cell) => {
      const table = `parley_boot_${rand()}`;
      const topic: Topic = asTopic(`boot-${rand()}`);

      try {
        const first = new PostgresPlugin();
        await first.connect({ url: PG_URL, table_name: table });
        await first.disconnect();
        await cell.damage?.(table);

        const plugin = new PostgresPlugin();
        const outcome = await withAdmin(async (writer) => {
          // ROW EXCLUSIVE is exactly what an in-flight INSERT from another bridge process holds.
          await writer.query('BEGIN');
          await writer.query(`LOCK TABLE "${table}" IN ROW EXCLUSIVE MODE`);
          const connecting = plugin
            .connect({ url: PG_URL, table_name: table })
            .then(() => 'connected')
            .catch((e: unknown) => `failed: ${String(e)}`);
          const settled = await Promise.race([
            connecting,
            sleep(CONNECT_BUDGET_MS).then(() => 'blocked'),
          ]);
          await writer.query('ROLLBACK');
          expect(await connecting, 'connect() never finished once the writer let go').toBe(
            'connected',
          );
          return settled;
        });
        await plugin.disconnect();

        expect(
          outcome,
          cell.whileWriterHoldsLock === 'connected'
            ? 'connect() waited on a concurrent writer with nothing to create: every post() in ' +
                'the deployment stalls for the duration of every process start'
            : 'connect() did not take the table lock it needs to create the missing relation',
        ).toBe(cell.whileWriterHoldsLock);

        expect(await relationsPresent(table)).toEqual(EVERY_RELATION);
        expect(await pushWorks(table, topic), 'the NOTIFY trigger never fired').toEqual(['pushed']);
      } finally {
        await dropTable(table);
      }
    }, 60000);
  });
} else {
  describe.skip(`connect() bootstrap locking (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
