import { asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { PAGE_LIMIT, startFakeDiscord, type FakeDiscord } from './fake-discord.js';

// The two halves of DESIGN §6 that the plugin — not the provider — is answerable for, both of them
// invisible to a suite that only ever reads one page:
//
//   1. A `limit` larger than the provider's page cap is satisfied by an INTRA-CALL walk. Everything
//      about that walk (the `after` it advances, the order it concatenates, the cursor it ends on)
//      is the plugin's, and core cannot check any of it: it dedups on `backendMsgId` and stores the
//      cursor it is handed. So the counts here straddle the 100-per-page cap on BOTH sides and each
//      cell asserts exact content, dedup, strict cursor monotonicity, and the nextCursor identity.
//   2. A cursor the plugin has to MINT because the backend gave it none. `'0'` is unconstrained by
//      anything the provider says, so it is pinned by its PROPERTY — replayable — rather than by its
//      literal: a minted value ahead of the topic silences it forever with no error.

const SENDER = asHandle('writer');

let seq = 0;
const freshChannelId = (): string =>
  String(760_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

describe('Discord paging and minted cursors', () => {
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
      token: 'fake-token',
      api_url: fake.apiUrl,
      gateway_url: fake.gatewayUrl,
    });
  });
  afterEach(async () => {
    await plugin.disconnect();
    await fake.close();
  });

  describe('one call paging forward from a cursor', () => {
    // Counts straddle the page cap on both sides; limits straddle it too, so the discriminating
    // cells (count and limit BOTH above 100) sit next to the single-page controls that would still
    // pass with the walk broken — which is what makes a failure locate the walk rather than the API.
    const COUNTS = [1, PAGE_LIMIT - 1, PAGE_LIMIT, PAGE_LIMIT + 1, 2 * PAGE_LIMIT, 250];
    const LIMITS = [1, PAGE_LIMIT, PAGE_LIMIT + 1, 1000];

    const bodies = (n: number): string[] => Array.from({ length: n }, (_, i) => `m${i}`);

    for (const count of COUNTS) {
      it(`returns each of ${count} messages after the cursor exactly once, in order`, async () => {
        const topic = liveTopic();
        const since = (await plugin.post(topic, SENDER, 'seed')) as unknown as Cursor;
        // Straight into the fake's store: `count` REST posts would make this table's cost the
        // provisioning, not the walk it is about.
        for (const content of bodies(count)) fake.deliver(topic as string, { content });

        for (const limit of LIMITS) {
          const { messages, nextCursor } = await plugin.fetchRecent({ topic, since, limit });
          const expected = Math.min(limit, count);

          expect(messages.map((m) => m.content), `limit ${limit}`).toEqual(
            bodies(count).slice(0, expected),
          );
          expect(
            new Set(messages.map((m) => m.backendMsgId)).size,
            `limit ${limit}: the walk returned a message twice`,
          ).toBe(messages.length);
          const cursors = messages.map((m) => BigInt(m.cursor));
          expect(
            cursors.every((c, i) => i === 0 || c > cursors[i - 1]!),
            `limit ${limit}: the cursor went backwards inside one call`,
          ).toBe(true);
          expect(nextCursor, `limit ${limit}`).toBe(messages.at(-1)?.cursor ?? since);
        }
      });
    }

    it('resuming from the returned cursor continues where the walk stopped', async () => {
      const topic = liveTopic();
      const since = (await plugin.post(topic, SENDER, 'seed')) as unknown as Cursor;
      for (const content of bodies(250)) fake.deliver(topic as string, { content });

      const first = await plugin.fetchRecent({ topic, since, limit: 150 });
      const rest = await plugin.fetchRecent({ topic, since: first.nextCursor, limit: 1000 });

      expect([...first.messages, ...rest.messages].map((m) => m.content)).toEqual(bodies(250));
    });
  });

  describe('a cursor the plugin had to mint', () => {
    // A since-less fetch on a topic with NO messages has nothing to derive a cursor from, so the
    // plugin invents one and core persists it. Every limit gets a cell because the mint site sits
    // after the paging loop, which `limit` controls.
    for (const limit of [1, PAGE_LIMIT, 1000]) {
      it(`is replayable, not ahead of the topic (limit ${limit})`, async () => {
        const topic = liveTopic();

        const first = await plugin.fetchRecent({ topic, limit });
        expect(first.messages).toEqual([]);
        const second = await plugin.fetchRecent({ topic, limit });
        expect(second.nextCursor, 'the minted cursor moved without a message').toBe(
          first.nextCursor,
        );

        for (const content of ['one', 'two', 'three']) await plugin.post(topic, SENDER, content);

        const caught = await plugin.fetchRecent({ topic, since: first.nextCursor, limit: 1000 });
        expect(
          caught.messages.map((m) => m.content),
          'catch-up from the minted cursor skipped messages the topic did have',
        ).toEqual(['one', 'two', 'three']);
      });
    }
  });
});
