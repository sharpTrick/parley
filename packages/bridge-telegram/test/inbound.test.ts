import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { keyOf, ObservedStore, type StoredRecord } from '../src/store.js';
import { KNOWN_CHANNEL, startFakeTelegram } from './fake-telegram.js';

const SENDER = asHandle('me');
const record = (topic: string, messageId: number, content: string): StoredRecord => ({
  topic,
  chat_id: '1',
  message_id: messageId,
  sender: 's',
  content,
  ts: new Date().toISOString(),
});

/**
 * Beyond the shared suite: the ingestion path the conformance cases can't see — a FOREIGN
 * (human) message flowing getUpdates → store → live subscriber — plus the cold-restart half
 * of the durability story: the persisted store survives a new plugin instance, so
 * `fetchRecent` replays everything this bridge has ever observed (DESIGN §6, within the
 * observed-window caveat documented on the plugin).
 */
describe('telegram inbound ingestion + store persistence', () => {
  it('delivers an injected user message live with composite id, and replays it after a cold restart', async () => {
    const fake = await startFakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-inbound-'));
    const storePath = join(dir, 'store.jsonl');
    const chatId = '4242';
    const topic = asTopic(chatId); // unmapped topic = chat id literal

    const plugin = new TelegramPlugin();
    await plugin.connect({
      token: 'test-token',
      api_url: fake.url,
      store_path: storePath,
      poll_timeout_s: 1,
    });
    try {
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));

      const mid = fake.injectUserMessage(chatId, 'alice', 'hello from telegram');
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

      // Composite backendMsgId (<chat>:<mid>) and bare numeric per-topic cursor.
      expect(live[0]!.backendMsgId).toBe(`${chatId}:${mid}`);
      expect(live[0]!.cursor).toBe(String(mid));
      expect(live[0]!.senderHandle).toBe('alice');
      expect(live[0]!.content).toBe('hello from telegram');
      await plugin.disconnect();

      // Cold restart against the SAME store file: the observed message is replayable
      // without any network history endpoint — the durable-history half we CAN provide.
      const plugin2 = new TelegramPlugin();
      await plugin2.connect({
        token: 'test-token',
        api_url: fake.url,
        store_path: storePath,
        poll_timeout_s: 1,
      });
      try {
        const { messages, nextCursor } = await plugin2.fetchRecent({ topic });
        expect(messages.map((m) => m.content)).toEqual(['hello from telegram']);
        expect(messages[0]!.backendMsgId).toBe(`${chatId}:${mid}`);
        expect(nextCursor).toBe(String(mid));
      } finally {
        await plugin2.disconnect();
      }
    } finally {
      await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * BUG-08: an `@channelusername` chat id must not split a topic in two. Inbound updates always
 * carry a NUMERIC `chat.id`, so the reverse route has to be keyed by the numeric id `getChat`
 * resolves the `@name` to — otherwise every foreign message lands on a phantom numeric topic.
 */
describe('telegram @channelusername routing (BUG-08)', () => {
  it('routes an @name chat referenced via chat_map to its friendly topic', async () => {
    const fake = await startFakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-at-'));
    const plugin = new TelegramPlugin();
    await plugin.connect({
      token: 'test-token',
      api_url: fake.url,
      store_path: join(dir, 'store.jsonl'),
      poll_timeout_s: 1,
      chat_map: { news: KNOWN_CHANNEL.username },
    });
    try {
      const topic = asTopic('news');
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));

      // Inbound arrives with the NUMERIC id behind @mychannel (real Telegram shape).
      const mid = fake.injectUserMessage(String(KNOWN_CHANNEL.id), 'alice', 'breaking');
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

      expect(live[0]!.content).toBe('breaking');
      expect(live[0]!.topic).toBe(topic);
      expect(live[0]!.backendMsgId).toBe(`${KNOWN_CHANNEL.id}:${mid}`);
      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual(['breaking']);
    } finally {
      await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes an @name TOPIC LITERAL (no chat_map) identically', async () => {
    const fake = await startFakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-atlit-'));
    const plugin = new TelegramPlugin();
    await plugin.connect({
      token: 'test-token',
      api_url: fake.url,
      store_path: join(dir, 'store.jsonl'),
      poll_timeout_s: 1,
    });
    try {
      const topic = asTopic(KNOWN_CHANNEL.username); // '@mychannel' used directly as the topic
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));

      const mid = fake.injectUserMessage(String(KNOWN_CHANNEL.id), 'alice', 'from-channel');
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

      expect(live[0]!.content).toBe('from-channel');
      expect(live[0]!.backendMsgId).toBe(`${KNOWN_CHANNEL.id}:${mid}`);
      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual(['from-channel']);
    } finally {
      await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * BUG-17: a foreign message accepted just before our own post (so a LOWER message_id) but
 * delivered to the bridge AFTER it must still reach the subscriber — delivery keys off the
 * store's dedup set, never a watermark our own post advanced past it.
 */
describe('telegram own-post race (BUG-17)', () => {
  it('delivers a foreign message ingested after our higher-id post', async () => {
    const fake = await startFakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-race-'));
    const chatId = '5555';
    const topic = asTopic(chatId);
    const plugin = new TelegramPlugin();
    await plugin.connect({
      token: 'test-token',
      api_url: fake.url,
      store_path: join(dir, 'store.jsonl'),
      poll_timeout_s: 1,
    });
    try {
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m)); // watermark 0 (empty store)

      // Foreign message accepted FIRST (lower message_id) but withheld from getUpdates...
      const foreign = fake.injectUserMessageDeferred(chatId, 'bob', 'earlier');
      // ...our post runs next and gets a HIGHER message_id (own send ingested synchronously).
      const ownId = await plugin.post(topic, SENDER, 'ours');
      const ownMid = Number((ownId as string).split(':')[1]);
      expect(foreign.messageId).toBeLessThan(ownMid);
      // Only now does the earlier foreign update reach the bridge (after our post resolved).
      foreign.release();

      await vi.waitFor(
        () => expect([...live].map((m) => m.content).sort()).toEqual(['earlier', 'ours']),
        { timeout: 3000, interval: 10 },
      );
      // Both remain retrievable via catch-up, ascending by message_id.
      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual(['earlier', 'ours']);
    } finally {
      await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * BUG-19 / BUG-32: the observed-message store must repair a crash-torn tail on load, bound its
 * retention to the newest N per topic (compacting the file), and hold a single append fd.
 */
describe('telegram ObservedStore durability (BUG-19 / BUG-32)', () => {
  it('BUG-19: repairs a crash-torn tail so a later append survives a cold reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-torn-'));
    const path = join(dir, 'store.jsonl');
    try {
      // One complete record, then a crash-torn fragment of a second (NO trailing newline).
      writeFileSync(path, `${JSON.stringify(record('t', 1, 'first'))}\n{"topic":"t","chat_id":"1","mess`);

      const store = new ObservedStore(path);
      const recC = record('t', 3, 'third');
      expect(store.append(recC)).toBe(true);
      store.close();

      const reloaded = new ObservedStore(path);
      // The complete record survives, the fragment is dropped, and the append is NOT glued/lost.
      expect(reloaded.entries('t').map((r) => r.content)).toEqual(['first', 'third']);
      expect(reloaded.has(keyOf(recC))).toBe(true);
      reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BUG-32: bounds retention to newest-N, compacts the file, and frees the fd on close', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-retain-'));
    const path = join(dir, 'store.jsonl');
    try {
      const N = 5;
      const lines = Array.from({ length: 20 }, (_, i) =>
        JSON.stringify(record('t', i + 1, `m${i + 1}`)),
      );
      writeFileSync(path, `${lines.join('\n')}\n`);

      const store = new ObservedStore(path, N);
      // Only the newest N are retained in memory...
      expect(store.entries('t').map((r) => r.message_id)).toEqual([16, 17, 18, 19, 20]);
      // ...and the dedup set is bounded: evicted (old) ids gone, retained ids present.
      expect(store.has(keyOf(record('t', 1, '')))).toBe(false);
      expect(store.has(keyOf(record('t', 20, '')))).toBe(true);
      store.close();

      // After close the fd is released: a further append is a no-op (does not touch the file).
      expect(store.append(record('t', 99, 'x'))).toBe(false);

      // The on-disk file was compacted below the threshold (only the retained N records remain).
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(N);

      const reloaded = new ObservedStore(path, N);
      expect(reloaded.entries('t').map((r) => r.content)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20']);
      reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
