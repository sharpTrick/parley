import { readFileSync } from 'node:fs';
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { coldRestart, contentsOf, SENDER, seqOf, startRig } from './rig.js';

/**
 * A foreign message accepted just before our own post (so a LOWER message_id) but delivered to
 * the bridge AFTER it must still reach the subscriber — delivery keys off the store's dedup
 * set, never a watermark our own post advanced past it.
 */
describe('telegram own-post race', () => {
  it('delivers a foreign message ingested after our higher-id post', async () => {
    const rig = await startRig();
    const chat = '-1005555555';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m)); // watermark 0 (empty store)

    // Foreign message accepted FIRST (lower message_id) but withheld from getUpdates...
    const foreign = rig.fake.injectUserMessageDeferred(chat, 'bob', 'earlier');
    // ...our post runs next and gets a HIGHER message_id (own send ingested synchronously).
    const ownId = await rig.plugin.post(topic, SENDER, 'ours');
    const ownMid = Number((ownId as string).split(':')[1]);
    expect(foreign.messageId).toBeLessThan(ownMid);
    // Only now does the earlier foreign update reach the bridge (after our post resolved).
    foreign.release();

    await vi.waitFor(
      () => expect([...live].map((m) => m.content).sort()).toEqual(['earlier', 'ours']),
      { timeout: 3000, interval: 10 },
    );
    // Catch-up is ordered by OBSERVATION, not by message_id: 'ours' was seen first (from the
    // sendMessage response), so the later-delivered 'earlier' sorts after it — and therefore
    // above every cursor already issued, instead of below them where nothing could reach it.
    expect(await contentsOf(rig.plugin, topic)).toEqual(['ours', 'earlier']);
  });

  /**
   * The same race at a NON-ZERO watermark, which is where an agent actually lives: it catches up
   * to the tail, subscribes, and holds that cursor. A late arrival must reach it through ONE of
   * the two paths — a message that is below the cursor and below the watermark is reachable
   * through neither, and the Bot API has no history endpoint that could ever hand it back.
   */
  it.each([0, 1, 5, 20])(
    'a late-delivered foreign message stays reachable with %i messages already in the topic',
    async (depth) => {
      const rig = await startRig();
      const chat = '-1005556000';
      const topic = asTopic(chat);
      for (let i = 0; i < depth; i++) await rig.plugin.post(topic, SENDER, `prior-${i}`);

      const foreign = rig.fake.injectUserMessageDeferred(chat, 'bob', 'earlier');
      await rig.plugin.post(topic, SENDER, 'ours');
      // The documented startup: catch up to the tail, then subscribe from it.
      const tail = (await rig.plugin.fetchRecent({ topic, limit: 1000 })).nextCursor;
      const live: Message[] = [];
      await rig.plugin.subscribe(topic, (m) => live.push(m));
      foreign.release();

      await vi.waitFor(
        async () => {
          const caughtUp = (await rig.plugin.fetchRecent({ topic, since: tail, limit: 1000 }))
            .messages;
          expect([...live, ...caughtUp].map((m) => m.content)).toContain('earlier');
        },
        { timeout: 5000, interval: 20 },
      );
    },
  );

  /**
   * Generalized: whatever order deferred foreign messages and our own posts interleave in,
   * catch-up from a cursor must return EVERY message the store admitted after that cursor.
   */
  it('catch-up from a cursor returns every message observed after it, under random interleaving', async () => {
    const rig = await startRig();
    const chat = '-1005556001';
    const topic = asTopic(chat);
    await rig.plugin.post(topic, SENDER, 'seed');
    const tail = (await rig.plugin.fetchRecent({ topic, limit: 1000 })).nextCursor;
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));

    const deferred: { release(): void }[] = [];
    const K = 6;
    for (let i = 0; i < K; i++) {
      deferred.push(rig.fake.injectUserMessageDeferred(chat, 'bob', `foreign-${i}`));
      await rig.plugin.post(topic, SENDER, `ours-${i}`);
    }
    // Deterministic shuffle: a failing order must be reproducible.
    let seed = 12_345;
    const order = [...deferred.keys()];
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    for (const i of order) deferred[i]?.release();

    const expected = [
      ...Array.from({ length: K }, (_, i) => `foreign-${i}`),
      ...Array.from({ length: K }, (_, i) => `ours-${i}`),
    ];
    await vi.waitFor(
      async () => {
        const caughtUp = (await rig.plugin.fetchRecent({ topic, since: tail, limit: 1000 })).messages;
        expect([...caughtUp, ...live].map((m) => m.content).sort()).toEqual(
          expect.arrayContaining(expected.sort()),
        );
      },
      { timeout: 8000, interval: 25 },
    );
    const all = await contentsOf(rig.plugin, topic);
    const caughtUp = (await rig.plugin.fetchRecent({ topic, since: tail, limit: 1000 })).messages;
    expect(caughtUp.map((m) => m.content)).toEqual(all.slice(1));
    expect(live.map((m) => m.content).sort()).toEqual(all.slice(1).sort());
  }, 20_000);
});

