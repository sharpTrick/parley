import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import {
  dropStreams,
  isNatsUp,
  rand,
  SERVERS,
  serverTarget,
  waitFor,
  waitForAsync,
} from './helpers.js';
import { startTcpProxy, type FaultMode, type TcpProxy } from './tcp-proxy.js';

// Class 1: an outage — of ANY length and of EITHER shape — must leave the plugin working. A reset
// and a silent drop are different faults: a reset reaches the driver at once, a drop leaves it
// holding a live-looking socket, which is the case every bounded-wait guard here exists for. Every
// seam operation is checked after the heal, live delivery AND catch-up from a pre-fault cursor,
// because the failure mode is silent (the bridge goes deaf).
// Class 2: recovery must BACKFILL the gap, not merely resume: a message published while the
// consumer was absent has to reach the handler, including when nothing was ever delivered before
// the outage (there is no "no gap to backfill yet" case), and including one the server already
// counted as delivered — `AckPolicy.None` messages written into a dead link are never resent.
// Class 3: every teardown path is bounded under BOTH fault shapes. `disconnect()` runs while the
// link is down more often than not, and an unbounded await there hangs the caller for the outage.
const suite = (await isNatsUp()) ? describe : describe.skip;

const faults: { mode: FaultMode; name: string }[] = [
  { mode: 'reset', name: 'a reset link' },
  { mode: 'stall', name: 'a silently dropped link' },
];

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
    { name: 'a brief outage', ms: 4_000 },
    { name: 'an outage past the driver reconnect budget', ms: 25_000 },
  ];

  for (const fault of faults) {
    for (const outage of outages) {
      it(`post, fetchRecent and subscribe all recover after ${outage.name} on ${fault.name}`, async () => {
        const proxy: TcpProxy = await startTcpProxy(serverTarget().host, serverTarget().port);
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

          proxy.cut(fault.mode);
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
      }, 150_000);
    }
  }

  // The shape no reconnect can repair by itself: the link stalls, the server writes the message
  // into it and — `AckPolicy.None` — counts it delivered, then the socket dies. The consumer
  // resumes PAST that message, so only noticing the hole in the delivery sequence recovers it.
  it('delivers a message the server pushed into a link that was already gone', async () => {
    const proxy: TcpProxy = await startTcpProxy(serverTarget().host, serverTarget().port);
    const sub = new NatsPlugin();
    const pub = new NatsPlugin();
    await sub.connect({ ...base, servers: proxy.address });
    await pub.connect({ ...base, servers: SERVERS });
    try {
      const topic = asTopic(`pushed-${rand()}`);
      const got: string[] = [];
      await sub.subscribe(topic, (m) => {
        got.push(m.content);
      });
      await pub.post(topic, asHandle('sys'), 'before');
      await waitFor(() => got.includes('before'), 20000);

      proxy.cut('stall');
      await pub.post(topic, asHandle('sys'), 'swallowed');
      await new Promise((r) => setTimeout(r, 2000));
      proxy.cut('reset');
      await new Promise((r) => setTimeout(r, 500));
      proxy.heal();

      await pub.post(topic, asHandle('sys'), 'after');
      await waitFor(() => got.includes('after'), 40000);
      expect([...new Set(got)]).toEqual(['before', 'swallowed', 'after']);
    } finally {
      await sub.disconnect();
      await pub.disconnect();
      await proxy.close();
    }
  }, 90_000);

  const teardowns: { name: string; run: (p: NatsPlugin, t: Topic) => Promise<unknown> }[] = [
    { name: 'a subscriber', run: (p, t) => p.subscribe(t, () => undefined) },
    {
      name: 'a long-poll',
      run: async (p, t) => {
        const tail = (await p.fetchRecent({ topic: t })).nextCursor;
        return p.fetchRecent({ topic: t, since: tail, blockMs: 30_000 });
      },
    },
    { name: 'nothing in flight', run: async () => undefined },
  ];

  const TEARDOWN_BUDGET_MS = 15_000;

  for (const fault of faults) {
    for (const teardown of teardowns) {
      it(`disconnect() with ${teardown.name} returns within its budget on ${fault.name}`, async () => {
        const proxy: TcpProxy = await startTcpProxy(serverTarget().host, serverTarget().port);
        const plugin = new NatsPlugin();
        await plugin.connect({ ...base, servers: proxy.address });
        try {
          const topic = asTopic(`teardown-${rand()}`);
          await plugin.post(topic, asHandle('sys'), 'seed');
          const inFlight = teardown.run(plugin, topic);
          await new Promise((r) => setTimeout(r, 500));

          proxy.cut(fault.mode);
          const started = Date.now();
          await plugin.disconnect();
          expect(Date.now() - started).toBeLessThan(TEARDOWN_BUDGET_MS);
          await Promise.resolve(inFlight).catch(() => undefined);
        } finally {
          await proxy.close();
        }
      }, 90_000);
    }
  }

  const causes = [
    {
      name: 'consumer deleted while the link was down',
      breakIt: async (proxy: TcpProxy, topic: Topic) => {
        proxy.cut('reset');
        await deleteConsumers(topic);
      },
    },
    {
      name: 'connection dropped',
      breakIt: async (proxy: TcpProxy) => {
        proxy.cut('reset');
      },
    },
    {
      name: 'link stalled silently',
      breakIt: async (proxy: TcpProxy) => {
        proxy.cut('stall');
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
        const proxy: TcpProxy = await startTcpProxy(serverTarget().host, serverTarget().port);
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

          const expected =
            prior.pre === undefined ? ['during-gap', 'after'] : ['before', 'during-gap', 'after'];
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
