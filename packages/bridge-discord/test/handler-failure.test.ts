import { asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { FAKE_TOKEN, startFakeDiscord, type FakeDiscord } from './fake-discord.js';

/**
 * Both ways a handler's failure reaches the process. Keep BOTH listeners AND a row for each, so that
 * a fix absorbing only one half still fails: an escaped rejection arrives as `unhandledRejection`
 * and a synchronous throw out of the socket's message listener as `uncaughtException`, and a table
 * carrying only one of them leaves the other listener installed but unreachable.
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

  const FAILING: Array<[how: string, handler: (m: Message) => void]> = [
    [
      'rejects',
      (async (_m: Message): Promise<void> => {
        throw new Error('handler rejected');
      }) as (m: Message) => void,
    ],
    [
      'throws synchronously',
      (_m: Message): void => {
        throw new Error('handler threw');
      },
    ],
  ];

  it.each(FAILING)('a handler that %s does not stop a LATER subscriber on another topic', async (
    _how,
    failing,
  ) => {
    const broken = liveTopic();
    const healthy = liveTopic();
    const watch = watchForCrashes();
    try {
      await plugin.subscribe(broken, failing);
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
