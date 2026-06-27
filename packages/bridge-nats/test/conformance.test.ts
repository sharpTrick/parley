import { runConformanceSuite } from '@parley/conformance';
import { asHandle, asTopic, type Topic } from '@parley/core';
import { connect } from 'nats';
import { describe, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';

const SERVERS = process.env.PARLEY_NATS_SERVERS ?? '127.0.0.1:4222';

async function isNatsUp(servers: string): Promise<boolean> {
  try {
    const nc = await connect({ servers, timeout: 1000, maxReconnectAttempts: 0 });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

async function makeContext() {
  const tag = rand();
  const cfg = { servers: SERVERS, subject_prefix: `pt.${tag}.`, stream_prefix: `PT_${tag}_` };
  const plugin = new NatsPlugin();
  await plugin.connect(cfg);
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    cleanup: async () => {
      await plugin.disconnect();
      const nc = await connect({ servers: SERVERS });
      const jsm = await nc.jetstreamManager();
      for await (const s of jsm.streams.list()) {
        if (s.config.name.startsWith(`PT_${tag}_`)) {
          await jsm.streams.delete(s.config.name).catch(() => undefined);
        }
      }
      await nc.drain();
    },
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new NatsPlugin();
          await p.connect(cfg);
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

if (await isNatsUp(SERVERS)) {
  runConformanceSuite('nats', makeContext);
} else {
  describe.skip(`seam conformance: nats (no server at ${SERVERS})`, () => {
    it('skipped — start nats -js (examples/dev-compose) to run', () => undefined);
  });
}
