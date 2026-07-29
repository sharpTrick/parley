import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// `table_name` is the one operator value that reaches SQL as text rather than as a bind parameter,
// and every relation this plugin creates is derived from it. A name the guard ACCEPTS must work on
// a real server on every path — DDL, insert, catch-up read, the sender registry, and the NOTIFY
// trigger — not just on the comfortable ASCII stem the rest of the suite uses. Reserved words are
// the interesting corpus: they pass the charset guard, so before the identifiers were quoted they
// reached the server and came back as a bare parse error naming neither Parley nor the key.

const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';
const rand = (): string => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  await admin.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  await admin.query(`DROP TABLE IF EXISTS "${table}_senders" CASCADE`);
  await admin.query(`DROP FUNCTION IF EXISTS "${table}_notify"() CASCADE`);
  await admin.end();
}

/** Reserved words plus the case the guard normalises — dropped before and after each case. */
const NAMES = ['user', 'order', 'table', 'select', 'group', 'MixedCase'];

if (await isUp(PG_URL)) {
  describe('every table_name the guard accepts works end to end on a real server', () => {
    it.each(NAMES)('table_name = %s', async (name) => {
      // The BARE word — suffixing it would turn `user` into `user_ab12cd`, an ordinary identifier
      // that proves nothing about reserved words.
      const table = name;
      const plugin = new PostgresPlugin();
      const topic = asTopic(`tn-${rand()}`);

      await dropTable(table.toLowerCase());
      try {
        await plugin.connect({ url: PG_URL, table_name: table });

        const got: Message[] = [];
        await plugin.subscribe(topic, (m) => got.push(m));

        const id = await plugin.post(topic, asHandle('alice'), 'hello');
        expect(String(id)).toMatch(/^\d+$/);

        const { messages } = await plugin.fetchRecent({ topic });
        expect(messages.map((m) => m.content)).toEqual(['hello']);
        expect(await plugin.resolveIdentity(asHandle('alice'))).toEqual({
          handle: 'alice',
          backendRef: 'alice',
        });

        const deadline = Date.now() + 5000;
        while (got.length === 0 && Date.now() < deadline) await sleep(25);
        expect(got.map((m) => m.content), 'the NOTIFY trigger never fired').toEqual(['hello']);
      } finally {
        await plugin.disconnect();
        await dropTable(table.toLowerCase());
      }
    }, 30000);
  });
} else {
  describe.skip(`accepted table_name shapes (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
