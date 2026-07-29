/**
 * CLASS: a transport whose native mention syntax core's `parseMentions` cannot read.
 *
 * Slack does not put `@handle` on the wire — it serializes a mention as `<@U0ABC>`, `<@U0ABC|name>`
 * or `<!subteam^S0DEV|@team>`. Passing that through leaves `Message.mentions` holding raw Slack ids,
 * so a bridge running with `live_push.mention_filter` on drops every message addressed to it, in
 * silence. The conformance rule `mentions === parseMentions(content)` cannot catch this: it grades
 * the backend against the very content the backend returned. Every row below therefore states the
 * handle it EXPECTS independently of the returned text, and is driven through BOTH delivery paths
 * so neither can drift from the other.
 */
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

/**
 * `toString` is a real configured entry that happens to name an `Object.prototype` member, so the
 * meta-key rows below carry a positive control: an OWN entry must keep resolving while an INHERITED
 * one must not answer at all.
 */
const MENTION_MAP: Record<string, string> = {
  U0PARLEY: 'ctx-payments',
  S0OPS: 'ops-crew',
  toString: 'meta-mapped',
};

/**
 * `content` is stated only where the rendered TEXT, not just the parsed handle, is the thing under
 * test: an id resolved through a prototype chain renders a JS engine internal straight into agent
 * context, which shows up in the text well before it shows up in `mentions`.
 */
const ROWS: Array<{ name: string; text: string; mentions: string[]; content?: string }> = [
  { name: 'mapped bare user id', text: 'hey <@U0PARLEY> please look', mentions: ['ctx-payments'] },
  {
    name: 'mapped user id with a label Slack supplied',
    text: 'hey <@U0PARLEY|parley-bot> look',
    mentions: ['ctx-payments'],
  },
  { name: 'unmapped user id with a label', text: 'cc <@U0ALICE|alice>', mentions: ['alice'] },
  {
    name: 'unmapped user id with an already-@ label',
    text: 'cc <@U0ALICE|@alice>',
    mentions: ['alice'],
  },
  { name: 'unmapped bare user id', text: 'cc <@U0BOB>', mentions: ['U0BOB'] },
  {
    name: 'mapped usergroup',
    text: 'ping <!subteam^S0OPS|@ops> now',
    mentions: ['ops-crew'],
  },
  {
    name: 'unmapped usergroup falls back to its label',
    text: 'ping <!subteam^S0DEV|@payments-team>',
    mentions: ['payments-team'],
  },
  { name: 'here broadcast', text: '<!here> standup', mentions: ['here'] },
  { name: 'channel broadcast', text: '<!channel> outage', mentions: ['channel'] },
  {
    name: 'two mentions in one message',
    text: '<@U0PARLEY> and <@U0ALICE|alice> both',
    mentions: ['ctx-payments', 'alice'],
  },
  // META KEYS: an id is untrusted vendor text, so `mention_map[id]` must consult OWN entries only.
  // Every row here is a key that `Object.prototype` answers for, at each lookup shape the rewrite has.
  {
    name: 'meta-key id that IS a configured entry',
    text: 'hey <@toString> look',
    mentions: ['meta-mapped'],
    content: 'hey @meta-mapped look',
  },
  {
    name: 'unconfigured meta-key bare id',
    text: 'cc <@constructor>',
    mentions: ['constructor'],
    content: 'cc @constructor',
  },
  {
    name: 'unconfigured meta-key id whose inherited value is an object',
    text: 'cc <@__proto__>',
    mentions: [],
    content: 'cc @__proto__',
  },
  {
    name: 'unconfigured meta-key usergroup',
    text: 'ping <!subteam^valueOf>',
    mentions: ['valueOf'],
    content: 'ping @valueOf',
  },
  {
    name: 'unconfigured meta-key id with a label Slack supplied',
    text: 'cc <@hasOwnProperty|alice>',
    mentions: ['alice'],
    content: 'cc @alice',
  },
  // Not mentions: markup the rewrite must leave exactly as Slack wrote it.
  { name: 'date markup', text: 'due <!date^1392734382^{date}|Feb 18, 2014>', mentions: [] },
  { name: 'link markup', text: 'see <https://example.com|the docs>', mentions: [] },
  { name: 'channel link markup', text: 'in <#C0OTHER|general>', mentions: [] },
  { name: 'plain text with no markup', text: 'nothing to see', mentions: [] },
];

async function withPlugin<T>(fn: (fake: FakeSlack, plugin: SlackPlugin) => Promise<T>): Promise<T> {
  const fake = await FakeSlack.start();
  const plugin = new SlackPlugin();
  await plugin.connect({
    api_url: fake.apiUrl,
    bot_token: 'xoxb-test',
    app_token: 'xapp-test',
    mention_map: MENTION_MAP,
    handshake_timeout_ms: 2000,
  });
  try {
    return await fn(fake, plugin);
  } finally {
    await plugin.disconnect();
    await fake.close();
  }
}

describe('slack mention markup becomes Parley handles on both delivery paths', () => {
  it('history: every row yields the handles it declares', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0MENTHIST');
      fake.seed(
        topic,
        ROWS.map((r) => ({ text: r.text })),
      );
      const { messages } = await plugin.fetchRecent({ topic, limit: 100 });
      expect(messages).toHaveLength(ROWS.length);
      for (const [i, row] of ROWS.entries()) {
        expect(messages[i]!.mentions.map(String), row.name).toEqual(row.mentions);
        if (row.content !== undefined) expect(messages[i]!.content, row.name).toBe(row.content);
      }
    });
  });

  it('live push: the same rows yield the same handles', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0MENTLIVE');
      fake.createChannel(topic);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      for (const row of ROWS) {
        fake.pushEvent(topic, { ts: fake.mintTs(), text: row.text, user: 'U0X' });
      }
      await vi.waitFor(() => expect(live).toHaveLength(ROWS.length), { timeout: 3000, interval: 10 });
      for (const [i, row] of ROWS.entries()) {
        expect(live[i]!.mentions.map(String), row.name).toEqual(row.mentions);
        if (row.content !== undefined) expect(live[i]!.content, row.name).toBe(row.content);
      }
    });
  });

  it('the rows that declare no mention keep their markup verbatim', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0MENTRAW');
      // A row that states its own `content` states it above; these are the ones claiming NOTHING
      // was rewritten, so the markup is what they must read back as.
      const untouched = ROWS.filter((r) => r.mentions.length === 0 && r.content === undefined);
      fake.seed(
        topic,
        untouched.map((r) => ({ text: r.text })),
      );
      const { messages } = await plugin.fetchRecent({ topic, limit: 100 });
      expect(messages.map((m) => m.content)).toEqual(untouched.map((r) => r.text));
    });
  });

  it('a message the bridge posts to itself round-trips as its own handle', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0MENTSELF');
      fake.createChannel(topic);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      await plugin.post(topic, asHandle('writer'), 'over to you <@U0PARLEY>');

      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });
      expect(live[0]!.mentions.map(String)).toEqual(['ctx-payments']);
      const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
      expect(messages.at(-1)!.mentions.map(String)).toEqual(['ctx-payments']);
    });
  });
});
