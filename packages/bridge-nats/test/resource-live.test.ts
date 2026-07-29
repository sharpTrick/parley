import { asHandle, asTopic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, waitFor } from './helpers.js';

// Class: a backend resource removed out-of-band must be re-provisioned, not remembered as present —
// `ensured` memoizes success, so a cached "the stream exists" is a lie after `nats stream rm`, and
// every ephemeral consumer must still be gone once its call returns.
// Every test here is server-gated, and the file holds nothing else: if the server is down the WHOLE
// file skips, which CI's skip gate fails on.

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

    // The no-`since` read above is the one shape that cannot fail; replaying the cursor the bridge
    // actually persisted is what exercises a store re-provisioned underneath it.
    it(`catch-up from the pre-removal cursor recovers after ${removal.name}`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect(cfg);
      try {
        const topic = asTopic(`stale-${rand()}`);
        await plugin.post(topic, asHandle('sys'), 'before-1');
        await plugin.post(topic, asHandle('sys'), 'before-2');
        const stale = (await plugin.fetchRecent({ topic })).nextCursor;
        await removal.break(`${streamPrefix}${topic}`);
        await plugin.post(topic, asHandle('sys'), 'after-1');

        const drain = async (from: string): Promise<{ seen: string[]; cursor: string }> => {
          const seen: string[] = [];
          let cursor = from;
          for (let i = 0; i < 6; i++) {
            const page = await plugin.fetchRecent({ topic, since: cursor as never });
            if (page.messages.length === 0) break;
            seen.push(...page.messages.map((m) => m.content));
            cursor = page.nextCursor;
          }
          return { seen, cursor };
        };

        const first = await drain(stale);
        expect(first.seen).toContain('after-1');
        expect(first.cursor).not.toBe(stale);

        await plugin.post(topic, asHandle('sys'), 'after-2');
        expect((await drain(first.cursor)).seen).toContain('after-2');
      } finally {
        await plugin.disconnect();
      }
    }, 30_000);
  }

  for (const removal of removals) {
    it(`subscribe recovers after ${removal.name}`, async () => {
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
        await waitFor(() => got.includes('before'), 20_000);

        await removal.break(`${streamPrefix}${topic}`);

        await pub.post(topic, asHandle('sys'), 'after');
        await waitFor(() => got.includes('after'), 40_000);
        expect(got).toContain('after');
      } finally {
        await sub.disconnect();
        await pub.disconnect();
      }
    }, 90_000);
  }
});
