import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { startFakeTelegram } from './fake-telegram.js';

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
