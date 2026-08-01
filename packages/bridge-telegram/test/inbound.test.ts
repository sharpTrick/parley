import { mkdirSync, readFileSync } from 'node:fs';
import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type ObservedRecord, ObservedStore, type StoredRecord } from '../src/store.js';
import { KNOWN_CHANNEL } from './fake-telegram.js';
import { captureStderr, registerCleanup, type Rig, seqOf, startRig } from './rig.js';

const SENDER = asHandle('me');

const contentsOf = async (plugin: TelegramPlugin, topic: Topic): Promise<string[]> =>
  (await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content);

/** Cold restart: a fresh plugin instance on the same fake and the same store file. */
const restart = async (rig: Rig): Promise<TelegramPlugin> => {
  await rig.plugin.disconnect();
  return rig.restart();
};

/**
 * Every way a topic can NAME a chat, crossed with which seam call ran first and whether the
 * foreign message arrived before any of them. Inbound updates carry only a numeric `chat.id`,
 * so a bridge that learns the mapping on a write path files everything else under a phantom
 * topic — invisible forever, and persisted that way.
 */
const SPELLINGS = [
  { name: 'numeric literal', topic: '-1009000001', chat: '-1009000001', config: {} },
  {
    name: '@name literal',
    topic: KNOWN_CHANNEL.username,
    chat: String(KNOWN_CHANNEL.id),
    config: {},
  },
  {
    name: 'chat_map to numeric',
    topic: 'ops',
    chat: '-1009000002',
    config: { chat_map: { ops: '-1009000002' } },
  },
  {
    name: 'chat_map to @name',
    topic: 'news',
    chat: String(KNOWN_CHANNEL.id),
    config: { chat_map: { news: KNOWN_CHANNEL.username } },
  },
] as const;

const FIRST_CALLS = ['fetchRecent', 'subscribe', 'post'] as const;

const CELLS = SPELLINGS.flatMap((spelling) =>
  FIRST_CALLS.flatMap((firstCall) =>
    [true, false].map((arriveFirst) => ({ spelling, firstCall, arriveFirst })),
  ),
);

describe('telegram inbound routing', () => {
  it.each(CELLS)(
    'topic as $spelling.name, first seam call $firstCall, message first: $arriveFirst',
    async ({ spelling, firstCall, arriveFirst }) => {
      const rig = await startRig(spelling.config);
      const topic = asTopic(spelling.topic);
      const live: Message[] = [];
      const runFirstCall = async (plugin: TelegramPlugin): Promise<void> => {
        if (firstCall === 'fetchRecent') await plugin.fetchRecent({ topic });
        if (firstCall === 'subscribe') await plugin.subscribe(topic, (m) => live.push(m));
        if (firstCall === 'post') await plugin.post(topic, SENDER, 'own');
      };

      if (arriveFirst) {
        rig.fake.injectUserMessage(spelling.chat, 'alice', 'foreign');
        await vi.waitFor(() => expect(rig.fake.callCount('getUpdates')).toBeGreaterThan(1), {
          timeout: 3000,
          interval: 10,
        });
        await runFirstCall(rig.plugin);
      } else {
        await runFirstCall(rig.plugin);
        rig.fake.injectUserMessage(spelling.chat, 'alice', 'foreign');
      }

      await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('foreign'), {
        timeout: 3000,
        interval: 10,
      });
      // A live subscriber established before the message must also receive it, stamped with the
      // topic IT named the chat by.
      if (firstCall === 'subscribe' && !arriveFirst) {
        await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('foreign'), {
          timeout: 3000,
          interval: 10,
        });
        expect(live.at(-1)?.topic).toBe(topic);
        expect(live.at(-1)?.backendMsgId).toMatch(new RegExp(`^${spelling.chat}:\\d+$`));
      }

      // Cold restart: the record must be filed under the chat, not a phantom topic — a misfiled
      // record is deduped on the getUpdates backlog replay and can never be recovered.
      await rig.plugin.disconnect();
      const restarted = await rig.restart();
      expect(await contentsOf(restarted, topic)).toContain('foreign');
    },
  );
});

/**
 * Telegram resolves a `chat_id` NUMERICALLY, and stamps the normalized id on every inbound update
 * and on its own `sendMessage` response. So a topic whose chat reference is numerically — but not
 * textually — canonical must still collapse to that one key. A plugin that keys the store, the
 * subscription and the fetch under the literal spelling makes the topic a permanent black hole:
 * its posts are filed under a key nothing inbound will ever carry, and the Bot API has no history
 * endpoint that could hand them back.
 *
 * One row per spelling, so a ref format nobody has tried yet (a wider supergroup id, a new
 * prefix) fails on its own rather than hiding behind a neighbour.
 */
