import { runConformanceSuite, type ConformanceContext } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { startFakeZulip } from './fake-zulip.js';
import { decideIntegrationGate, type GateProbe, rand, SENDER, sleep, useZulip } from './harness.js';

let seq = 0;
const boot = useZulip();

/** The in-process fake — always available, so this suite always runs. */
async function makeContext(): Promise<ConformanceContext> {
  const fake = await startFakeZulip();
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 1000 });
  return {
    plugin,
    // Zulip honors blockMs NATIVELY via the /api/v1/events long-poll, so the shared blocking-fetch
    // conformance case runs directly against the plugin here.
    supportsBlockingFetch: true,
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    carriesSenderIdentity: false,
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
    },
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new ZulipPlugin();
          await p.connect({ site_url: fake.url });
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

runConformanceSuite('zulip', makeContext);

/**
 * Zulip GCs an idle event queue after ~10 minutes and then answers `BAD_EVENT_QUEUE_ID`. Whatever
 * lands while the queue is dead reaches no queue at all, so recovery is a re-register plus a
 * gap-fill — and the gap-fill's own history reads can fail too, which is the dimension here.
 */
describe('zulip queue GC recovery', () => {
  for (const failingReads of [0, 1, 3]) {
    it(`replays the dead-window messages exactly once with ${failingReads} failing gap-fill read(s)`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`gc-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      await plugin.post(topic, SENDER, 'before');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000, interval: 10 });

      // Kill every queue server-side (the ~10-min-idle GC / a restart), break the gap-fill's first
      // reads, then post into the dead window: those messages can only arrive via a retried
      // gap-fill, and the fresh queue's overlap must not hand any of them over twice.
      fake.gcQueues();
      fake.failMessagesReads(failingReads);
      await plugin.post(topic, SENDER, 'd1');
      await plugin.post(topic, SENDER, 'd2');
      await plugin.post(topic, SENDER, 'd3');

      await vi.waitFor(
        () => expect(got.map((m) => m.content)).toEqual(['before', 'd1', 'd2', 'd3']),
        { timeout: 6000, interval: 10 },
      );
      await sleep(400);
      expect(got.map((m) => m.content)).toEqual(['before', 'd1', 'd2', 'd3']);
    });
  }
});

describe('zulip resolveIdentity', () => {
  it('maps email or full_name to the Zulip user_id, and misses to the string convention', async () => {
    const { plugin } = await boot();
    expect(await plugin.resolveIdentity(asHandle('parley-bot@localhost'))).toEqual({
      handle: 'parley-bot@localhost',
      backendRef: '10',
    });
    expect(await plugin.resolveIdentity(asHandle('Pat Sharp'))).toEqual({
      handle: 'Pat Sharp',
      backendRef: '11',
    });
    expect(await plugin.resolveIdentity(asHandle('nobody'))).toEqual({
      handle: 'nobody',
      backendRef: 'nobody',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Optional second run against a REAL Zulip server. Fresh topics in the configured stream are
// free, so no scratch cleanup is needed beyond disconnect.
const REAL_URL = process.env.PARLEY_ZULIP_URL;
const REAL_EMAIL = process.env.PARLEY_ZULIP_EMAIL;
const REAL_KEY = process.env.PARLEY_ZULIP_API_KEY;
const REAL_STREAM = process.env.PARLEY_ZULIP_STREAM ?? 'parley';

async function probeZulip(url: string, email: string, key: string): Promise<GateProbe> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/users`, {
      headers: { Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}` },
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok, detail: `${res.status} ${res.statusText}` };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function makeRealContext(): Promise<ConformanceContext> {
  const config = {
    site_url: REAL_URL,
    email: REAL_EMAIL,
    api_key: REAL_KEY,
    stream: REAL_STREAM,
  };
  const plugin = new ZulipPlugin();
  await plugin.connect(config);
  return {
    plugin,
    supportsBlockingFetch: true, // native /api/v1/events long-poll
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
    carriesSenderIdentity: false,
    cleanup: async () => {
      await plugin.disconnect();
    },
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new ZulipPlugin();
          await p.connect(config);
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

const realVars = {
  PARLEY_ZULIP_URL: REAL_URL,
  PARLEY_ZULIP_EMAIL: REAL_EMAIL,
  PARLEY_ZULIP_API_KEY: REAL_KEY,
};
const allRealVarsSet = REAL_URL !== undefined && REAL_EMAIL !== undefined && REAL_KEY !== undefined;
const gate = decideIntegrationGate(
  realVars,
  allRealVarsSet ? await probeZulip(REAL_URL, REAL_EMAIL, REAL_KEY) : undefined,
);

if (gate.kind === 'run') {
  runConformanceSuite('zulip (real)', makeRealContext);
} else if (gate.kind === 'fail') {
  describe('seam conformance: zulip (real)', () => {
    it('runs against the configured PARLEY_ZULIP_* server', () => {
      expect.fail(gate.reason);
    });
  });
} else {
  describe.skip(`seam conformance: zulip (real) — ${gate.reason}`, () => {
    it('not requested', () => undefined);
  });
}
