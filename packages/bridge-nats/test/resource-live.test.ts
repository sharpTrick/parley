import { asCursor, asHandle, asTopic, type BackendMsgId, type Topic } from '@sharptrick/parley-core';
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

  async function streamsUnder(prefix: string): Promise<string[]> {
    const admin = await connect({ servers: SERVERS });
    const jsm = await admin.jetstreamManager();
    const names: string[] = [];
    for await (const s of jsm.streams.list()) {
      if (s.config.name.startsWith(prefix)) names.push(s.config.name);
    }
    await admin.drain();
    return names;
  }

  /** A private prefix pair, so a stream count is this test's own and not the whole file's. */
  const ownConfig = (kind: string): { prefix: string; cfg: Record<string, string> } => {
    const tag = rand();
    const prefix = `${kind}_${tag}_`;
    return {
      prefix,
      cfg: { servers: SERVERS, subject_prefix: `${kind.toLowerCase()}.${tag}.`, stream_prefix: prefix },
    };
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  // Class 4: which seam methods may leave a DURABLE server-side object behind — a stream, unlike a
  // consumer, has no `inactive_threshold` to reclaim it and `retention_days` is unset by default, so
  // one created by a read is permanent. Stated as every method against both pre-states, so the
  // permission is granted per method and a method (or a future `ensureStream` call site) added later
  // has no row saying it may provision.
  const streamCreators: {
    name: string;
    provisions: boolean;
    run: (plugin: NatsPlugin, topic: Topic) => Promise<unknown>;
  }[] = [
    { name: 'post', provisions: true, run: (p, t) => p.post(t, asHandle('sys'), 'x') },
    { name: 'subscribe', provisions: true, run: (p, t) => p.subscribe(t, () => undefined) },
    { name: 'fetchRecent with no since', provisions: false, run: (p, t) => p.fetchRecent({ topic: t }) },
    {
      name: 'fetchRecent from a since',
      provisions: false,
      run: (p, t) => p.fetchRecent({ topic: t, since: asCursor('0') }),
    },
    {
      name: 'a blockMs long-poll',
      provisions: false,
      run: (p, t) => p.fetchRecent({ topic: t, since: asCursor('0'), blockMs: 300 }),
    },
    { name: 'resolveIdentity', provisions: false, run: (p) => p.resolveIdentity(asHandle('sys')) },
  ];

  const preStates = [
    { name: 'a never-posted topic', seeded: false },
    { name: 'a topic that was posted to', seeded: true },
  ];

  for (const creator of streamCreators) {
    for (const pre of preStates) {
      const expected = pre.seeded || creator.provisions ? 1 : 0;
      it(`${creator.name} on ${pre.name} leaves ${expected} stream(s) on the cluster`, async () => {
        const own = ownConfig('PS');
        const plugin = new NatsPlugin();
        await plugin.connect(own.cfg);
        const topic = asTopic('probe');
        try {
          if (pre.seeded) await plugin.post(topic, asHandle('sys'), 'seed');
          await creator.run(plugin, topic);
          expect(await streamsUnder(own.prefix)).toHaveLength(expected);
        } finally {
          await plugin.disconnect();
          await dropStreams(own.prefix);
        }
      }, 40_000);
    }
  }

  // The abuse shape the table above prices one call at a time: `post_topics` is a regex, so a
  // prompt-injected agent can name topics freely, and a read that provisions turns a loop of empty
  // pages into a permanent charge on the operator's cluster.
  it('twenty catch-up reads on never-posted topics add no streams at all', async () => {
    const own = ownConfig('PB');
    const plugin = new NatsPlugin();
    await plugin.connect(own.cfg);
    try {
      for (let i = 0; i < 20; i++) {
        const page = await plugin.fetchRecent({ topic: asTopic(`fresh-${i}-${rand()}`) });
        expect(page.messages).toEqual([]);
      }
      expect(await streamsUnder(own.prefix)).toEqual([]);
    } finally {
      await plugin.disconnect();
      await dropStreams(own.prefix);
    }
  }, 60_000);

  // What a read of a topic with no stream owes its caller: not creating one is only correct if the
  // cursor it hands back still sits below whatever the peer's first `post` lands.
  it('the cursor from a read of a never-posted topic replays everything posted after it', async () => {
    const own = ownConfig('PA');
    const plugin = new NatsPlugin();
    await plugin.connect(own.cfg);
    const topic = asTopic('later');
    try {
      const first = await plugin.fetchRecent({ topic });
      expect(first.messages).toEqual([]);
      const again = await plugin.fetchRecent({ topic, since: first.nextCursor });
      expect(again).toEqual({ messages: [], nextCursor: first.nextCursor });

      // Drained in pages SMALLER than the history: a cursor the plugin judges to be from a dead
      // incarnation is served the NEWEST window instead of the oldest, so it still returns messages
      // while silently skipping the ones below — invisible whenever one page covers everything.
      const posted = ['m1', 'm2', 'm3', 'm4', 'm5'];
      for (const c of posted) await plugin.post(topic, asHandle('sys'), c);
      const seen: string[] = [];
      let cursor = first.nextCursor;
      for (let page = 0; page < 20; page++) {
        const read = await plugin.fetchRecent({ topic, since: cursor, limit: 2 });
        if (read.messages.length === 0) break;
        seen.push(...read.messages.map((m) => m.content));
        cursor = read.nextCursor;
      }
      expect(seen).toEqual(posted);
    } finally {
      await plugin.disconnect();
      await dropStreams(own.prefix);
    }
  }, 40_000);

  // Class 5: a teardown landing at an ARBITRARY point of a resource's bring-up leaves nothing
  // behind. The offsets either side of a round trip are the discriminating ones — a closer that
  // reads the consumer's name before the call that mints it deletes nothing, and the orphan lingers
  // for `inactive_threshold`. The cycle test below cannot see this: it waits for the consumer to
  // exist before disconnecting, which is deliberately stepping past the window.
  const teardownOffsets = [0, 1, 2, 3, 5, 10, 25, 100, 400];

  // `begin` returns when the CALLER's call has returned, which is what fixes where the offset is
  // measured from: `subscribe` resolves as soon as its background loop is running, so offset 0 is
  // that loop's first `consumers.add` in flight. A read has not returned yet at that point, so it
  // is only issued. Awaiting the wrong one of these sweeps a window with no consumer in it.
  const inFlight: { name: string; begin: (plugin: NatsPlugin, topic: Topic) => Promise<void> }[] = [
    {
      name: 'subscribe',
      begin: async (plugin, topic) => {
        await plugin.subscribe(topic, () => undefined);
      },
    },
    {
      name: 'fetchRecent',
      begin: async (plugin, topic) => {
        void plugin.fetchRecent({ topic }).catch(() => undefined);
      },
    },
    {
      name: 'a blockMs long-poll',
      begin: async (plugin, topic) => {
        void plugin
          .fetchRecent({ topic, since: asCursor('0'), blockMs: 5000 })
          .catch(() => undefined);
      },
    },
  ];

  for (const flight of inFlight) {
    it(`disconnect() at any offset of ${flight.name}'s bring-up leaves no consumer`, async () => {
      const own = ownConfig('PT');
      const topic = asTopic('torn');
      const stream = `${own.prefix}torn`;
      const seed = new NatsPlugin();
      await seed.connect(own.cfg);
      await seed.post(topic, asHandle('sys'), 'seed');
      await seed.disconnect();
      try {
        const left: string[] = [];
        for (const offset of teardownOffsets) {
          const plugin = new NatsPlugin();
          await plugin.connect(own.cfg);
          await flight.begin(plugin, topic);
          await sleep(offset);
          await plugin.disconnect();
          left.push(`${offset}ms:${await consumerCount(stream)}`);
        }
        // Asserted as the whole sweep, so a leak at one offset names the offset AND proves the
        // count never grew across the cycles that followed it.
        expect(left).toEqual(teardownOffsets.map((offset) => `${offset}ms:0`));
      } finally {
        await dropStreams(own.prefix);
      }
    }, 90_000);
  }

  // Class 6: a seam-call SEQUENCE releases everything it took, whichever order it was called in.
  // The one ordering the rest of the suite exercises — connect/disconnect/connect — is the one that
  // happens to be safe; a second `connect()` over a live link is the interesting one, because an
  // abandoned NATS connection keeps reconnecting forever and `disconnect()` only ever closes the
  // most recent.
  const tcpHandles = (): number =>
    process.getActiveResourcesInfo().filter((h) => h === 'TCPSocketWrap').length;

  const lifecycles: {
    name: string;
    run: (plugin: NatsPlugin, topic: Topic, cfg: Record<string, string>) => Promise<void>;
  }[] = [
    {
      name: 'connect/connect',
      run: async (p, _t, cfg) => {
        await p.connect(cfg);
        await p.connect(cfg).catch(() => undefined);
      },
    },
    {
      name: 'connect/disconnect/connect',
      run: async (p, _t, cfg) => {
        await p.connect(cfg);
        await p.disconnect();
        await p.connect(cfg);
      },
    },
    {
      name: 'connect/subscribe/connect',
      run: async (p, topic, cfg) => {
        await p.connect(cfg);
        await p.subscribe(topic, () => undefined);
        await p.connect(cfg).catch(() => undefined);
      },
    },
    {
      name: 'disconnect without connect',
      run: async (p) => {
        await p.disconnect();
      },
    },
    {
      name: 'connect/disconnect/disconnect',
      run: async (p, _t, cfg) => {
        await p.connect(cfg);
        await p.disconnect();
        await p.disconnect();
      },
    },
  ];

  for (const life of lifecycles) {
    it(`${life.name} leaves no socket and no consumer once disconnected`, async () => {
      const own = ownConfig('PL');
      const topic = asTopic('life');
      const stream = `${own.prefix}life`;
      const seed = new NatsPlugin();
      await seed.connect(own.cfg);
      await seed.post(topic, asHandle('sys'), 'seed');
      await seed.disconnect();
      await sleep(500); // let the seed's socket finish closing before the baseline is read
      const baseline = tcpHandles();

      const plugin = new NatsPlugin();
      try {
        await life.run(plugin, topic, own.cfg);
      } finally {
        await plugin.disconnect();
      }
      await waitForAsync(async () => tcpHandles() <= baseline, 15_000);
      expect(await consumerCount(stream)).toBe(0);
      await dropStreams(own.prefix);
    }, 60_000);
  }

  it('a second connect() is refused, naming disconnect()', async () => {
    const own = ownConfig('PC');
    const plugin = new NatsPlugin();
    await plugin.connect(own.cfg);
    try {
      await expect(plugin.connect(own.cfg)).rejects.toThrow(/disconnect\(\)/);
    } finally {
      await plugin.disconnect();
      await dropStreams(own.prefix);
    }
  }, 30_000);

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
