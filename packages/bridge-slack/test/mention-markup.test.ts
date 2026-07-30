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
import { withSlack } from './harness.js';

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

/**
 * CLASS: one configured mapping, applied to every surface that carries a Slack id.
 *
 * `mention_map` is "Slack user/usergroup id → Parley handle", and it used to govern `content` only —
 * so the same configured person surfaced as `@alice` inside the text and as an opaque `U0ALICE` in
 * `senderHandle`. Two identities for one human: the roster, a `filter` glob over handles, and any
 * "who said this" reasoning saw the id while the text said the handle. Every row below asserts BOTH
 * fields from the SAME record, so a future field carrying an id has to declare whether the map
 * applies to it rather than inheriting an answer by accident.
 */
const IDENTITY_ROWS: Array<{
  name: string;
  event: Record<string, unknown>;
  senderHandle: string;
  mentions: string[];
}> = [
  {
    name: 'a mapped user id',
    event: { user: 'U0PARLEY', text: 'hi <@U0PARLEY>' },
    senderHandle: 'ctx-payments',
    mentions: ['ctx-payments'],
  },
  {
    name: 'an unmapped user id',
    event: { user: 'U0ALICE', text: 'hi <@U0ALICE>' },
    senderHandle: 'U0ALICE',
    mentions: ['U0ALICE'],
  },
  {
    name: 'a bot_id only, mapped',
    event: { bot_id: 'S0OPS', text: 'from the ops app' },
    senderHandle: 'ops-crew',
    mentions: [],
  },
  {
    name: 'a bot_id only, unmapped',
    event: { bot_id: 'B0HOOK', text: 'from a webhook' },
    senderHandle: 'B0HOOK',
    mentions: [],
  },
  {
    name: 'a user id that takes precedence over a bot_id',
    event: { user: 'U0PARLEY', bot_id: 'B0HOOK', text: 'both fields present' },
    senderHandle: 'ctx-payments',
    mentions: [],
  },
  {
    name: 'neither a user nor a bot_id',
    event: { text: 'from a workflow' },
    senderHandle: 'unknown',
    mentions: [],
  },
  {
    name: 'a meta-key id that IS a configured entry',
    event: { user: 'toString', text: 'hi <@toString>' },
    senderHandle: 'meta-mapped',
    mentions: ['meta-mapped'],
  },
  {
    name: 'a meta-key id that is NOT configured',
    event: { user: 'constructor', text: 'hi <@constructor>' },
    senderHandle: 'constructor',
    mentions: ['constructor'],
  },
];

describe('slack mention_map governs sender attribution and mention markup alike', () => {
  for (const row of IDENTITY_ROWS) {
    it(`${row.name}: same handle on the history and live paths`, async () => {
      await withPlugin(async (fake, plugin) => {
        const topic = asTopic('C0IDENT');
        fake.createChannel(topic);
        const live: Message[] = [];
        await plugin.subscribe(topic, (m) => live.push(m));

        const ts = fake.mintTs();
        fake.seedRaw(topic, [{ type: 'message', ts, ...row.event }]);
        fake.pushEvent(topic, { ts, ...row.event });
        await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

        const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
        for (const [where, m] of [
          ['live', live[0]!],
          ['history', messages[0]!],
        ] as const) {
          expect(String(m.senderHandle), `${where} senderHandle`).toBe(row.senderHandle);
          expect(m.mentions.map(String), `${where} mentions`).toEqual(row.mentions);
        }
      });
    });
  }

  // The point of the class, stated once: a mapped id must not read back as an id on ANY surface.
  it('no surface keeps the raw id for a mapped sender', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0IDENTRAW');
      fake.seed(topic, [{ text: 'x' }]);
      fake.seedRaw(topic, [
        { type: 'message', ts: fake.mintTs(), user: 'U0PARLEY', text: 'from parley' },
      ]);
      const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
      expect(messages.map((m) => String(m.senderHandle))).not.toContain('U0PARLEY');
      expect(messages.at(-1)!.senderHandle).toBe('ctx-payments');
    });
  });
});

/** The one axis this file varies: the mention map every row's expectations are written against. */
const withPlugin = withSlack.bind(null, { mentionMap: MENTION_MAP, handshakeTimeoutMs: 2000 });

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

  // The rewrite reads markup Slack put on the wire, never markup Parley did: `post` escapes its
  // content, so a mention can only ever be inbound. Both paths must agree on that, which is what
  // keeps a relayed `<@U0PARLEY>` from becoming a real mention (see `vendor-markup.test.ts`).
  it('the rewrite fires only for inbound markup, never for markup the bridge posted', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0MENTSELF');
      fake.createChannel(topic);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      await plugin.post(topic, asHandle('writer'), 'over to you <@U0PARLEY>');
      fake.seed(topic, [{ text: 'inbound <@U0PARLEY>' }]);
      fake.pushEvent(topic, { ts: fake.mintTs(), text: 'inbound <@U0PARLEY>', user: 'U0HUMAN' });

      await vi.waitFor(() => expect(live).toHaveLength(2), { timeout: 3000, interval: 10 });
      const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
      for (const [where, posted, inbound] of [
        ['live', live[0]!, live[1]!],
        ['history', messages[0]!, messages[1]!],
      ] as const) {
        expect(posted.content, where).toBe('over to you <@U0PARLEY>');
        // Core's parser still reads the bare `@U0PARLEY` token out of the literal text; what must
        // never appear is the CONFIGURED handle, which is what a `mention_filter` is armed on.
        expect(posted.mentions.map(String), where).not.toContain('ctx-payments');
        expect(inbound.content, where).toBe('inbound @ctx-payments');
        expect(inbound.mentions.map(String), where).toEqual(['ctx-payments']);
      }
    });
  });
});
