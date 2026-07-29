import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS } from './helpers.js';

let seq = 0;

async function makeContext() {
  const tag = rand();
  const cfg = { servers: SERVERS, subject_prefix: `pt.${tag}.`, stream_prefix: `PT_${tag}_` };
  const plugin = new NatsPlugin();
  await plugin.connect(cfg);
  return {
    plugin,
    supportsBlockingFetch: true, // fetchRecent honors blockMs natively via a JetStream pull expiry
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    carriesSenderIdentity: true,
    cleanup: async () => {
      await plugin.disconnect();
      await dropStreams(`PT_${tag}_`);
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

if (await isNatsUp()) {
  runConformanceSuite('nats', makeContext);
} else {
  describe.skip(`seam conformance: nats (no server at ${SERVERS})`, () => {
    it('skipped — start nats -js (examples/dev-compose) to run', () => undefined);
  });
}