const NON_CANONICAL_SPELLINGS = [
  { name: 'a leading zero', ref: '-01009300001', canonical: '-1009300001', config: {} },
  { name: 'many leading zeros', ref: '-000001009300002', canonical: '-1009300002', config: {} },
  { name: 'a positive id with leading zeros', ref: '004242', canonical: '4242', config: {} },
  {
    name: 'a chat_map value with a leading zero',
    ref: 'ops',
    canonical: '-1009300003',
    config: { chat_map: { ops: '-01009300003' } },
  },
] as const;

describe('telegram chat-id canonicalization', () => {
  it.each(NON_CANONICAL_SPELLINGS)(
    'a topic naming a chat by $name is one key with the id Telegram stamps',
    async ({ ref, canonical, config }) => {
      const rig = await startRig(config);
      const topic = asTopic(ref);
      const live: Message[] = [];
      await rig.plugin.subscribe(topic, (m) => live.push(m));

      const ownId = await rig.plugin.post(topic, SENDER, 'own');
      expect(ownId as string).toMatch(new RegExp(`^${canonical}:\\d+$`));
      // Our own post is retrievable under the spelling the caller used...
      expect(await contentsOf(rig.plugin, topic)).toEqual(['own']);

      // ...and an inbound update, which carries only the canonical id, routes to the same topic.
      rig.fake.injectUserMessage(canonical, 'alice', 'foreign');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('foreign'), {
        timeout: 3000,
        interval: 10,
      });
      expect(live.at(-1)?.topic).toBe(topic);
      expect(await contentsOf(rig.plugin, topic)).toEqual(['own', 'foreign']);

      // The store filed both under the canonical id, so a cold restart still finds them.
      expect(await contentsOf(await restart(rig), topic)).toEqual(['own', 'foreign']);
    },
  );

  /**
   * The other half of the same key, and the half the client does not choose: how the UPSTREAM
   * spells `chat.id`. `post` resolves its topic through one normalization and then indexed, woke
   * and fanned out under `String(sent.chat.id)` from the response, which is a different one — so a
   * spelling the two disagree on filed the record in a bucket the topic never queries while every
   * seam call reported success, and `store.has(...)`, the guard whose whole job is to catch exactly
   * that, passed vacuously because it asked under the same wrong key.
   *
   * The invariant per cell is one line: the message is reachable through the topic that addressed
   * it, or the call REJECTS naming both ids. Never a topic that swallows posts and stays empty.
   */
  const ECHOED_CHAT_IDS = [
    { name: 'the canonical number', chat: '-1009400001', spell: (id: number) => id, reaches: true },
    {
      name: 'a numeric string with leading zeros',
      chat: '-1009400002',
      spell: (id: number) => `-00${String(-id)}`,
      reaches: true,
    },
    {
      name: 'a different chat than the one addressed',
      chat: '-1009400003',
      spell: (id: number) => id - 1,
      reaches: false,
    },
    {
      // No spelling of its own: JSON's double rounds this id on the way back, which is what
      // `canonicalChatId` normalizes through BigInt to avoid and what the response echo undid.
      name: 'an id rounded past MAX_SAFE_INTEGER',
      chat: '9007199254740993',
      spell: (id: number) => id,
      reaches: false,
    },
  ] as const;

  const INGEST_PATHS = ['a sendMessage response', 'a getUpdates update'] as const;

  const KEY_CELLS = ECHOED_CHAT_IDS.flatMap((echo) =>
    INGEST_PATHS.map((path) => ({ ...echo, path })),
  );

  it.each(KEY_CELLS)(
    'chat.id echoed as $name on $path reaches the addressed topic: $reaches',
    async ({ chat, spell, reaches, path }) => {
      captureStderr();
      const rig = await startRig();
      const topic = asTopic(chat);
      const addressed = BigInt(chat).toString();
      const stamped = BigInt(String(spell(Number(chat)))).toString();
      // Guard the row: a cell whose spelling collapses to the addressed id cannot grade a mismatch.
      expect(stamped === addressed).toBe(reaches);
      rig.fake.spellChatId(spell);

      const live: Message[] = [];
      await rig.plugin.subscribe(topic, (m) => live.push(m));

      if (path === 'a sendMessage response') {
        const posted = await rig.plugin.post(topic, SENDER, 'hello').then(
          (id) => id as string,
          (err: unknown) => err as Error,
        );
        if (reaches) expect(posted).toBe(`${addressed}:1`);
        else {
          expect((posted as Error).message).toContain(addressed);
          expect((posted as Error).message).toContain(stamped);
        }
      } else {
        rig.fake.injectUserMessage(chat, 'alice', 'hello');
        // A sentinel in a chat this cell never touches pins the point the update was consumed, so
        // an unreachable cell is graded on ingestion having happened, not on losing a race.
        rig.fake.spellChatId(undefined);
        rig.fake.injectUserMessage(SENTINEL_CHAT, 'alice', 'sentinel');
        await vi.waitFor(
          async () => expect(await contentsOf(rig.plugin, asTopic(SENTINEL_CHAT))).toContain('sentinel'),
          { timeout: 5000, interval: 20 },
        );
      }

      const expected = reaches ? ['hello'] : [];
      expect(await contentsOf(rig.plugin, topic)).toEqual(expected);
      expect(live.map((m) => m.content)).toEqual(expected);
      // And the verdict survives a restart, which is where a misfiled record becomes permanent.
      expect(await contentsOf(await restart(rig), topic)).toEqual(expected);
    },
    20_000,
  );
});

