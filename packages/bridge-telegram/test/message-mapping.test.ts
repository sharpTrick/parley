import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { contentsOf, startRig } from './rig.js';

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

const DATE = 1_600_000_000;
const SENDER_CHAT = '-1005557000';

/**
 * `senderHandle` and `timestamp` are agent-visible fields no other test in this package reads:
 * both mappings can be replaced by a constant without a single failure. Every sender shape
 * Telegram actually emits gets pinned here, through BOTH the live-push and the catch-up path.
 */
const FROM_SHAPES = [
  {
    name: 'from with a username',
    kind: 'message' as const,
    payload: { from: { id: 77, is_bot: false, username: 'alice' }, text: 'a', date: DATE },
    sender: 'alice',
  },
  {
    name: 'from without a username',
    kind: 'message' as const,
    payload: { from: { id: 77, is_bot: false }, text: 'b', date: DATE },
    sender: '77',
  },
  {
    name: 'another bot',
    kind: 'message' as const,
    payload: { from: { id: 4242, is_bot: true, username: 'otherbot' }, text: 'c', date: DATE },
    sender: 'otherbot',
  },
  {
    name: 'channel post with no from',
    kind: 'channel_post' as const,
    payload: { text: 'd', date: DATE },
    sender: SENDER_CHAT,
  },
];

describe('telegram sender and timestamp mapping', () => {
  it.each(FROM_SHAPES)('$name', async ({ kind, payload, sender }) => {
    const rig = await startRig();
    const topic = asTopic(SENDER_CHAT);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));

    rig.fake.injectRaw(SENDER_CHAT, payload, kind);
    await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

    const fetched = (await rig.plugin.fetchRecent({ topic })).messages;
    expect(fetched).toHaveLength(1);
    for (const msg of [live[0] as Message, fetched[0] as Message]) {
      expect(msg.senderHandle).toBe(sender);
      expect(Date.parse(msg.timestamp)).toBe(DATE * 1000);
    }
  });
});
