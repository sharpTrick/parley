import { asHandle, asTopic, type BackendMsgId, type Topic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, waitFor, waitForAsync } from './helpers.js';

// Class 1: a backend resource removed out-of-band must be re-provisioned, not remembered as present —
// `ensured` memoizes success, so a cached "the stream exists" is a lie after `nats stream rm`.
// Class 2: every server-side resource this plugin creates is gone when the call that created it is
// gone — for EVERY path that creates one, not just catch-up. A named ephemeral consumer survives
// its client for `inactive_threshold`, so one orphan per topic per process outlives every restart
// inside that window and accumulates against the server's own limits.
// Class 3: a store re-provisioned under a live bridge must not re-mint an id core has already seen;
// the new incarnation's messages are dropped by core's dedup otherwise, which is exactly the case
// classes 1 and 2 exist to survive.
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

  // Every path that calls `consumers.add`, against both of the states a consumer may legitimately
  // be in: `whileLive` is what the path is entitled to hold open, and nothing may survive teardown.
  const creators: { name: string; whileLive: number; run: (p: NatsPlugin, t: Topic) => Promise<void> }[] =
    [
      {
        name: 'fetchRecent',
        whileLive: 0,
        run: async (plugin, topic) => {
          await plugin.fetchRecent({ topic });
        },
      },
      {
        name: 'a blockMs long-poll',
        whileLive: 0,
        run: async (plugin, topic) => {
          const tail = (await plugin.fetchRecent({ topic })).nextCursor;
          await plugin.fetchRecent({ topic, since: tail, blockMs: 1000 });
        },
      },
      {
        name: 'subscribe',
        whileLive: 1,
        run: async (plugin, topic) => {
          await plugin.subscribe(topic, () => undefined);
          await waitForAsync(
            async () => (await consumerCount(`${streamPrefix}${topic}`)) >= 1,
            10_000,
          );
        },
      },
    ];

  for (const creator of creators) {
    it(`${creator.name} holds ${creator.whileLive} consumer(s) while live and none after disconnect()`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect(cfg);
      const topic = asTopic(`create-${rand()}`);
      try {
        await plugin.post(topic, asHandle('sys'), 'seed');
        await creator.run(plugin, topic);
        expect(await consumerCount(`${streamPrefix}${topic}`)).toBe(creator.whileLive);
      } finally {
        await plugin.disconnect();
      }
      expect(await consumerCount(`${streamPrefix}${topic}`)).toBe(0);
    }, 40_000);
  }

  // The accumulating shape: DESIGN §10 runs one ephemeral bridge per Code session, and a restart
  // inside `inactive_threshold` would otherwise stack an orphan per cycle on the same topic.
  it('repeated connect/subscribe/disconnect cycles leave no consumers behind', async () => {
    const topic = asTopic(`cycles-${rand()}`);
    const stream = `${streamPrefix}${topic}`;
    for (let i = 0; i < 5; i++) {
      const plugin = new NatsPlugin();
      await plugin.connect(cfg);
      try {
        await plugin.subscribe(topic, () => undefined);
        await plugin.post(topic, asHandle('sys'), `cycle-${i}`);
        await waitForAsync(async () => (await consumerCount(stream)) >= 1, 10_000);
      } finally {
        await plugin.disconnect();
      }
    }
    expect(await consumerCount(stream)).toBe(0);
  }, 60_000);

  it('rebuilding after consumer loss does not stack consumers', async () => {
    const plugin = new NatsPlugin();
    await plugin.connect(cfg);
    const topic = asTopic(`rebuild-${rand()}`);
    const stream = `${streamPrefix}${topic}`;
    try {
      const got: string[] = [];
      await plugin.subscribe(topic, (m) => {
        got.push(m.content);
      });
      await plugin.post(topic, asHandle('sys'), 'first');
      await waitFor(() => got.includes('first'), 20_000);

      for (let i = 0; i < 3; i++) {
        const admin = await connect({ servers: SERVERS });
        const jsm = await admin.jetstreamManager();
        for await (const c of jsm.consumers.list(stream)) {
          await jsm.consumers.delete(stream, c.name).catch(() => undefined);
        }
        await admin.drain();
        await plugin.post(topic, asHandle('sys'), `after-${i}`);
        await waitFor(() => got.includes(`after-${i}`), 30_000);
        expect(await consumerCount(stream)).toBeLessThanOrEqual(1);
      }
    } finally {
      await plugin.disconnect();
    }
    expect(await consumerCount(stream)).toBe(0);
  }, 90_000);

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

    // The ids either side of the removal must not overlap: a recreated stream restarts its
    // sequences at 1, and core dedups on backendMsgId, so a reused id is a message core never sees.
    it(`ids minted after ${removal.name} collide with none minted before it`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect(cfg);
      try {
        const topic = asTopic(`ids-${rand()}`);
        const before: BackendMsgId[] = [];
        for (const c of ['b1', 'b2', 'b3']) before.push(await plugin.post(topic, asHandle('sys'), c));
        const readBefore = (await plugin.fetchRecent({ topic })).messages.map((m) => m.backendMsgId);
        expect(readBefore).toEqual(before);

        await removal.break(`${streamPrefix}${topic}`);

        const after: BackendMsgId[] = [];
        for (const c of ['a1', 'a2', 'a3']) after.push(await plugin.post(topic, asHandle('sys'), c));
        const readAfter = (await plugin.fetchRecent({ topic })).messages.map((m) => m.backendMsgId);

        expect(readAfter).toEqual(after);
        const seen = new Set(before.map(String));
        expect(after.map(String).filter((id) => seen.has(id))).toEqual([]);
      } finally {
        await plugin.disconnect();
      }
    }, 30_000);

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
        const got: { content: string; id: BackendMsgId }[] = [];
        await sub.subscribe(topic, (m) => {
          got.push({ content: m.content, id: m.backendMsgId });
        });
        await pub.post(topic, asHandle('sys'), 'before');
        await waitFor(() => got.some((m) => m.content === 'before'), 20_000);

        await removal.break(`${streamPrefix}${topic}`);

        await pub.post(topic, asHandle('sys'), 'after');
        await waitFor(() => got.some((m) => m.content === 'after'), 40_000);
        // Live push must hand core a NEW id for the new incarnation, or dedup eats the message.
        const idOf = (content: string): string =>
          String(got.find((m) => m.content === content)?.id);
        expect(idOf('after')).not.toBe(idOf('before'));
      } finally {
        await sub.disconnect();
        await pub.disconnect();
      }
    }, 90_000);
  }
});
