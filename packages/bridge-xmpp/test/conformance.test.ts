import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, type Topic } from '@sharptrick/parley-core';
import { describe, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

async function makeContext() {
  const plugin = new XmppPlugin();
  // No `nick` in BASE: each connection defaults to a unique nick so concurrent writers
  // can share a room without a MUC nick conflict.
  await plugin.connect(BASE);
  return {
    plugin,
    // XMPP honors `blockMs` natively (MUC live-wait + MAM reconcile), so the shared blocking-fetch
    // conformance case runs directly against the plugin instead of core's generic wrapper.
    supportsBlockingFetch: true,
    // Each topic -> a fresh, unique MUC room, so tests are fully isolated.
    freshTopic: (): Topic => freshTopic(),
    carriesSenderIdentity: false,
    cleanup: async () => {
      await plugin.disconnect();
    },
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      // Keep the long-lived ctx.plugin joined before the transient writers arrive, so that the
      // room is created (and unlocked) by it: the writers then never hit the cold-creation race,
      // and the archive is not at the mercy of the last writer leaving.
      await plugin.fetchRecent({ topic, limit: 1 });
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new XmppPlugin();
          await p.connect(BASE); // distinct connection + distinct auto nick
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

if (await canAuth(BASE)) {
  runConformanceSuite('xmpp', makeContext);
} else {
  describe.skip(`seam conformance: xmpp (no server at ${String(BASE.service)})`, () => {
    it('skipped — start Prosody/ejabberd with MAM (examples/dev-compose) to run', () => undefined);
  });
}