/** A chat no key-agreement cell addresses — its traffic marks the ingestion loop's progress. */
const SENTINEL_CHAT = '-1009409999';

/**
 * Telegram carries text in `text` OR `caption`, and carries plenty of messages with neither.
 * An agent handed an empty turn cannot tell a photo from silence, and a dropped caption is
 * a dropped instruction.
 */
const SHAPES = [
  { name: 'plain text', payload: { text: 'hi' }, content: 'hi' },
  { name: 'photo with caption', payload: { photo: [{ file_id: 'p' }], caption: 'deploy this' }, content: 'deploy this' },
  { name: 'photo without caption', payload: { photo: [{ file_id: 'p' }] }, content: '[photo]' },
  { name: 'sticker', payload: { sticker: { file_id: 's' } }, content: '[sticker]' },
  { name: 'voice note', payload: { voice: { file_id: 'v' } }, content: '[voice]' },
  { name: 'document with caption', payload: { document: { file_id: 'd' }, caption: 'the spec' }, content: 'the spec' },
  { name: 'empty text', payload: { text: '' }, content: '' },
  { name: 'service message', payload: { new_chat_members: [{ id: 7 }] }, content: undefined },
] as const;

describe('telegram update normalization', () => {
  it.each(SHAPES)('$name', async ({ payload, content }) => {
    const rig = await startRig();
    const chat = '-1009100777';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));

    rig.fake.injectRaw(chat, { from: { id: 5, is_bot: false, username: 'alice' }, ...payload });
    // A trailing plain-text message pins the point at which the shape above has been consumed.
    rig.fake.injectUserMessage(chat, 'alice', 'sentinel');
    await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('sentinel'), {
      timeout: 3000,
      interval: 10,
    });

    const expected = content === undefined ? ['sentinel'] : [content, 'sentinel'];
    expect(live.map((m) => m.content)).toEqual(expected);
    expect(await contentsOf(rig.plugin, topic)).toEqual(expected);
  });
});

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
      const restarted = route === 'redelivered after a cold restart' ? await restart(rig) : rig.plugin;
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

const DATE = 1_600_000_000;
const SENDER_CHAT = '-1005557000';

/**
 * `senderHandle` and `timestamp` are agent-visible fields no other test in this package reads:
 * both mappings can be replaced by a constant without a single failure. Every sender shape
 * Telegram actually emits gets pinned here, through BOTH the live-push and the catch-up path.
 */
const FROM_SHAPES = [
  {
    name: 'from with a username',
    kind: 'message' as const,
    payload: { from: { id: 77, is_bot: false, username: 'alice' }, text: 'a', date: DATE },
    sender: 'alice',
  },
  {
    name: 'from without a username',
    kind: 'message' as const,
    payload: { from: { id: 77, is_bot: false }, text: 'b', date: DATE },
    sender: '77',
  },
  {
    name: 'another bot',
    kind: 'message' as const,
    payload: { from: { id: 4242, is_bot: true, username: 'otherbot' }, text: 'c', date: DATE },
    sender: 'otherbot',
  },
  {
    name: 'channel post with no from',
    kind: 'channel_post' as const,
    payload: { text: 'd', date: DATE },
    sender: SENDER_CHAT,
  },
];

