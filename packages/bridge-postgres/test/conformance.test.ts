import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand } from './pg-harness.js';

let seq = 0;

// The NOTIFY channel is derived from the topic on BOTH sides (Node and the trigger), so the whole
// suite is run over topic shapes that stress that derivation — not just the ASCII shape a naive
// generator emits. Rotating rather than fixing keeps every case seeing several shapes.
const TOPIC_SHAPES = ['plain', 'café', '日本語', 'room-🚀', 'école'.normalize('NFD'), ' padded '];

async function makeContext(table: string) {
  const plugin = new PostgresPlugin();
  await plugin.connect({ url: PG_URL, table_name: table });
  return {
    plugin,
    // Postgres honors blockMs natively via LISTEN/NOTIFY — run the long-poll case.
    supportsBlockingFetch: true,
    freshTopic: (): Topic =>
      asTopic(`${TOPIC_SHAPES[++seq % TOPIC_SHAPES.length] as string}-${seq}-${rand()}`),
    carriesSenderIdentity: true,
    cleanup: async () => {
      await plugin.disconnect();
      await dropTable(table);
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

if (await isUp(PG_URL)) {
  // One representative context. `table_name` reaches the server only during bootstrap — past
  // `connect()` every seam method behaves identically whatever the stem was — so the accepted-name
  // shapes are driven end to end once each in table-name.test.ts rather than by re-running all of
  // this against a second stem.
  runConformanceSuite('postgres', () => makeContext(`parley_test_${rand()}`));
} else {
  describe.skip(`seam conformance: postgres (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
