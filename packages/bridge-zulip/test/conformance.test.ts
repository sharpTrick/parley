import { runConformanceSuite, type ConformanceContext } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { startFakeZulip } from './fake-zulip.js';

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

/** The in-process fake — always available, so this suite always runs. */
async function makeContext(): Promise<ConformanceContext> {
  const fake = await startFakeZulip();
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 1000 });
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
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

describe('zulip queue GC recovery', () => {
  it('BAD_EVENT_QUEUE_ID → re-register + gap-fill delivers the dead-window message once', async () => {
    // Short heartbeat/timeout so the loop discovers the dead queue quickly.
    const fake = await startFakeZulip({ heartbeatMs: 200 });
    const plugin = new ZulipPlugin();
    await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
    try {
      const topic = asTopic(`gc-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      await plugin.post(topic, asHandle('w'), 'before');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000, interval: 10 });

      // Kill every queue server-side (Zulip's ~10-min-idle GC / a restart), then post while the
      // queue is dead — the message reaches nobody's queue and MUST arrive via gap-fill.
      fake.gcQueues();
      await plugin.post(topic, asHandle('w'), 'during');

      await vi.waitFor(
        () => expect(got.map((m) => m.content)).toEqual(['before', 'during']),
        { timeout: 5000, interval: 10 },
      );
      // Settle: the fresh queue must not re-deliver what gap-fill already handed over.
      await new Promise((r) => setTimeout(r, 400));
      expect(got.map((m) => m.content)).toEqual(['before', 'during']);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('BUG-15: gap-fill read throws once → the dead-window message still arrives via retry, once', async () => {
    const fake = await startFakeZulip({ heartbeatMs: 200 });
    const plugin = new ZulipPlugin();
    await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
    try {
      const topic = asTopic(`gc-fail-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      await plugin.post(topic, asHandle('w'), 'before');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000, interval: 10 });

      // Kill the queue AND make the first post-GC gap-fill history read throw (proxy 502). Under
      // the old one-shot recovery, 'during' would be lost forever (delivered on neither queue);
      // with the tracked retry, the top-of-loop gap-fill re-attempts until it succeeds.
      fake.gcQueues();
      fake.failNextMessagesRead();
      await plugin.post(topic, asHandle('w'), 'during');

      await vi.waitFor(
        () => expect(got.map((m) => m.content)).toEqual(['before', 'during']),
        { timeout: 5000, interval: 10 },
      );
      // Settle: no duplicate from the fresh queue's overlap, no double-delivery from the retry.
      await new Promise((r) => setTimeout(r, 400));
      expect(got.map((m) => m.content)).toEqual(['before', 'during']);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('BUG-15: several gap-fill reads throw → the dead-window messages all arrive exactly once', async () => {
    const fake = await startFakeZulip({ heartbeatMs: 200 });
    const plugin = new ZulipPlugin();
    await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
    try {
      const topic = asTopic(`gc-fail-n-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      await plugin.post(topic, asHandle('w'), 'before');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000, interval: 10 });

      // Kill the queue, fail the first THREE gap-fill reads, and drop several messages into the
      // dead window — the top-of-loop retry must eventually deliver them all, none twice.
      fake.gcQueues();
      fake.failMessagesReads(3);
      await plugin.post(topic, asHandle('w'), 'd1');
      await plugin.post(topic, asHandle('w'), 'd2');
      await plugin.post(topic, asHandle('w'), 'd3');

      await vi.waitFor(
        () => expect(got.map((m) => m.content)).toEqual(['before', 'd1', 'd2', 'd3']),
        { timeout: 6000, interval: 10 },
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(got.map((m) => m.content)).toEqual(['before', 'd1', 'd2', 'd3']);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

describe('zulip resolveIdentity', () => {
  it('maps email or full_name to the Zulip user_id, and misses to the string convention', async () => {
    const fake = await startFakeZulip();
    const plugin = new ZulipPlugin();
    await plugin.connect({ site_url: fake.url });
    try {
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
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Optional second run against a REAL Zulip server. Fresh topics in the configured stream are
// free, so no scratch cleanup is needed beyond disconnect.
const REAL_URL = process.env.PARLEY_ZULIP_URL;
const REAL_EMAIL = process.env.PARLEY_ZULIP_EMAIL;
const REAL_KEY = process.env.PARLEY_ZULIP_API_KEY;
const REAL_STREAM = process.env.PARLEY_ZULIP_STREAM ?? 'parley';

async function isZulipUp(url: string, email: string, key: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/users`, {
      headers: { Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
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
    freshTopic: (): Topic => asTopic(`t-${++seq}-${rand()}`),
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

if (
  REAL_URL !== undefined &&
  REAL_EMAIL !== undefined &&
  REAL_KEY !== undefined &&
  (await isZulipUp(REAL_URL, REAL_EMAIL, REAL_KEY))
) {
  runConformanceSuite('zulip (real)', makeRealContext);
} else {
  describe.skip('seam conformance: zulip (real) (set PARLEY_ZULIP_URL/_EMAIL/_API_KEY to run)', () => {
    it('skipped — point PARLEY_ZULIP_* at a live Zulip to run', () => undefined);
  });
}
