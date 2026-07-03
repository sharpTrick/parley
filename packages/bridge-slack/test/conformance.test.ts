import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

/** Each context gets its OWN in-process fake workspace — total isolation, no shared state. */
async function makeContext() {
  const fake = await FakeSlack.start();
  const plugin = new SlackPlugin();
  await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
  return {
    plugin,
    fake, // introspection for the ack-discipline test below (ignored by the shared suite)
    // A fresh "channel id" per test — unmapped topics are used as channel-id literals.
    freshTopic: (): Topic => asTopic(`C${++seq}${rand().toUpperCase()}`),
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
    },
    // N independent plugin instances against the same workspace = N concurrent API writers.
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new SlackPlugin();
          await p.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
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

// The fake is in-process — the suite always runs; no external server to probe for.
runConformanceSuite('slack', makeContext);

describe('slack socket mode discipline', () => {
  it('acks every pushed envelope, even while handlers are consuming events', async () => {
    const ctx = await makeContext();
    try {
      const t = ctx.freshTopic();
      const live: string[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m.content));
      for (const c of ['a', 'b', 'c']) await ctx.plugin.post(t, asHandle('writer'), c);
      await vi.waitFor(() => expect(live).toEqual(['a', 'b', 'c']), { timeout: 3000, interval: 10 });

      const fake = ctx.fake;
      // Every events_api envelope the fake pushed must have been acked back over the socket
      // (ack-first: acks precede handler processing, so none can be starved by a slow handler).
      await vi.waitFor(
        () => {
          expect(fake.pushed.size).toBeGreaterThan(0);
          for (const id of fake.pushed) expect(fake.acked).toContain(id);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      await ctx.cleanup();
    }
  });
});