/**
 * "History is owned by catch-up, not push" — the property a per-subscriber watermark used to claim
 * to implement while never once firing. What actually holds it is that ingest runs only for a record
 * `store.append` has just stamped, so nothing already in the store can reach a subscriber. That is
 * invisible in a suite that only ever subscribes to an empty topic, so each depth here has real
 * history behind the subscribe point, and own posts and late-delivered foreign messages are
 * interleaved across it: the subscriber must receive EXACTLY what was admitted after it registered,
 * in ascending observation order, and nothing from before — a replay would hand an agent messages
 * below the cursor it is already holding.
 */
describe('telegram push starts at the subscribe point', () => {
  const CHAT = '-1005558000';

  it.each([0, 1, 7])('a subscriber behind %i already-observed messages sees only what follows', async (depth) => {
    const rig = await startRig();
    const topic = asTopic(CHAT);
    for (let i = 0; i < depth; i++) await rig.plugin.post(topic, SENDER, `history-${i}`);
    rig.fake.injectUserMessage(CHAT, 'bob', 'history-foreign');
    const history = [...Array.from({ length: depth }, (_, i) => `history-${i}`), 'history-foreign'];
    await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toEqual(history), {
      timeout: 5000,
      interval: 10,
    });

    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));
    // Interleaved after the subscribe point: a deferred foreign message is accepted BEFORE our own
    // post and delivered after it, which is the one ordering a message_id-based scheme gets wrong.
    const deferred = rig.fake.injectUserMessageDeferred(CHAT, 'bob', 'after-foreign');
    await rig.plugin.post(topic, SENDER, 'after-own');
    deferred.release();

    await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after-foreign'), {
      timeout: 5000,
      interval: 10,
    });
    expect(live.map((m) => m.content)).toEqual(['after-own', 'after-foreign']);
    const sequences = live.map((m) => seqOf(m.cursor as string));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(Math.min(...sequences)).toBeGreaterThan(history.length);
  }, 20_000);
});

/**
 * The once-only guarantee, from the plugin's side. Telegram retains an unacknowledged `getUpdates`
 * backlog and re-serves it — that is what the README calls "dedup across `getUpdates` backlog
 * replays … the store's dedup makes that replay harmless" — so the same `<chat>:<message_id>`
 * really does arrive twice, in the same session and across a restart. Each cell asserts the whole
 * consequence: one record, one cursor, one live push, one line on disk.
 *
 * The second axis is the RETENTION state of the record when the copy lands, because the dedup set IS
 * the once-only guarantee: a store that forgets an id when retention evicts its record re-admits the
 * copy under a FRESH observation sequence — the same `backendMsgId` at two cursors, the second one
 * ABOVE the cursor the agent holds and out of observation order, which core cannot absorb (its dedup
 * is a bounded in-memory LRU). Every route is therefore graded with the record still retained and
 * with retention already past it, including past the compaction that drops its line from the file.
 */
