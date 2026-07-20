import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { describe, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';

async function isPostgresUp(url: string): Promise<boolean> {
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

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

async function makeContext() {
  const table = `parley_test_${rand()}`;
  const plugin = new PostgresPlugin();
  await plugin.connect({ url: PG_URL, table_name: table });
  return {
    plugin,
    // Postgres honors blockMs natively via LISTEN/NOTIFY (issue #20) — run the long-poll case.
    supportsBlockingFetch: true,
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    cleanup: async () => {
      await plugin.disconnect();
      // wipe this context's tables + trigger function
      const admin = new Client({ connectionString: PG_URL });
      admin.on('error', () => undefined);
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await admin.query(`DROP TABLE IF EXISTS ${table}_senders CASCADE`);
      await admin.query(`DROP FUNCTION IF EXISTS ${table}_notify() CASCADE`);
      await admin.end();
    },
    // N independent plugin instances (own pools/connections) against the SAME table — the
    // per-topic advisory lock in post() is what keeps seq order == visibility order here.
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new PostgresPlugin();
          await p.connect({ url: PG_URL, table_name: table });
          return p;
        }),
      );
      try {
        await Promise.all(
          plugins.map(async (p, w) => {
            for (let i = 0; i < perWriter; i++) {
              await p.post(topic, asHandle(`w${w}`), `w${w}-${i}`);
            }
          }),
        );
      } finally {
        await Promise.all(plugins.map((p) => p.disconnect()));
      }
    },
  };
}

if (await isPostgresUp(PG_URL)) {
  runConformanceSuite('postgres', makeContext);
} else {
  describe.skip(`seam conformance: postgres (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
