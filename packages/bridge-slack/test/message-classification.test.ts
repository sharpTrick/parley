/**
 * Two invariants the rest of the suite could not fail on:
 *
 * (1) SUBTYPE CLASSIFICATION must be enumerated, not assumed — and must be the SAME set on the
 *     history path and the Socket Mode push path. A subtype that surfaces on one path only breaks
 *     dedup (the live copy and the catch-up copy of a `ts` disagree); a user-authored subtype that
 *     surfaces on neither is silent data loss with the cursor advancing past it. Every subtype the
 *     plugin can meet is listed below with an explicit surface|drop decision, and both paths are
 *     driven from the same table — a new subtype cannot be added without deciding.
 *
 * (2) The CURSOR COMPARATOR is what makes `ts` a valid order key. Its vectors pin the semantics the
 *     comment claims, including the two comparators it must not degrade into: a float compare
 *     (which collapses distinct `ts` values once the seconds grow past the double's 1 µs
 *     resolution) and a lexical compare (which misorders unequal-width seconds/suffixes).
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { compareTs, SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

/** Every subtype the plugin can meet, with its decision. `undefined` = a plain user message. */
const SUBTYPES: Array<{ subtype?: string; surfaced: boolean }> = [
  { subtype: undefined, surfaced: true },
  { subtype: 'bot_message', surfaced: true },
  { subtype: 'file_share', surfaced: true },
  { subtype: 'me_message', surfaced: true },
  { subtype: 'channel_join', surfaced: false },
  { subtype: 'channel_leave', surfaced: false },
  { subtype: 'channel_topic', surfaced: false },
  { subtype: 'channel_purpose', surfaced: false },
  { subtype: 'channel_name', surfaced: false },
  { subtype: 'message_changed', surfaced: false },
  { subtype: 'message_deleted', surfaced: false },
  { subtype: 'thread_broadcast', surfaced: false },
  { subtype: 'tombstone', surfaced: false },
];

const label = (s?: string): string => s ?? 'plain';
const expectedSurfaced = SUBTYPES.filter((s) => s.surfaced).map((s) => label(s.subtype));

describe('slack subtype classification', () => {
  it('the history path surfaces exactly the decided set', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
    try {
      const topic = asTopic('C0HIST');
      fake.seed(
        topic,
        SUBTYPES.map((s) => ({ text: label(s.subtype), subtype: s.subtype })),
      );
      const { messages } = await plugin.fetchRecent({ topic, limit: 100 });
      expect(messages.map((m) => m.content)).toEqual(expectedSurfaced);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('the live push path surfaces exactly the same set', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const topic = asTopic('C0LIVE');
      fake.createChannel(topic);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));

      for (const s of SUBTYPES) {
        const event: Record<string, unknown> = {
          ts: fake.mintTs(),
          text: label(s.subtype),
          user: 'U0PARLEY',
        };
        if (s.subtype !== undefined) event.subtype = s.subtype;
        fake.pushEvent(topic, event);
      }

      await vi.waitFor(
        () => expect(live.map((m) => m.content)).toEqual(expectedSurfaced),
        { timeout: 3000, interval: 10 },
      );
      // Give any wrongly-surfaced extras a chance to arrive before declaring the set equal.
      await new Promise((r) => setTimeout(r, 100));
      expect(live.map((m) => m.content)).toEqual(expectedSurfaced);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

describe('slack cursor comparator', () => {
  const VECTORS: Array<[string, string, number, string]> = [
    ['1700000000.000001', '1700000000.000002', -1, 'adjacent suffixes'],
    ['1700000000.000002', '1700000000.000001', 1, 'adjacent suffixes, reversed'],
    ['1700000000.000001', '1700000000.000001', 0, 'identical'],
    ['2.000001', '10.000001', -1, 'unequal-width seconds (lexical would invert)'],
    ['10000000000.000001', '10000000000.000002', -1, 'suffixes a double parse collapses'],
    ['99999999999.000002', '99999999999.000001', 1, 'ditto, reversed'],
    ['0', '1700000000.000001', -1, 'the `0` sentinel, suffix-less'],
    ['1700000000.000001', '1700000001.000000', -1, 'seconds win over suffix'],
    ['1700000000.1', '1700000000.000002', 1, 'unequal-width suffixes are place-value, not integers'],
    ['1700000000.1', '1700000000.900000', -1, 'ditto, other direction'],
    ['5', '5', 0, 'suffix-less on both sides'],
  ];

  for (const [a, b, expected, why] of VECTORS) {
    it(`compareTs(${a}, ${b}) → ${expected} (${why})`, () => {
      expect(Math.sign(compareTs(a, b))).toBe(expected);
    });
  }

  it('sorting a shuffled minted sequence recovers insertion order', async () => {
    const fake = await FakeSlack.start();
    try {
      const minted = Array.from({ length: 200 }, () => fake.mintTs());
      const shuffled = [...minted].sort(() => Math.random() - 0.5);
      expect([...shuffled].sort(compareTs)).toEqual(minted);
    } finally {
      await fake.close();
    }
  });
});