describe('telegram observes each message once', () => {
  const CHAT = '-1009777001';
  const ROUTES = [
    'redelivered in the same session',
    'redelivered after a cold restart',
    "redelivered as the bridge's own post",
  ] as const;

  const RETENTIONS = [
    { at: 'retained', config: {}, retention: Number.POSITIVE_INFINITY, newer: 0 },
    { at: 'the retention bound', config: { observed_retention_per_chat: 2 }, retention: 2, newer: 0 },
    { at: 'evicted', config: { observed_retention_per_chat: 2 }, retention: 2, newer: 2 },
    {
      at: 'evicted and compacted out of the file',
      config: { observed_retention_per_chat: 1 },
      retention: 1,
      newer: 3,
    },
  ];

  const CELLS = ROUTES.flatMap((route) => RETENTIONS.map((state) => ({ route, ...state })));

  it.each(CELLS)(
    'a message $route while $at is stored, pushed and served exactly once',
    async ({ route, config, retention, newer }) => {
      const rig = await startRig(config);
      const topic = asTopic(CHAT);
      const own = route === "redelivered as the bridge's own post";
      const content = own ? 'ours' : 'once';
      const messageId = own
        ? Number(((await rig.plugin.post(topic, SENDER, content)) as string).split(':')[1])
        : rig.fake.injectUserMessage(CHAT, 'alice', content);

      // Newer traffic drives the original past the retention bound BEFORE its copy arrives; drained
      // first, so the live subscriber below only ever sees what the replay itself produces.
      const fillers = Array.from({ length: newer }, (_, i) => `newer-${i}`);
      for (const f of fillers) rig.fake.injectUserMessage(CHAT, 'alice', f);
      const settled = [content, ...fillers];
      const retainedTail = (of: string[]): string[] => of.slice(-Math.min(retention, of.length));
      await vi.waitFor(
        async () => expect(await contentsOf(rig.plugin, topic)).toEqual(retainedTail(settled)),
        { timeout: 5000, interval: 10 },
      );

      // A live subscriber established BEFORE the replay: the duplicate must not reach it.
      const restarted = route === 'redelivered after a cold restart' ? await coldRestart(rig) : rig.plugin;
      const live: Message[] = [];
      await restarted.subscribe(topic, (m) => live.push(m));

      rig.fake.injectRaw(CHAT, {
        message_id: messageId,
        from: { id: 5, is_bot: own, username: own ? 'parley_test_bot' : 'alice' },
        text: content,
      });
      // A trailing distinct message pins the point at which the replay has been consumed.
      rig.fake.injectUserMessage(CHAT, 'alice', 'after');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after'), {
        timeout: 5000,
        interval: 10,
      });

      expect(live.map((m) => m.content)).toEqual(['after']);
      const kept = retainedTail([...settled, 'after']);
      const page = await restarted.fetchRecent({ topic, limit: 100 });
      expect(page.messages.map((m) => m.content)).toEqual(kept);
      expect(new Set(page.messages.map((m) => m.cursor)).size).toBe(kept.length);
      // And once on disk. The file trails the retained window by up to one compaction, so what is
      // pinned here is the composite ids it carries: never the same one twice, and never a second
      // copy of the replayed message — the dedup memory a compaction persists is not a record.
      const ids = readFileSync(rig.storePath, 'utf8')
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => {
          const rec = JSON.parse(l) as { chat_id: string; message_id: number };
          return `${rec.chat_id}:${rec.message_id}`;
        });
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id === `${CHAT}:${messageId}`)).toHaveLength(
        kept.includes(content) ? 1 : 0,
      );
      expect(ids.length).toBeGreaterThanOrEqual(kept.length);
    },
    20_000,
  );
});

/**
 * The live-subscription REGISTRY itself. It is a list per chat, deliberately — `chat_map` can give
 * one chat two topic names, and each subscriber has to be stamped with the topic IT named the chat
 * by — so the registry has a fan-out and a teardown, and neither was graded anywhere: deleting the
 * push into the per-chat list, and deleting the clear that `disconnect` does, each left the whole
 * suite green. A registry that silently collapses to one slot, or that carries a torn-down
 * connection's handlers into the next one, is exactly what "live push" means here.
 *
 * Graded through the public seam only, over the registry SHAPES rather than one of them, with the
 * subscriber COUNT as an axis so that a collapse to a single slot fails on N>1 instead of being
 * invisible to one hand-picked case.
 */
