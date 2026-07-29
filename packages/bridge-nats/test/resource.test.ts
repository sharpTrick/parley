import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload } from './fake-jetstream.js';
import { dropStreams, isNatsUp, rand, SERVERS } from './helpers.js';

// Class 1: every server-side resource this plugin creates is destroyed on EVERY exit path — a throw
// between creating an ephemeral consumer and deleting it leaks one per call, and a flapping link
// with per-topic polling accumulates them.
// Class 2: a backend resource removed out-of-band must be re-provisioned, not remembered as present
// — `ensured` memoizes success, so a cached "the stream exists" is a lie after `nats stream rm`.
const STREAM = 'PARLEY_leak';
const TOPIC = asTopic('leak');

const readPaths = [
  {
    name: 'fetchRecent',
    records: [{ seq: 1, data: payload('a') }],
    run: (p: NatsPlugin) => p.fetchRecent({ topic: TOPIC }),
    propagates: true,
  },
  {
    name: 'blockMs long-poll',
    records: [],
    run: (p: NatsPlugin) => p.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 1000 }),
    propagates: false,
  },
];
const faults: ('get' | 'fetch' | 'iterate' | null)[] = [null, 'get', 'fetch', 'iterate'];

describe('nats resource hygiene — no ephemeral consumer survives its call', () => {
  for (const path of readPaths) {
    for (const failOn of faults) {
      it(`${path.name} destroys its consumer when the read ${failOn === null ? 'succeeds' : `throws in ${failOn}`}`, async () => {
        const fake = fakeJetStream({ records: path.records, failOn });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, STREAM);

        const outcome = await path.run(plugin).then(
          () => 'resolved',
          () => 'rejected',
        );
        if (failOn !== null && path.propagates) expect(outcome).toBe('rejected');

        expect(fake.state.created.length).toBeGreaterThanOrEqual(1);
        expect(fake.state.deleted).toEqual(fake.state.created);
      });
    }
  }
});

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats resource hygiene against a live server', () => {
  const tag = rand();
  const streamPrefix = `PR_${tag}_`;
  const cfg = { servers: SERVERS, subject_prefix: `pr.${tag}.`, stream_prefix: streamPrefix };

  afterAll(async () => {
    await dropStreams(streamPrefix);
  });

  async function consumerCount(stream: string): Promise<number> {
    const admin = await connect({ servers: SERVERS });
    const jsm = await admin.jetstreamManager();
    let n = 0;
    for await (const _c of jsm.consumers.list(stream)) n += 1;
    await admin.drain();
    return n;
  }

  it('repeated catch-up leaves no consumers behind on the stream', async () => {
    const plugin = new NatsPlugin();
    await plugin.connect(cfg);
    try {
      const topic = asTopic(`hygiene-${rand()}`);
      await plugin.post(topic, asHandle('sys'), 'one');
      for (let i = 0; i < 5; i++) await plugin.fetchRecent({ topic });
      const page = await plugin.fetchRecent({ topic });
      await plugin.fetchRecent({ topic, since: page.nextCursor, blockMs: 1000 });
      expect(await consumerCount(`${streamPrefix}${topic}`)).toBe(0);
    } finally {
      await plugin.disconnect();
    }
  });

  const removals = [
    {
      name: 'the stream is deleted out-of-band',
      break: async (stream: string) => {
        const admin = await connect({ servers: SERVERS });
        const jsm = await admin.jetstreamManager();
        await jsm.streams.delete(stream);
        await admin.drain();
      },
    },
    {
      name: 'the stream is purged out-of-band',
      break: async (stream: string) => {
        const admin = await connect({ servers: SERVERS });
        const jsm = await admin.jetstreamManager();
        await jsm.streams.purge(stream);
        await admin.drain();
      },
    },
  ];

  for (const removal of removals) {
    it(`post and fetchRecent still work after ${removal.name}`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect(cfg);
      try {
        const topic = asTopic(`gone-${rand()}`);
        await plugin.post(topic, asHandle('sys'), 'before');
        await removal.break(`${streamPrefix}${topic}`);

        const id = await plugin.post(topic, asHandle('sys'), 'after');
        expect(id).toBeDefined();
        const page = await plugin.fetchRecent({ topic });
        expect(page.messages.map((m) => m.content)).toContain('after');
      } finally {
        await plugin.disconnect();
      }
    });
  }

  it('subscribe recovers when the stream itself is deleted out-of-band', async () => {
    const sub = new NatsPlugin();
    const pub = new NatsPlugin();
    await sub.connect(cfg);
    await pub.connect(cfg);
    try {
      const topic = asTopic(`streamgone-${rand()}`);
      const got: string[] = [];
      await sub.subscribe(topic, (m) => {
        got.push(m.content);
      });
      await pub.post(topic, asHandle('sys'), 'before');
      const deadline = Date.now() + 8000;
      while (!got.includes('before') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const admin = await connect({ servers: SERVERS });
      const jsm = await admin.jetstreamManager();
      await jsm.streams.delete(`${streamPrefix}${topic}`);
      await admin.drain();

      await pub.post(topic, asHandle('sys'), 'after');
      const deadline2 = Date.now() + 20000;
      while (!got.includes('after') && Date.now() < deadline2) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(got).toContain('after');
    } finally {
      await sub.disconnect();
      await pub.disconnect();
    }
  }, 60_000);
});
