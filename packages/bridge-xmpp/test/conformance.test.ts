import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { client } from '@xmpp/client';
import { describe, it } from 'vitest';
import { XmppPlugin, type XmppBackendConfig } from '../src/index.js';

const SERVICE = process.env.PARLEY_XMPP_SERVICE ?? 'xmpp://127.0.0.1:5222';
const DOMAIN = process.env.PARLEY_XMPP_DOMAIN ?? 'parley.local';
const MUC = process.env.PARLEY_XMPP_MUC ?? 'muc.parley.local';
const USERNAME = process.env.PARLEY_XMPP_USER ?? 'parley';
const PASSWORD = process.env.PARLEY_XMPP_PASS ?? 'parleypass';

const BASE: XmppBackendConfig = {
  service: SERVICE,
  domain: DOMAIN,
  muc_service: MUC,
  username: USERNAME,
  password: PASSWORD,
};

const rand = () => Math.random().toString(36).slice(2, 8);

/** Reachability guard: try a short connect/auth, mirroring the redis/nats isUp pattern. */
async function isXmppUp(): Promise<boolean> {
  const c = client({
    service: SERVICE,
    domain: DOMAIN,
    username: USERNAME,
    password: PASSWORD,
  }) as unknown as { start(): Promise<unknown>; stop(): Promise<unknown>; on(e: string, cb: () => void): void };
  c.on('error', () => undefined);
  try {
    await Promise.race([
      c.start(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    await c.stop().catch(() => undefined);
    return true;
  } catch {
    await c.stop().catch(() => undefined);
    return false;
  }
}

let seq = 0;

async function makeContext() {
  const plugin = new XmppPlugin();
  // No `nick` in BASE: each connection defaults to a unique nick so concurrent writers
  // can share a room without a MUC nick conflict.
  await plugin.connect(BASE);
  return {
    plugin,
    // XMPP honors `blockMs` natively (MUC live-wait + MAM reconcile), so the shared blocking-fetch
    // conformance case runs directly against the plugin instead of core's generic wrapper (#20).
    supportsBlockingFetch: true,
    // Each topic -> a fresh, unique MUC room, so tests are fully isolated.
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    cleanup: async () => {
      await plugin.disconnect();
    },
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      // A MUC room exists only while it has an occupant; its MAM archive is destroyed when the
      // last one leaves. In production the Parley bridge stays joined to every topic it serves,
      // so the room never empties. Model that here: the long-lived ctx.plugin joins (and stays)
      // before the transient writers come and go, so the archive survives for the drainAll read.
      // This also pre-creates+unlocks the room, so the writers never hit the cold-creation race.
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

if (await isXmppUp()) {
  runConformanceSuite('xmpp', makeContext);
} else {
  describe.skip(`seam conformance: xmpp (no server at ${SERVICE})`, () => {
    it('skipped — start Prosody/ejabberd with MAM (examples/dev-compose) to run', () => undefined);
  });
}
