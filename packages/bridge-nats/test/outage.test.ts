import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, waitFor, waitForAsync } from './helpers.js';
import { startTcpProxy, type TcpProxy } from './tcp-proxy.js';

// Class 1: an outage — of ANY length, including one longer than the driver's own reconnect budget —
// must leave the plugin working. Every seam operation is checked after the heal, live delivery AND
// catch-up from a pre-fault cursor, because the failure mode is silent (the bridge goes deaf).
// Class 2: recovery must BACKFILL the gap, not merely resume: a message published while the
// consumer was absent has to reach the handler, including when nothing was ever delivered before
// the outage (there is no "no gap to backfill yet" case).
const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats network faults', () => {
  const tag = rand();
  const streamPrefix = `PF_${tag}_`;
  const base = { subject_prefix: `pf.${tag}.`, stream_prefix: streamPrefix };

  afterAll(async () => {
    await dropStreams(streamPrefix);
  });

  async function deleteConsumers(topic: Topic): Promise<void> {
    const admin = await connect({ servers: SERVERS });
    const jsm = await admin.jetstreamManager();
    for await (const c of jsm.consumers.list(`${streamPrefix}${topic}`)) {
      await jsm.consumers.delete(`${streamPrefix}${topic}`, c.name).catch(() => undefined);
    }
    await admin.drain();
  }

  async function consumerCount(topic: Topic): Promise<number> {
    const admin = await connect({ servers: SERVERS });
    const jsm = await admin.jetstreamManager();
    let n = 0;
    for await (const _c of jsm.consumers.list(`${streamPrefix}${topic}`)) n += 1;
    await admin.drain();
    return n;
  }

  // nats.js defaults to 10 reconnect attempts / 2s apart: an outage past ~20s closes the connection
  // for good unless the plugin asks for unbounded reconnect.
  const outages = [
    { name: 'a brief blackhole', ms: 4_000 },
    { name: 'a blackhole past the driver reconnect budget', ms: 25_000 },
  ];

  for (const outage of outages) {
    it(`post, fetchRecent and subscribe all recover after ${outage.name}`, async () => {
      const proxy: TcpProxy = await startTcpProxy('127.0.0.1', 4222);
      const sub = new NatsPlugin();
      const pub = new NatsPlugin();
      await sub.connect({ ...base, servers: proxy.address });
      await pub.connect({ ...base, servers: SERVERS });
      try {
        const topic = asTopic(`fault-${rand()}`);
        const got: string[] = [];
        await sub.subscribe(topic, (m) => {
          got.push(m.content);
        });
        await pub.post(topic, asHandle('sys'), 'before');
        await waitFor(() => got.includes('before'), 20000);
        const preFault = (await sub.fetchRecent({ topic })).nextCursor;

        proxy.cut();
        await pub.post(topic, asHandle('sys'), 'during');
        await new Promise((r) => setTimeout(r, outage.ms));
        proxy.heal();
        await pub.post(topic, asHandle('sys'), 'after');

        // (a) live push resumes and backfills what was published during the outage
        await waitFor(() => got.includes('during') && got.includes('after'), 60000);
        expect([...new Set(got)]).toEqual(['before', 'during', 'after']);

        // (b) catch-up from the pre-fault cursor still sees everything
        const page = await sub.fetchRecent({ topic, since: preFault });
        expect(page.messages.map((m) => m.content)).toEqual(['during', 'after']);

        // (c) the write path is alive too
        const id = await sub.post(topic, asHandle('sys'), 'post-heal');
        expect(id).toBeDefined();
        await waitFor(() => got.includes('post-heal'), 30000);
      } finally {
        await sub.disconnect();
        await pub.disconnect();
        await proxy.close();
      }
    }, 120_000);
  }

  const causes = [
    {
      name: 'consumer deleted while the link was down',
      breakIt: async (proxy: TcpProxy, topic: Topic) => {
        proxy.cut();
        await deleteConsumers(topic);
      },
    },
    {
      name: 'connection dropped',
      breakIt: async (proxy: TcpProxy) => {
        proxy.cut();
      },
    },
  ];
  const priors = [
    { name: 'a message was delivered before the outage', pre: 'before' as string | undefined },
    { name: 'nothing had ever been delivered', pre: undefined },
  ];

  for (const cause of causes) {
    for (const prior of priors) {
      it(`backfills the outage gap when ${prior.name} and the ${cause.name}`, async () => {
        const proxy: TcpProxy = await startTcpProxy('127.0.0.1', 4222);
        const sub = new NatsPlugin();
        const pub = new NatsPlugin();
        await sub.connect({ ...base, servers: proxy.address });
        await pub.connect({ ...base, servers: SERVERS });
        try {
          const topic = asTopic(`gap-${rand()}`);
          const got: string[] = [];
          await sub.subscribe(topic, (m) => {
            got.push(m.content);
          });
          const pre = prior.pre;
          if (pre !== undefined) {
            await pub.post(topic, asHandle('sys'), pre);
            await waitFor(() => got.includes(pre), 20000);
          }
          // The consumer must exist before we take it away, or the "outage" is a no-op.
          await waitForAsync(async () => (await consumerCount(topic)) >= 1, 8000);

          await cause.breakIt(proxy, topic);
          // Published while the subscriber has no consumer at all: only a rebuild that resumes at
          // lastSeq+1 can ever deliver it.
          await pub.post(topic, asHandle('sys'), 'during-gap');
          await new Promise((r) => setTimeout(r, 1500));
          proxy.heal();

          await waitFor(() => got.includes('during-gap'), 60000);
          await pub.post(topic, asHandle('sys'), 'after');
          await waitFor(() => got.includes('after'), 30000);

          const expected = prior.pre === undefined ? ['during-gap', 'after'] : ['before', 'during-gap', 'after'];
          expect([...new Set(got)]).toEqual(expected);
        } finally {
          await sub.disconnect();
          await pub.disconnect();
          await proxy.close();
        }
      }, 90_000);
    }
  }
});
