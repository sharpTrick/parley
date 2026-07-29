import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, type Topic } from '@sharptrick/parley-core';
import { describe, it } from 'vitest';
import { RedisPlugin } from '../src/index.js';
import { freshPrefix, freshTopic, isRedisUp, REDIS_URL, wipe } from './support.js';

async function makeContext() {
  const prefix = freshPrefix();
  const plugin = new RedisPlugin();
  await plugin.connect({ url: REDIS_URL, key_prefix: prefix, block_ms: 500 });
  return {
    plugin,
    supportsBlockingFetch: true, // Redis honors blockMs natively via XREAD BLOCK
    freshTopic: (): Topic => freshTopic('t'),
    carriesSenderIdentity: true,
    cleanup: async () => {
      await plugin.disconnect();
      await wipe(prefix);
    },
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new RedisPlugin();
          await p.connect({ url: REDIS_URL, key_prefix: prefix });
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

if (await isRedisUp(REDIS_URL)) {
  runConformanceSuite('redis', makeContext);
} else {
  describe.skip(`seam conformance: redis (no server at ${REDIS_URL})`, () => {
    it('skipped — start redis (examples/dev-compose) to run', () => undefined);
  });
}
