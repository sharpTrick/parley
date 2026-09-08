import { asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { FAKE_TOKEN, startFakeDiscord, type FakeDiscord } from './fake-discord.js';

/**
 * Both ways a handler's failure reaches the process. Keep BOTH listeners, so that a fix which only
 * absorbs the synchronous half still loses every rejection row: an escaped rejection arrives as
 * `unhandledRejection`, never as `uncaughtException`.
 */
function watchForCrashes(): { crashes: unknown[]; stop: () => void } {
  const crashes: unknown[] = [];
  const record = (err: unknown): void => {
    crashes.push(err);
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  return {
    crashes,
    stop: () => {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    },
  };
}

let seq = 0;
const freshChannelId = (): string =>
  String(600_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

describe("a subscribe handler's failure never leaves the handler", () => {
  let fake: FakeDiscord;
  let plugin: DiscordPlugin;

  const liveTopic = (): Topic => {
    const id = freshChannelId();
    fake.createChannel(id);
    return asTopic(id);
  };

  beforeEach(async () => {
    fake = await startFakeDiscord();
    plugin = new DiscordPlugin();
    await plugin.connect({
      token: FAKE_TOKEN,
      api_url: fake.apiUrl,
      gateway_url: fake.gatewayUrl,
    });
  });
  afterEach(async () => {
    await plugin.disconnect();
    await fake.close();
  });

  it('a handler that fails does not stop a LATER subscriber on another topic', async () => {
    const broken = liveTopic();
    const healthy = liveTopic();
    const watch = watchForCrashes();
    try {
      const rejecting = async (_m: Message): Promise<void> => {
        throw new Error('handler rejected');
      };
      await plugin.subscribe(broken, rejecting);
      const seen: string[] = [];
      await plugin.subscribe(healthy, (m) => seen.push(m.content));

      fake.deliver(broken as string, { content: 'boom' });
      fake.deliver(healthy as string, { content: 'still here' });

      await vi.waitFor(() => expect(seen).toEqual(['still here']), { timeout: 5000, interval: 10 });
      await new Promise((r) => setTimeout(r, 150));
      expect(watch.crashes.map(String)).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