describe('telegram sender and timestamp mapping', () => {
  it.each(FROM_SHAPES)('$name', async ({ kind, payload, sender }) => {
    const rig = await startRig();
    const topic = asTopic(SENDER_CHAT);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));

    rig.fake.injectRaw(SENDER_CHAT, payload, kind);
    await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

    const fetched = (await rig.plugin.fetchRecent({ topic })).messages;
    expect(fetched).toHaveLength(1);
    for (const msg of [live[0] as Message, fetched[0] as Message]) {
      expect(msg.senderHandle).toBe(sender);
      expect(Date.parse(msg.timestamp)).toBe(DATE * 1000);
    }
  });
});

/**
 * The getUpdates loop is the only ingestion path and it is detached: anything that throws
 * inside it (a full disk on the store write, a subscriber handler) must not take live push
 * down for the rest of the process, nor surface as an unhandled rejection.
 */
describe('telegram poll-loop fault isolation', () => {
  const THROW_SITES = ['store append', 'subscriber handler'] as const;

  it.each(THROW_SITES)('keeps consuming updates when %s throws', async (site) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => void unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    registerCleanup(() => void process.off('unhandledRejection', onUnhandled));

    captureStderr();
    const rig = await startRig();
    const chat = '-1006000123';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => {
      if (site === 'subscriber handler' && m.content === 'poison') throw new Error('handler blew up');
      live.push(m);
    });
    if (site === 'store append') {
      vi.spyOn(ObservedStore.prototype, 'append').mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });
    }

    rig.fake.injectUserMessage(chat, 'alice', 'poison');
    rig.fake.injectUserMessage(chat, 'alice', 'after');

    await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after'), {
      timeout: 3000,
      interval: 10,
    });
    expect(await contentsOf(rig.plugin, topic)).toContain('after');
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });
});

/**
 * Store-visibility and delivery are ONE decision, and a step that runs after the record is already
 * durable must not be able to split them. The amortized compaction is that step: it runs at the end
 * of `append`, so a full disk or an unusable temp path used to throw out of a write that had already
 * succeeded — the caller was told the message was dropped, no live subscriber was pushed it, and a
 * parked long poll waited out its whole budget for a message the very next `fetchRecent` returned.
 *
 * Each cell fails one step on one ingest path and grades the invariant in BOTH directions: a record
 * `fetchRecent` can see also reached every subscriber and woke every waiter, or it is absent
 * everywhere and the caller was told so.
 *
 * Whether the record ends up present is NOT the same question as whether the failing step ran after
 * it was durable, so the two are separate axes here. An inbound update whose write failed is not
 * acknowledged to Telegram, so the retained backlog serves it again and the record arrives late; an
 * own post has no redelivery at all — `sendMessage` is the only time this bridge ever sees it — so
 * the same failure is permanent and the caller is told. A table that folded the two would grade
 * "absent everywhere" as the right answer for an update that is merely in flight.
 */
