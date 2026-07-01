import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { createClient } from 'redis';
import { describe, it } from 'vitest';
import { RedisPlugin } from '../src/index.js';

const REDIS_URL = process.env.PARLEY_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function isRedisUp(url: string): Promise<boolean> {
  const c = createClient({ url, socket: { connectTimeout: 800, reconnectStrategy: false } });
  c.on('error', () => undefined);
  try {
    await c.connect();
    await c.ping();
    await c.disconnect();
    return true;
  } catch {
    await c.disconnect().catch(() => undefined);
    return false;
  }
}

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

async function makeContext() {
  const prefix = `parleytest:${rand()}:`;
  const plugin = new RedisPlugin();
  await plugin.connect({ url: REDIS_URL, key_prefix: prefix, block_ms: 500 });
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    cleanup: async () => {
      await plugin.disconnect();
      // wipe this context's streams
      const admin = createClient({ url: REDIS_URL });
      admin.on('error', () => undefined);
      await admin.connect();
      const keys = await admin.keys(`${prefix}*`);
      if (keys.length > 0) await admin.del(keys);
      await admin.disconnect();
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
