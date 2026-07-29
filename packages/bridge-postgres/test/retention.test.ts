import { asHandle, asTopic } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// Postgres creates and wholly owns its message table, so DESIGN §11 puts the retention knob on it
// alongside sqlite/redis/nats. A config key that a sibling backend honours must never be silently
// dropped here — an operator who sets it and sees no error must actually get pruning.

const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';
const rand = (): string => Math.random().toString(36).slice(2, 8);

async function isUp(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 800 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
    return true;
  } catch {
    await c.end().catch(() => undefined);
    return false;
  }
}

async function dropTable(table: string): Promise<void> {
  const admin = new Client({ connectionString: PG_URL });
  admin.on('error', () => undefined);
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  await admin.query(`DROP TABLE IF EXISTS ${table}_senders CASCADE`);
  await admin.query(`DROP FUNCTION IF EXISTS ${table}_notify() CASCADE`);
  await admin.end();
}

if (await isUp(PG_URL)) {
  describe('retention_days (DESIGN §11)', () => {
    it.each([
      ['prunes older rows when set to a real window', 1 / 86_400_000, 0],
      ['keeps every row when omitted', undefined, 3],
    ])('%s', async (_label, retentionDays, expectedSurvivors) => {
      const table = `parley_ret_${rand()}`;
      const topic = asTopic(`ret-${rand()}`);
      const seeder = new PostgresPlugin();
      await seeder.connect({ url: PG_URL, table_name: table });
      try {
        for (let i = 0; i < 3; i++) await seeder.post(topic, asHandle('u'), `m${i}`);
      } finally {
        await seeder.disconnect();
      }

      const plugin = new PostgresPlugin();
      await plugin.connect(
        retentionDays === undefined
          ? { url: PG_URL, table_name: table }
          : { url: PG_URL, table_name: table, retention_days: retentionDays },
      );
      try {
        if (retentionDays !== undefined) await new Promise((r) => setTimeout(r, 400));
        const before = await plugin.fetchRecent({ topic });
        expect(before.messages.length).toBe(expectedSurvivors);

        // Pruning must not disturb the cursor: seq is never reused, so a post after a prune still
        // sorts strictly after everything that came before it.
        const fresh = await plugin.post(topic, asHandle('u'), 'after-prune');
        const after = await plugin.fetchRecent({ topic });
        expect(after.messages.at(-1)?.content).toBe('after-prune');
        expect(Number(fresh)).toBeGreaterThan(3);
      } finally {
        await plugin.disconnect();
        await dropTable(table);
      }
    }, 20000);

    // The prune is issued in bounded statements (prune-bounded.test.ts pins the statement shape).
    // A backlog larger than one batch is what proves the loop around them runs to completion
    // against a real server instead of removing one batch and calling it done.
    it('removes a backlog larger than a single prune batch, completely', async () => {
      const table = `parley_ret_${rand()}`;
      const topic = asTopic(`ret-${rand()}`);
      const backlog = 5001;

      const seeder = new PostgresPlugin();
      await seeder.connect({ url: PG_URL, table_name: table });
      await seeder.disconnect();

      const admin = new Client({ connectionString: PG_URL });
      admin.on('error', () => undefined);
      await admin.connect();
      await admin.query(
        `INSERT INTO "${table}" (topic, sender, content, ts, in_reply_to)
         SELECT $1, 'u', 'm' || g, $2, NULL FROM generate_series(1, $3::int) g`,
        [topic, new Date(Date.now() - 86_400_000).toISOString(), backlog],
      );
      await admin.end();

      const plugin = new PostgresPlugin();
      await plugin.connect({ url: PG_URL, table_name: table, retention_days: 1 / 86_400_000 });
      try {
        const deadline = Date.now() + 20000;
        let left = 1;
        while (left > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          left = (await plugin.fetchRecent({ topic, limit: 1 })).messages.length;
        }
        expect(left, 'prune stopped before the backlog was gone').toBe(0);
      } finally {
        await plugin.disconnect();
        await dropTable(table);
      }
    }, 60000);

    it('clears the prune timer on disconnect so it cannot keep the process alive', async () => {
      const table = `parley_ret_${rand()}`;
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: PG_URL, table_name: table, retention_days: 7 });
      try {
        const priv = plugin as unknown as { pruneTimer?: unknown };
        expect(priv.pruneTimer).toBeDefined();
        await plugin.disconnect();
        expect(priv.pruneTimer).toBeUndefined();
      } finally {
        await plugin.disconnect();
        await dropTable(table);
      }
    }, 20000);
  });
} else {
  describe.skip(`retention_days (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
