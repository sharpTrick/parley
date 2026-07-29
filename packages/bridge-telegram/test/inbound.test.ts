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
    expect(await contentsOf(rig.plugin, topic)).toEqual(['earlier', 'ours']);
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
});