describe('telegram store visibility and delivery', () => {
  const FAILING_STEPS = [
    { name: 'the record write', persists: false },
    { name: 'the compaction after the write', persists: true },
  ];
  const INGEST_PATHS = [
    { name: 'an inbound update', redelivers: true },
    { name: 'an own post', redelivers: false },
  ];
  const AGREEMENT_CELLS = FAILING_STEPS.flatMap((step) =>
    INGEST_PATHS.map(({ name, redelivers }) => ({
      step: step.name,
      persists: step.persists,
      path: name,
      durable: step.persists || redelivers,
    })),
  );

  it.each(AGREEMENT_CELLS)('never disagree when $step fails on $path', async ({ durable, persists, path }) => {
    const stderr = captureStderr();
    // Newest-1, so the very next append evicts and arms the amortized rewrite.
    const rig = await startRig({ observed_retention_per_chat: 1 });
    const chat = '-1006100001';
    const topic = asTopic(chat);
    await rig.plugin.post(topic, SENDER, 'seed');
    const tail = (await rig.plugin.fetchRecent({ topic, limit: 100 })).nextCursor;
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));
    const parked = rig.plugin.fetchRecent({ topic, since: tail, blockMs: 1500 });

    if (persists) {
      // A directory at the temp path: every compaction fails, and none of them can touch a record.
      mkdirSync(`${rig.storePath}.tmp`);
    } else {
      vi.spyOn(ObservedStore.prototype, 'append').mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });
    }

    let postError: Error | undefined;
    if (path === 'an own post') {
      postError = await rig.plugin.post(topic, SENDER, 'subject').then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    } else {
      rig.fake.injectUserMessage(chat, 'alice', 'subject');
    }
    // Settle on the OUTCOME — visible, or the caller told it did not land — never on a diagnostic
    // naming an intermediate decision: an update the loop is holding back for redelivery is still
    // in flight, and a wait that stopped there would grade the in-flight state as the final one.
    await vi.waitFor(
      async () =>
        expect(
          (await contentsOf(rig.plugin, topic)).includes('subject') || postError !== undefined,
        ).toBe(true),
      { timeout: 5000, interval: 20 },
    );

    // The step under test really failed — a cell whose obstruction never bit would grade nothing.
    const reported = `${stderr.join('')}${postError?.message ?? ''}`;
    expect(reported).toMatch(persists ? /could not compact/ : /ENOSPC/);
    const woke = (await parked).messages.map((m) => m.content).includes('subject');
    expect({
      visible: (await contentsOf(rig.plugin, topic)).includes('subject'),
      pushed: live.map((m) => m.content).includes('subject'),
      woke,
    }).toEqual({ visible: durable, pushed: durable, woke: durable });
    // A post whose record never landed is never a resolved post.
    if (path === 'an own post') expect(postError === undefined).toBe(durable);
  }, 20_000);
});

/**
 * `offset` is an ACKNOWLEDGEMENT: Telegram deletes every update below it, and the ~24h retained
 * backlog is the only redelivery this backend has — on the one backend whose observed store is the
 * only history it can ever produce, with no endpoint that could backfill what the offset walked
 * past. So the acknowledgement must not outrun durability: it may never move past an update the
 * store did not take for a reason that can still clear, and it MUST move past one refused for a
 * reason that cannot, or ingestion wedges on a batch nothing downstream can ever be given.
 *
 * The row is the obstruction and how long it lasts, and each is graded on both halves at once —
 * closing either alone produces the other's bug. Grading only that an obstructed message is absent
 * everywhere is exactly what let a lost one look correct.
 */
describe('telegram ingest obstruction and redelivery', () => {
  const OBSTRUCTIONS = [
    {
      name: 'a store write that throws',
      clears: true,
      refuse: (): StoredRecord | undefined => {
        throw new Error('ENOSPC: no space left on device');
      },
    },
    {
      name: 'a store with no append descriptor',
      clears: true,
      open: false,
      refuse: (): StoredRecord | undefined => undefined,
    },
    {
      name: 'a chat cap that refuses the record',
      clears: false,
      open: true,
      refuse: (): StoredRecord | undefined => undefined,
    },
  ];
  const RUNS = [
    { run: 'one attempt', attempts: 1 },
    { run: 'a run of attempts', attempts: 3 },
  ];
  const CELLS = OBSTRUCTIONS.flatMap((o) => RUNS.map((r) => ({ ...o, ...r })));

  it.each(CELLS)('acknowledges nothing past $name lasting $run', async ({ clears, open, refuse, attempts }) => {
    captureStderr();
    const rig = await startRig();
    const chat = '-1006500001';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));

    const realAppend = ObservedStore.prototype.append;
    let attempted = 0;
    let obstructed = true;
    vi.spyOn(ObservedStore.prototype, 'isOpen').mockImplementation(function (this: ObservedStore) {
      return !obstructed || open !== false;
    });
    vi.spyOn(ObservedStore.prototype, 'append').mockImplementation(function (
      this: ObservedStore,
      observed: ObservedRecord,
    ) {
      if (!obstructed || observed.content !== 'subject') return realAppend.call(this, observed);
      attempted++;
      return refuse();
    });

    rig.fake.injectUserMessage(chat, 'alice', 'subject');
    if (clears) {
      await vi.waitFor(() => expect(attempted).toBeGreaterThanOrEqual(attempts), {
        timeout: 8000,
        interval: 10,
      });
      // Still in Telegram's backlog while the store cannot take it — asked WHILE the obstruction
      // holds, so it cannot pass by sampling after the retry that finally succeeded.
      expect(rig.fake.retainedUpdates()).toBe(1);
    } else {
      await vi.waitFor(() => expect(rig.fake.retainedUpdates()).toBe(0), {
        timeout: 8000,
        interval: 10,
      });
      // A refusal that can never clear is acknowledged once and never re-attempted.
      expect(attempted).toBe(1);
    }

    obstructed = false;
    rig.fake.injectUserMessage(chat, 'alice', 'later');
    // The loop kept consuming either way: an obstruction must never cost the only ingestion path.
    await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('later'), {
      timeout: 8000,
      interval: 20,
    });
    expect({
      visible: (await contentsOf(rig.plugin, topic)).includes('subject'),
      pushed: live.map((m) => m.content).includes('subject'),
    }).toEqual({ visible: clears, pushed: clears });
  }, 30_000);
});

