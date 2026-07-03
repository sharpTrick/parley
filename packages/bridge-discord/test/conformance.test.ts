import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord } from './fake-discord.js';

// The suite runs against the in-process fake (test/fake-discord.ts) — hermetic, no credentials,
// ALWAYS on. A manual run against a real Discord channel id is documented in the README.

let seq = 0;
/** A fresh numeric channel-id string, used DIRECTLY as the topic (topic-as-channel-id path). */
const freshChannelId = (): string =>
  String(100_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

async function makeContext() {
  const fake = await startFakeDiscord();
  const plugin = new DiscordPlugin();
  await plugin.connect({
    token: 'fake-token',
    api_url: fake.apiUrl,
    gateway_url: fake.gatewayUrl,
  });
  return {
    plugin,
    freshTopic: (): Topic => asTopic(freshChannelId()),
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
    },
    // Concurrency = N independent plugin instances (their own REST clients) against the SAME
    // fake — the network-backend analogue of SQLite's forked writer processes.
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new DiscordPlugin();
          await p.connect({
            token: 'fake-token',
            api_url: fake.apiUrl,
            gateway_url: fake.gatewayUrl,
          });
          return p;
        }),
      );
      try {
        await Promise.all(
          plugins.map(async (p, w) => {
            for (let i = 0; i < perWriter; i++) {
              await p.post(topic, asHandle(`w${w}`), `w${w}-${i}`);
            }
          }),
        );
      } finally {
        await Promise.all(plugins.map((p) => p.disconnect()));
      }
    },
  };
}

runConformanceSuite('discord', makeContext);
