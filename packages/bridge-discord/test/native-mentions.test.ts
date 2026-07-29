import { asHandle, asTopic, type Handle, type Message, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';

// Discord never puts `@handle` text on the wire: a mention is `<@id>` markup plus a resolved
// `mentions[]` array. `Message.mentions` is what core's push loop filters on
// (`!m.mentions.includes(identity)` → dropped), so a plugin that hands the RAW provider markup to
// buildMessage makes live push a silent no-op. This table is over the provider's mention syntax,
// asserted on BOTH delivery paths — live push and catch-up must agree.

const BOT = asHandle('ctx-payments');
const BOT_ID = '112233445566';
const OTHER = { id: '998877665544', username: 'alice' };

let seq = 0;
const freshChannelId = (): string =>
  String(500_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

interface Row {
  label: string;
  content: string;
  mentions?: Array<{ id: string; username: string }>;
  expected: string[];
  /** Content as it should read once provider markup is normalized (default: unchanged). */
  rendered?: string;
}

const ROWS: Row[] = [
  {
    label: 'plain @handle text',
    content: 'hello @ctx-payments please review',
    expected: ['ctx-payments'],
  },
  {
    label: 'user mention markup',
    content: `<@${BOT_ID}> please review`,
    mentions: [{ id: BOT_ID, username: BOT as string }],
    expected: ['ctx-payments'],
    rendered: '@ctx-payments please review',
  },
  {
    label: 'nickname mention markup',
    content: `<@!${BOT_ID}> please review`,
    mentions: [{ id: BOT_ID, username: BOT as string }],
    expected: ['ctx-payments'],
    rendered: '@ctx-payments please review',
  },
  {
    label: 'two mentions in one message',
    content: `<@${BOT_ID}> and <@${OTHER.id}> both`,
    mentions: [{ id: BOT_ID, username: BOT as string }, OTHER],
    expected: ['ctx-payments', 'alice'],
    rendered: '@ctx-payments and @alice both',
  },
  {
    label: 'mention markup mid-sentence',
    content: `ping <@${BOT_ID}>, thanks`,
    mentions: [{ id: BOT_ID, username: BOT as string }],
    expected: ['ctx-payments'],
    rendered: 'ping @ctx-payments, thanks',
  },
  {
    label: 'an id Discord did not resolve',
    content: '<@777000111222> hi',
    expected: ['unknown-user'], // never the raw snowflake, which is not a Parley handle
    rendered: '@unknown-user hi',
  },
  {
    label: 'a channel reference',
    content: 'see <#556677> for context',
    expected: [],
  },
  {
    label: 'a role reference',
    content: '<@&443322> standup',
    expected: [],
  },
  {
    label: 'an email address',
    content: 'mail alice@example.com',
    expected: [],
  },
];

describe('Discord native mention syntax', () => {
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

  /** Core's push-loop filter, verbatim (transport/push-loop.ts): this is what `mentions` is FOR. */
  const passesMentionFilter = (m: Message, identity: Handle): boolean =>
    m.mentions.includes(identity);

  for (const row of ROWS) {
    it(`${row.label}: mentions are logical handles on both delivery paths`, async () => {
      const topic = liveTopic();
      const pushed: Message[] = [];
      await plugin.subscribe(topic, (m) => pushed.push(m));

      fake.deliver(topic as string, { content: row.content, mentions: row.mentions });

      await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 3000, interval: 10 });
      const viaCatchUp = (await plugin.fetchRecent({ topic })).messages;
      expect(viaCatchUp).toHaveLength(1);

      for (const m of [pushed[0]!, viaCatchUp[0]!]) {
        expect(m.mentions).toEqual(row.expected.map(asHandle));
        expect(m.content).toBe(row.rendered ?? row.content);
        expect(passesMentionFilter(m, BOT)).toBe(row.expected.includes(BOT as string));
      }
    });
  }

  it('a bot posting @handle text keeps working end to end', async () => {
    const topic = liveTopic();
    const pushed: Message[] = [];
    await plugin.subscribe(topic, (m) => pushed.push(m));

    await plugin.post(topic, asHandle('writer'), `@${BOT as string} ping`);

    await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 3000, interval: 10 });
    expect(passesMentionFilter(pushed[0]!, BOT)).toBe(true);
  });
});