/**
 * Anyone who can add the bot to a group drives writes into the operator's store file. Ingest
 * of chats no configured topic names must not grow the file without limit.
 */
describe('telegram unconfigured-chat ingest', () => {
  it('stays bounded under a flood of unknown chats while the served topic keeps working', async () => {
    const rig = await startRig({ observed_retention_per_topic: 2, observed_max_chats: 3 });
    const chat = '-1007000001';
    const topic = asTopic(chat);
    await rig.plugin.subscribe(topic, () => undefined);

    for (let c = 0; c < 40; c++) {
      for (let i = 0; i < 4; i++) rig.fake.injectUserMessage(`-200${c}`, 'mallory', `flood-${c}-${i}`);
    }
    rig.fake.injectUserMessage(chat, 'alice', 'mine');

    await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('mine'), {
      timeout: 5000,
      interval: 10,
    });
    // 3 unconfigured chats + the served one, 2 records each, plus at most one compaction lag.
    const lines = readFileSync(rig.storePath, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(2 * (2 * 4 + 2));
  });

  const OPS_CHAT = '-1007007777';
  const SENTINEL_CHAT = '-1007005555';
  const FLOOD_CHATS = Array.from({ length: 10 }, (_, i) => `-90000${i}`);
  /** A served chat outside the contest, so waiting for ingestion never itself serves a chat. */
  const STARVATION_CONFIG = { observed_max_chats: 3, chat_map: { sentinel: SENTINEL_CHAT } };
  let marker = 0;

  /**
   * Park until the poll loop has consumed everything injected so far. Updates are delivered in
   * order, so a marker in an ALREADY-served chat pins the point — polling the topic under test
   * would register it as served and make the starvation being tested unreproducible.
   */
  const drainUpdates = async (rig: Rig): Promise<void> => {
    const content = `sentinel-${++marker}`;
    rig.fake.injectUserMessage(SENTINEL_CHAT, 'ops', content);
    await vi.waitFor(
      async () => expect(await contentsOf(rig.plugin, asTopic('sentinel'))).toContain(content),
      { timeout: 8000, interval: 20 },
    );
  };

  const floodAndWait = async (rig: Rig): Promise<void> => {
    for (const c of FLOOD_CHATS) rig.fake.injectUserMessage(c, 'mallory', `flood-${c}`);
    await drainUpdates(rig);
  };

  /**
   * The ingestion loop starts before any seam call could have named a topic, so a chat the
   * operator configured is UNSERVED for that window. A flood arriving in it must not be able to
   * make the operator's own messages undeliverable — the update is acknowledged to Telegram the
   * moment it is read, so a refused record is gone for good.
   */
  /**
   * The third axis is the RESTART, because the protection has to be durable to be worth anything:
   * `chat_map` is re-declared on every connect, a topic named only by a seam call is not, and the
   * load-time chat cap runs before any seam call could name one. A protection that lived only in
   * this process's memory would hand the operator's own history to the flood at the next restart —
   * and the Bot API has no endpoint that could ever put it back.
   */
  const STARVATION_CELLS = (['never', 'fetchRecent', 'subscribe', 'post'] as const).flatMap(
    (firstCall) =>
      (['before', 'after'] as const)
        .filter((flood) => !(firstCall === 'never' && flood === 'after'))
        .flatMap((flood) => [false, true].map((coldRestart) => ({ firstCall, flood, coldRestart }))),
  );

  it.each(STARVATION_CELLS)(
    'keeps the operator message when the topic is first named by $firstCall, the flood lands $flood it, cold restart: $coldRestart',
    async ({ firstCall, flood, coldRestart }) => {
      const rig = await startRig(STARVATION_CONFIG);
      const topic = asTopic(OPS_CHAT);
      const runFirstCall = async (): Promise<void> => {
        if (firstCall === 'fetchRecent') await rig.plugin.fetchRecent({ topic });
        if (firstCall === 'subscribe') await rig.plugin.subscribe(topic, () => undefined);
        if (firstCall === 'post') await rig.plugin.post(topic, SENDER, 'own');
      };

      if (flood === 'before') {
        await floodAndWait(rig);
        await runFirstCall();
        rig.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
        await drainUpdates(rig);
      } else {
        await runFirstCall();
        rig.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
        await drainUpdates(rig);
        await floodAndWait(rig);
      }

      expect(await contentsOf(rig.plugin, topic)).toContain('mine');
      if (!coldRestart) return;
      // Nothing may re-declare the topic in the new process before the flood arrives in it: the
      // mark the previous run left on the file is the only thing that can be protecting it here.
      const cold = { ...rig, plugin: await restart(rig) };
      await floodAndWait(cold);
      expect(await contentsOf(cold.plugin, topic)).toContain('mine');
    },
    30_000,
  );

  /**
   * The residual limit of that protection, pinned so the README cannot drift from it: a topic no
   * seam call has ever named is not protected from a LATER flood — `chat_map` is what protects
   * it, because `connect` resolves those chats before the store is even opened.
   */
  it('protects a topic from a later flood once chat_map names it, not before', async () => {
    // Nothing may name the topic before the flood — a fetchRecent to check on it would itself
    // register the chat as served, which is exactly the protection under test.
    const unnamed = await startRig(STARVATION_CONFIG);
    unnamed.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
    await drainUpdates(unnamed);
    await floodAndWait(unnamed);
    expect(await contentsOf(unnamed.plugin, asTopic(OPS_CHAT))).not.toContain('mine');

    const mapped = await startRig({
      ...STARVATION_CONFIG,
      chat_map: { ...STARVATION_CONFIG.chat_map, ops: OPS_CHAT },
    });
    mapped.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
    await drainUpdates(mapped);
    await floodAndWait(mapped);
    expect(await contentsOf(mapped.plugin, asTopic('ops'))).toContain('mine');
  }, 30_000);

  /**
   * A refused record is permanent message loss — the update was acknowledged to Telegram before the
   * store saw it — so it must never be silent. A DUPLICATE is the opposite: expected on every
   * backlog replay, and reporting it would tell the operator to raise a bound that is not the
   * problem. Both halves of the title are graded, and both kinds of duplicate are: one whose record
   * is still retained, and one retention has already evicted.
   */
  const DUP_CHAT = '-1007001001';

  it('reports a record the store refuses, and stays silent on a duplicate', async () => {
    const stderr = captureStderr();
    // Both configured chats are served from connect, so the cap has no unserved chat to displace.
    const rig = await startRig({
      observed_max_chats: 2,
      observed_retention_per_chat: 2,
      chat_map: { a: DUP_CHAT, b: '-1007001002' },
    });
    // The second served chat has to be present for the cap to have nothing unserved to displace.
    await rig.plugin.post(asTopic('b'), SENDER, 'b');
    const evicted = rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'oldest');
    const retained = rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'newer');
    rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'newest');
    await vi.waitFor(
      async () => expect(await contentsOf(rig.plugin, asTopic('a'))).toEqual(['newer', 'newest']),
      { timeout: 8000, interval: 20 },
    );

    // Both copies are duplicates: one of a retained record, one of a record retention has dropped.
    for (const [messageId, text] of [
      [evicted, 'oldest'],
      [retained, 'newer'],
    ] as const) {
      rig.fake.injectRaw(DUP_CHAT, {
        message_id: messageId,
        from: { id: 5, is_bot: false, username: 'alice' },
        text,
      });
    }
    rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'sentinel');
    await vi.waitFor(
      async () => expect(await contentsOf(rig.plugin, asTopic('a'))).toContain('sentinel'),
      { timeout: 8000, interval: 20 },
    );
    expect(stderr.join('')).not.toMatch(/dropped/);

    rig.fake.injectUserMessage('-1007009999', 'mallory', 'refused');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(/dropped a message for chat/), {
      timeout: 8000,
      interval: 20,
    });
    expect(stderr.join('')).toContain('-1007009999');
    expect(stderr.join('')).not.toContain(DUP_CHAT);
  }, 20_000);
});
