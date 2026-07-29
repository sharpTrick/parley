/**
 * Two CLASSES of input the plugin cannot trust:
 *
 * (1) CONFIG. A topic → channel map is many-to-one by construction. Two topics folding onto one
 *     channel is not a merge, it is a silent displacement: one topic's handler stops firing and
 *     that channel's traffic is delivered under the OTHER topic's name, crossing into a different
 *     topic's dedup and allowlist namespace. It must fail at load, naming both topics.
 *
 * (2) HISTORY. One unexpected record in a `conversations.history` page must not reject the call and
 *     must not mint an empty `backendMsgId`/`cursor` — an empty dedup key collapses every message
 *     that carries it, and a rejection that repeats on every catch-up wedges the topic forever,
 *     because the cursor never advances past the record that caused it.
 */
import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

const COLLIDING: Array<{ name: string; map: Record<string, string>; topics: [string, string] }> = [
  {
    name: 'two mapped topics on one channel',
    map: { alpha: 'C0SHARED', beta: 'C0SHARED' },
    topics: ['alpha', 'beta'],
  },
  {
    name: 'three mapped topics, two of them colliding',
    map: { alpha: 'C0A', beta: 'C0SHARED', gamma: 'C0SHARED' },
    topics: ['beta', 'gamma'],
  },
  {
    name: 'a topic mapped to the channel another topic is named after',
    map: { alpha: 'C0LITERAL', C0LITERAL: 'C0LITERAL' },
    topics: ['alpha', 'C0LITERAL'],
  },
];

describe('slack colliding topic → channel mappings', () => {
  for (const row of COLLIDING) {
    it(`connect rejects ${row.name}, naming both topics`, async () => {
      const plugin = new SlackPlugin();
      await expect(
        plugin.connect({ api_url: 'http://127.0.0.1:1/api', channel_map: row.map }),
      ).rejects.toThrow(new RegExp(`${row.topics[0]}[\\s\\S]*${row.topics[1]}`));
    });
  }

  it('accepts a map whose targets are distinct, including near-miss ids', async () => {
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: 'http://127.0.0.1:1/api',
      channel_map: { alpha: 'C0AAA', beta: 'C0AAB', gamma: 'c0aaa' },
    });
    await plugin.disconnect();
  });

  it('subscribe rejects an unmapped topic that collides with a mapped one', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: fake.apiUrl,
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
      channel_map: { alpha: 'C0LIT' },
    });
    fake.createChannel('C0LIT');
    try {
      const received: Array<{ topic: string; content: string }> = [];
      await plugin.subscribe(asTopic('alpha'), (m) =>
        received.push({ topic: String(m.topic), content: m.content }),
      );
      // `C0LIT` is unmapped, so it is used as a channel-id literal — the same channel as `alpha`.
      await expect(plugin.subscribe(asTopic('C0LIT'), () => undefined)).rejects.toThrow(/alpha/);

      // The first topic's route is intact: the rejected subscribe did not displace it.
      await plugin.post(asTopic('alpha'), asHandle('writer'), 'kept');
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000, interval: 10 });
      expect(received[0]).toEqual({ topic: 'alpha', content: 'kept' });
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

/**
 * One bad record, at each position it can occupy in a page, with and without a `since`.
 * `surfacesAs` names the rows that are legitimately deliverable — a subtype-less entry with a
 * well-formed `ts` IS a message, however odd its text — so the table states which is which rather
 * than letting "it did not crash" stand in for "it was classified correctly".
 */
const BAD_ENTRIES: Array<{ name: string; entry: unknown; surfacesAs?: string }> = [
  { name: 'no ts', entry: { type: 'message', text: 'bad', user: 'U0' } },
  { name: 'null ts', entry: { type: 'message', ts: null, text: 'bad', user: 'U0' } },
  { name: 'numeric ts', entry: { type: 'message', ts: 42, text: 'bad', user: 'U0' } },
  { name: 'empty ts', entry: { type: 'message', ts: '', text: 'bad', user: 'U0' } },
  { name: 'non-numeric ts', entry: { type: 'message', ts: 'abc', text: 'bad', user: 'U0' } },
  { name: 'three-part ts', entry: { type: 'message', ts: '1.2.3', text: 'bad', user: 'U0' } },
  {
    name: 'float-shaped ts as a JSON number',
    entry: { type: 'message', ts: 1700000000.1, text: 'bad' },
  },
  { name: 'null entry', entry: null },
  { name: 'no type', entry: { ts: '1700000000.000001', text: 'bad', user: 'U0' } },
  {
    name: 'null text',
    entry: { type: 'message', ts: '1700000000.000002', text: null, user: 'U0' },
    surfacesAs: '',
  },
];

const POSITIONS = ['only', 'first', 'middle', 'last'] as const;

async function seedWithBadEntry(
  fake: FakeSlack,
  topic: Topic,
  entry: unknown,
  position: (typeof POSITIONS)[number],
): Promise<string[]> {
  if (position === 'only') {
    fake.seedRaw(topic, [entry]);
    return [];
  }
  const before = position === 'first' ? 0 : position === 'middle' ? 2 : 4;
  const after = 4 - before;
  const good: string[] = [];
  if (before > 0) {
    good.push(...fake.seed(topic, Array.from({ length: before }, (_, i) => ({ text: `g${i}` }))).map((m) => m.text));
  }
  fake.seedRaw(topic, [entry]);
  if (after > 0) {
    good.push(
      ...fake
        .seed(topic, Array.from({ length: after }, (_, i) => ({ text: `h${i}` })))
        .map((m) => m.text),
    );
  }
  return good;
}

describe('slack history robustness: one hostile record must not wedge catch-up', () => {
  for (const bad of BAD_ENTRIES) {
    it(`survives a page containing an entry with ${bad.name}`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
      try {
        for (const position of POSITIONS) {
          for (const withSince of [false, true]) {
            const topic = asTopic(`C0BAD${position}${withSince ? 'S' : ''}`);
            fake.createChannel(topic);
            const good = await seedWithBadEntry(fake, topic, bad.entry, position);

            const result = await plugin.fetchRecent(
              withSince ? { topic, since: asCursor('0'), limit: 100 } : { topic, limit: 100 },
            );

            // The bad entry's `ts` is always older than the fake's freshly minted ones, so a row
            // that legitimately surfaces lands ahead of the good entries.
            const expected = bad.surfacesAs === undefined ? good : [bad.surfacesAs, ...good];
            const where = `${bad.name} @${position} since=${withSince}`;
            expect(result.messages.map((m) => m.content), where).toEqual(expected);
            for (const m of result.messages) {
              expect(String(m.backendMsgId).length, where).toBeGreaterThan(0);
              expect(String(m.cursor).length, where).toBeGreaterThan(0);
            }
            expect(String(result.nextCursor).length, where).toBeGreaterThan(0);
          }
        }
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }
});
