import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { ObservedStore } from '../src/store.js';
import { type FakeTelegram, KNOWN_CHANNEL, startFakeTelegram } from './fake-telegram.js';

const SENDER = asHandle('me');

interface Rig {
  fake: FakeTelegram;
  plugin: TelegramPlugin;
  storePath: string;
  /** Reconnect a NEW plugin instance against the same fake + store file (cold restart). */
  restart(): Promise<TelegramPlugin>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startRig(config: Record<string, unknown> = {}): Promise<Rig> {
  const fake = await startFakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-'));
  const storePath = join(dir, 'store.jsonl');
  cleanups.push(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const connect = async (): Promise<TelegramPlugin> => {
    const plugin = new TelegramPlugin();
    await plugin.connect({
      token: fake.token,
      api_url: fake.url,
      store_path: storePath,
      poll_timeout_s: 1,
      ...config,
    });
    cleanups.push(() => plugin.disconnect());
    return plugin;
  };
  const plugin = await connect();
  return { fake, plugin, storePath, restart: connect };
}

const contentsOf = async (plugin: TelegramPlugin, topic: Topic): Promise<string[]> =>
  (await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content);

/**
 * Every way a topic can NAME a chat, crossed with which seam call ran first and whether the
 * foreign message arrived before any of them. Inbound updates carry only a numeric `chat.id`,
 * so a bridge that learns the mapping on a write path files everything else under a phantom
 * topic — invisible forever, and persisted that way (BUG-08).
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

describe('telegram inbound routing (BUG-08)', () => {
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
 * BUG-17: a foreign message accepted just before our own post (so a LOWER message_id) but
 * delivered to the bridge AFTER it must still reach the subscriber — delivery keys off the
 * store's dedup set, never a watermark our own post advanced past it.
 */
describe('telegram own-post race (BUG-17)', () => {
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
    cleanups.push(() => void process.off('unhandledRejection', onUnhandled));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cleanups.push(() => void vi.restoreAllMocks());
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
      cleanups.push(() => void vi.restoreAllMocks());
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
  const STARVATION_CELLS = (['never', 'fetchRecent', 'subscribe', 'post'] as const).flatMap(
    (firstCall) =>
      (['before', 'after'] as const)
        .filter((flood) => !(firstCall === 'never' && flood === 'after'))
        .map((flood) => ({ firstCall, flood })),
  );

  it.each(STARVATION_CELLS)(
    'keeps the operator message when the topic is first named by $firstCall and the flood lands $flood it',
    async ({ firstCall, flood }) => {
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
    },
    20_000,
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
   * A refused record is permanent message loss — the update was acknowledged to Telegram before
   * the store saw it — so it must never be silent.
   */
  it('reports a record the store refuses, and does not report a plain duplicate', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    cleanups.push(() => void vi.restoreAllMocks());
    // Both configured chats are served from connect, so the cap has no unserved chat to displace.
    const rig = await startRig({
      observed_max_chats: 2,
      chat_map: { a: '-1007001001', b: '-1007001002' },
    });
    await rig.plugin.post(asTopic('a'), SENDER, 'a');
    await rig.plugin.post(asTopic('b'), SENDER, 'b');

    rig.fake.injectUserMessage('-1007009999', 'mallory', 'refused');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(/dropped a message for chat/), {
      timeout: 8000,
      interval: 20,
    });
    expect(stderr.join('')).toContain('-1007009999');
  }, 20_000);
});