describe('telegram live subscription registry', () => {
  const CHAT = '-1009444001';
  const COUNTS = [1, 2, 3];

  /** N topic names `chat_map` all points at the one chat. */
  const aliases = (n: number): string[] => Array.from({ length: n }, (_, i) => `alias-${i}`);
  const chatMap = (names: string[]): Record<string, string> =>
    Object.fromEntries(names.map((name) => [name, CHAT]));
  const box = (n: number): Message[][] => Array.from({ length: n }, () => []);
  const settle = async (got: Message[], contents: string[]): Promise<void> => {
    await vi.waitFor(() => expect(got.map((m) => m.content)).toEqual(contents), {
      timeout: 5000,
      interval: 10,
    });
  };

  it.each(COUNTS)('fans one chat out to %i topics, each subscriber stamped with its own', async (n) => {
    const names = aliases(n);
    const rig = await startRig({ chat_map: chatMap(names) });
    const received = new Map<string, Message[]>();
    for (const name of names) {
      const got: Message[] = [];
      received.set(name, got);
      await rig.plugin.subscribe(asTopic(name), (m) => got.push(m));
    }
    // Both ingestion routes: a foreign message off the shared poll loop, and our own send.
    rig.fake.injectUserMessage(CHAT, 'bob', 'foreign');
    await rig.plugin.post(asTopic(names[0] as string), SENDER, 'own');

    for (const name of names) {
      const got = received.get(name) ?? [];
      await vi.waitFor(() => expect(got.map((m) => m.content).sort()).toEqual(['foreign', 'own']), {
        timeout: 5000,
        interval: 10,
      });
      // The topic a subscriber is handed is the one IT named the chat by — the whole reason the
      // registry holds a {handler, topic} pair and not a bare handler.
      expect([...new Set(got.map((m) => m.topic as string))]).toEqual([name]);
    }
  }, 20_000);

  it.each(COUNTS)('delivers to all %i subscribers that named the same topic', async (n) => {
    const rig = await startRig();
    const boxes = box(n);
    for (const got of boxes) await rig.plugin.subscribe(asTopic(CHAT), (m) => got.push(m));
    rig.fake.injectUserMessage(CHAT, 'bob', 'one');
    for (const got of boxes) await settle(got, ['one']);
  }, 20_000);

  it.each(COUNTS)('keeps delivering to %i siblings of a handler that throws', async (n) => {
    const rig = await startRig();
    let raised = 0;
    await rig.plugin.subscribe(asTopic(CHAT), () => {
      raised++;
      throw new Error('subscriber exploded');
    });
    const boxes = box(n);
    for (const got of boxes) await rig.plugin.subscribe(asTopic(CHAT), (m) => got.push(m));
    rig.fake.injectUserMessage(CHAT, 'bob', 'through');
    for (const got of boxes) await settle(got, ['through']);
    expect(raised).toBe(1);
  }, 20_000);

  it.each(COUNTS)('drops %i subscriptions at disconnect rather than into the next connection', async (n) => {
    const rig = await startRig();
    const stale = box(n);
    for (const got of stale) await rig.plugin.subscribe(asTopic(CHAT), (m) => got.push(m));
    rig.fake.injectUserMessage(CHAT, 'bob', 'before');
    for (const got of stale) await settle(got, ['before']);

    await rig.plugin.disconnect();
    await rig.reconnect();
    const fresh: Message[] = [];
    await rig.plugin.subscribe(asTopic(CHAT), (m) => fresh.push(m));
    rig.fake.injectUserMessage(CHAT, 'bob', 'after');
    await settle(fresh, ['after']);
    // The torn-down connection's subscribers saw nothing the new one served — a handler stamped
    // with the old connection's topic receiving live pushes is a subscription nobody can cancel.
    for (const got of stale) expect(got.map((m) => m.content)).toEqual(['before']);
  }, 20_000);
});
