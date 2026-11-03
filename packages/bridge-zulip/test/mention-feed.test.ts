/**
 * A message that names a Parley handle in Zulip reaches that handle, whatever topic it is on.
 *
 * Two halves, each graded as the promise rather than the parse: the mention syntax a Zulip user or
 * bot actually writes is read into `Message.mentions` (and the syntax that names nobody is not),
 * and `subscribeMentions` delivers what names the handle from every topic in the stream — under the
 * topic it was posted on — and nothing that does not.
 */
import { asHandle, asTopic, type Handle, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { MEMBERS_REFRESH_MS, RealmMembers } from '../src/members.js';
import { buildZulipMessage, zulipMentionSpellings } from '../src/wire.js';
import { rand, sleep, useZulip } from './harness.js';

const useBoot = useZulip();
const ME = asHandle('claude-code-taskqueue');
const REALM = [
  { user_id: 42, email: 'taskqueue-bot@localhost', full_name: 'claude-code-taskqueue', is_bot: true },
  { user_id: 43, email: 'other-bot@localhost', full_name: 'claude-code-other', is_bot: true },
  { user_id: 44, email: 'gone-bot@localhost', full_name: 'claude-code-gone', is_bot: true, is_active: false },
  { user_id: 8, email: 'pat@example.com', full_name: 'Patrick Sharp', is_bot: false },
];
const boot = () => useBoot({ members: REALM });

type Row = [label: string, content: string, mentions: Handle[], addressed: Handle[]];

describe('who a Zulip message mentions, and who it is explicitly addressed to', () => {
  it.each<Row>([
    ['the compose box’s @**name|id**', 'see @**claude-code-taskqueue|42** please', [ME], [ME]],
    ['a bare @**name**', 'see @**claude-code-taskqueue** please', [ME], [ME]],
    ['a plain @handle, which mentions without addressing', 'see @claude-code-taskqueue please', [ME], []],
    ['both spellings of one handle, once', '@**claude-code-taskqueue** and @claude-code-taskqueue', [ME], [ME]],
    ['one handle addressed twice, once', '@**claude-code-taskqueue** @**claude-code-taskqueue|42**', [ME], [ME]],
    ['a silent mention, which notifies nobody', 'as @_**claude-code-taskqueue** said', [], []],
    ...['all', 'everyone', 'channel', 'stream', 'topic'].map(
      (w): Row => [`the @**${w}** wildcard`, `heads up @**${w}**`, [], []],
    ),
    ['a person’s display name, which is no handle', 'thanks @**Patrick Sharp**', [], []],
    ['an address in inline code', 'type `@**claude-code-taskqueue**` to address it', [], []],
    ['an address in a code fence', '```\n@**claude-code-taskqueue**\n```', [], []],
    ['an address after a fence nobody closed', 'see\n```\n@**claude-code-taskqueue**', [], []],
    ['an address in a block quote', '> @**claude-code-taskqueue** said so', [], []],
    ['an address run into the word before it', 'mail@**claude-code-taskqueue**', [], []],
    ['an address in parentheses', '(@**claude-code-taskqueue**)', [ME], [ME]],
    ['a user group', 'ping @*maintainers*', [], []],
    ['a name no member has, which Zulip shows as text', 'Zulip spells it @**handle**', [], []],
    ['a member’s name with another member’s id', 'see @**claude-code-taskqueue|43**', [], []],
    ['a member’s name in another case, as the member is named', 'see @**Claude-Code-TaskQueue**', [ME], [ME]],
    ['a deactivated member', 'see @**claude-code-gone**', [], []],
  ])('%s', async (_label, content, mentions, addressed) => {
    const members = new RealmMembers(async () => REALM);
    await members.learn(zulipMentionSpellings(content));
    const m = buildZulipMessage(asTopic('t'), { id: 1, content }, 1, members.lookup);
    expect([m.mentions, m.addressed]).toEqual([mentions, addressed]);
  });
});

describe('subscribeMentions delivers what names the handle, from every topic', () => {
  it('delivers a mention on a topic nobody subscribed to, under that topic, and nothing else', async () => {
    const { plugin, fake } = await boot();
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));
    const elsewhere = `project-${rand()}`;

    fake.injectMessage({ topic: elsewhere, content: 'no one named here' });
    fake.injectMessage({ topic: elsewhere, content: 'over to you @**claude-code-taskqueue|42**' });
    fake.injectMessage({ topic: 'general', content: 'and @**claude-code-other**, not you' });

    await vi.waitFor(() => expect(got).toHaveLength(1));
    await sleep(300);
    expect(got.map((m) => [m.topic, m.content])).toEqual([
      [elsewhere, 'over to you @**claude-code-taskqueue|42**'],
    ]);
  });

  it('passes over a record it cannot place on a topic, and keeps delivering', async () => {
    const { plugin, fake } = await boot();
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));

    fake.injectRaw({ topic: 'general', fields: { subject: undefined, content: '@**claude-code-taskqueue** a' } });
    fake.injectMessage({ topic: 'general', content: '@**claude-code-taskqueue** b' });

    await vi.waitFor(() => expect(got).toHaveLength(1));
    await sleep(300);
    expect(got.map((m) => [m.topic, m.content])).toEqual([['general', '@**claude-code-taskqueue** b']]);
  });

  it('places a mention on the Parley topic that claimed its Zulip topic, whatever case it arrives in', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`Ops-${rand()}`);
    await plugin.subscribe(topic, () => undefined);
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));

    fake.injectMessage({ topic: topic.toUpperCase(), content: '@**claude-code-taskqueue** look' });

    await vi.waitFor(() => expect(got.map((m) => m.topic)).toEqual([topic]));
  });

  it('places a mention on a topic nobody claimed as it was posted, case and all', async () => {
    const { plugin, fake } = await boot();
    const posted = `Project-${rand().toUpperCase()}`;
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));

    fake.injectMessage({ topic: posted, content: '@**claude-code-taskqueue** look' });

    await vi.waitFor(() => expect(got.map((m) => m.topic)).toEqual([posted]));
  });

  it('delivers a mention whose id was committed late, on another topic', async () => {
    const { plugin, fake } = await boot();
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));

    const late = fake.injectMessage({ topic: `a-${rand()}`, content: 'placeholder' });
    fake.injectMessage({ topic: `b-${rand()}`, content: '@**claude-code-taskqueue** first committed' });
    fake.injectRaw({ topic: `c-${rand()}`, fields: { id: late, content: '@**claude-code-taskqueue** committed late' } });

    await vi.waitFor(() => expect(got.map((m) => m.content)).toContain('@**claude-code-taskqueue** committed late'));
  });

  it('keeps a topic’s own queue narrowed to its topic after Zulip garbage-collects it', async () => {
    const { plugin, fake } = await boot();
    const mine = asTopic(`mine-${rand()}`);
    const got: Message[] = [];
    await plugin.subscribe(mine, (m) => got.push(m));
    fake.expireQueues();
    await sleep(300);

    fake.injectMessage({ topic: `other-${rand()}`, content: 'not for this topic' });
    fake.injectMessage({ topic: mine, content: 'for this topic' });

    await vi.waitFor(() => expect(got.map((m) => m.content)).toContain('for this topic'), { timeout: 3_000 });
    await sleep(300);
    expect(got.map((m) => m.content)).toEqual(['for this topic']);
  });

  it('delivers nothing once the plugin disconnects', async () => {
    const { plugin, fake } = await boot();
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));
    fake.injectMessage({ topic: `a-${rand()}`, content: '@**claude-code-taskqueue** before' });
    await vi.waitFor(() => expect(got).toHaveLength(1));

    await plugin.disconnect();
    fake.injectMessage({ topic: `a-${rand()}`, content: '@**claude-code-taskqueue** after' });
    await sleep(500);
    expect(got.map((m) => m.content)).toEqual(['@**claude-code-taskqueue** before']);
  });

  it('keeps reading the whole stream after Zulip garbage-collects its queue', async () => {
    const { plugin, fake } = await boot();
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));
    fake.expireQueues();
    await sleep(300);

    const [one, two] = [`a-${rand()}`, `b-${rand()}`];
    fake.injectMessage({ topic: one, content: '@**claude-code-taskqueue** first' });
    fake.injectMessage({ topic: two, content: '@**claude-code-taskqueue** second' });

    await vi.waitFor(() => expect(got.map((m) => m.topic).sort()).toEqual([one, two].sort()), { timeout: 3_000 });
  });
});

describe('an address names a member of the realm, on the live path and in history alike', () => {
  it('arrives addressed to the member it names, and to nobody when no member has the name', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`t-${rand()}`);
    const pushed: Message[] = [];
    await plugin.subscribe(topic, (m) => pushed.push(m));

    fake.injectMessage({ topic, content: 'over to @**claude-code-taskqueue**' });
    fake.injectMessage({ topic, content: 'the syntax is @**handle**' });

    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    const { messages } = await plugin.fetchRecent({ topic });
    for (const path of [pushed, messages]) {
      expect(path.map((m) => m.addressed)).toEqual([[ME], []]);
    }
  });

  it('addresses a member who joined after the realm was last read, once the refresh interval has passed', async () => {
    const realm = REALM.filter((u) => u.full_name !== 'claude-code-taskqueue');
    const { plugin, fake } = await useBoot({ members: realm });
    const topic = asTopic(`t-${rand()}`);
    fake.injectMessage({ topic, content: 'over to @**claude-code-taskqueue**' });
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.addressed)).toEqual([[]]);

    realm.push(REALM[0]!);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + MEMBERS_REFRESH_MS);
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.addressed)).toEqual([[ME]]);
  });
});
