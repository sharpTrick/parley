import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { describe, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { MAX_TABLE_NAME_BYTES } from '../src/schema.js';

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

// The NOTIFY channel is derived from the topic on BOTH sides (Node and the trigger), so the whole
// suite is run over topic shapes that stress that derivation — not just the ASCII shape a naive
// generator emits. Rotating rather than fixing keeps every case seeing several shapes.
const TOPIC_SHAPES = ['plain', 'café', '日本語', 'room-🚀', 'école'.normalize('NFD'), ' padded '];

async function makeContext(table: string) {
  const plugin = new PostgresPlugin();
  await plugin.connect({ url: PG_URL, table_name: table });
  return {
    plugin,
    // Postgres honors blockMs natively via LISTEN/NOTIFY (issue #20) — run the long-poll case.
    supportsBlockingFetch: true,
    freshTopic: (): Topic =>
      asTopic(`${TOPIC_SHAPES[++seq % TOPIC_SHAPES.length] as string}-${seq}-${rand()}`),
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
  // Every relation this plugin creates is derived from `table_name` by suffixing, and PostgreSQL
  // truncates identifiers at 63 bytes — so the longest accepted name is run end to end, not just a
  // comfortably short one.
  const longTable = `parley_test_${rand()}`.padEnd(MAX_TABLE_NAME_BYTES, 'x');
  for (const [label, table] of [
    ['short table_name', `parley_test_${rand()}`],
    [`${MAX_TABLE_NAME_BYTES}-byte table_name`, longTable],
  ] as const) {
    runConformanceSuite(`postgres (${label})`, () => makeContext(table));
  }
} else {
  describe.skip(`seam conformance: postgres (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
