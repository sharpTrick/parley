import { asHandle, asTopic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
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

const rand = () => Math.random().toString(36).slice(2, 8);

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}

// The audit's "Reconnect & liveness" case for NATS (BUG-02): a live subscription whose ephemeral
// pull consumer is GC'd server-side must detect the loss and re-establish delivery — recreating the
// consumer at DeliverPolicy.StartSequence lastSeq+1 so the outage gap is backfilled. We simulate the
// server-side GC by deleting the consumer out-of-band, which the old code never noticed (silent
// death). Network-gated: skipped unless a JetStream server answers at PARLEY_NATS_SERVERS.
const suite = (await isNatsUp(SERVERS)) ? describe : describe.skip;

suite('nats recovery — BUG-02: live subscription survives ephemeral-consumer loss', () => {
  const tag = rand();
  const cfg = { servers: SERVERS, subject_prefix: `pt.${tag}.`, stream_prefix: `PT_${tag}_` };

  afterAll(async () => {
    const nc = await connect({ servers: SERVERS });
    const jsm = await nc.jetstreamManager();
    for await (const s of jsm.streams.list()) {
      if (s.config.name.startsWith(`PT_${tag}_`)) {
        await jsm.streams.delete(s.config.name).catch(() => undefined);
      }
    }
    await nc.drain();
  });

  it('recreates the consumer and resumes delivery after the consumer is deleted', async () => {
    const sub = new NatsPlugin();
    const pub = new NatsPlugin();
    await sub.connect(cfg);
    await pub.connect(cfg);
    try {
      const topic = asTopic(`recover-${rand()}`);
      const got: string[] = [];
      await sub.subscribe(topic, (m) => {
        got.push(m.content);
      });

      // Creates the stream and lets the async subscribe loop bring its consumer up; confirms the
      // live path works and pins lastSeq before the loss.
      await pub.post(topic, asHandle('sys'), 'before');
      await waitFor(() => got.includes('before'), 8000);

      // Simulate the server GC'ing the ephemeral consumer: delete every consumer on this run's
      // stream(s) out-of-band. The plugin's status watch must see ConsumerDeleted/ConsumerNotFound
      // and rebuild the consumer at lastSeq+1.
      const admin = await connect({ servers: SERVERS });
      const jsm = await admin.jetstreamManager();
      for await (const s of jsm.streams.list()) {
        if (!s.config.name.startsWith(`PT_${tag}_`)) continue;
        for await (const c of jsm.consumers.list(s.config.name)) {
          await jsm.consumers.delete(s.config.name, c.name).catch(() => undefined);
        }
      }
      await admin.drain();

      // A post after the loss must still reach the handler once the consumer is re-established.
      await pub.post(topic, asHandle('sys'), 'after');
      await waitFor(() => got.includes('after'), 15000);

      expect(got).toContain('before');
      expect(got).toContain('after');
    } finally {
      await sub.disconnect();
      await pub.disconnect();
    }
  });

  it('a clean disconnect() stops the subscribe loop (no recreate storm)', async () => {
    const sub = new NatsPlugin();
    const pub = new NatsPlugin();
    await sub.connect(cfg);
    await pub.connect(cfg);

    const topic = asTopic(`teardown-${rand()}`);
    const got: string[] = [];
    await sub.subscribe(topic, (m) => {
      got.push(m.content);
    });
    await pub.post(topic, asHandle('sys'), 'live');
    await waitFor(() => got.includes('live'), 8000);

    // Clean teardown: the registered closer stops whichever iterator is live; the loop must not
    // rebuild afterwards.
    await sub.disconnect();
    got.length = 0;

    await pub.post(topic, asHandle('sys'), 'post-teardown');
    await new Promise((r) => setTimeout(r, 2000));
    expect(got).not.toContain('post-teardown');

    await pub.disconnect();
  });
});
