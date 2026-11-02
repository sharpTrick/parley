/**
 * A message that names a Parley handle in Zulip reaches that handle, whatever topic it is on.
 *
 * Two halves, each graded as the promise rather than the parse: the mention syntax a Zulip user or
 * bot actually writes is read into `Message.mentions` (and the syntax that names nobody is not),
 * and `subscribeMentions` delivers what names the handle from every topic in the stream — under the
 * topic it was posted on — and nothing that does not.
 */
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { buildZulipMessage } from '../src/wire.js';
import { rand, sleep, useZulip } from './harness.js';

const boot = useZulip();
const ME = asHandle('claude-code-taskqueue');

describe('the mentions a Zulip message carries', () => {
  it.each([
    ['the compose box’s @**name|id**', 'see @**claude-code-taskqueue|42** please', [ME]],
    ['a bare @**name**', 'see @**claude-code-taskqueue** please', [ME]],
    ['a plain @handle', 'see @claude-code-taskqueue please', [ME]],
    ['both spellings of one handle, once', '@**claude-code-taskqueue** and @claude-code-taskqueue', [ME]],
    ['a silent mention, which notifies nobody', 'as @_**claude-code-taskqueue** said', []],
    ['the @**all** wildcard', 'heads up @**all**', []],
    ['the @**topic** wildcard', 'heads up @**topic**', []],
    ['a person’s display name, which is no handle', 'thanks @**Patrick Sharp**', []],
    ['a user group', 'ping @*maintainers*', []],
  ] as const)('%s', (_label, content, mentions) => {
    expect(buildZulipMessage(asTopic('t'), { id: 1, content }, 1).mentions).toEqual(mentions);
  });
});

describe('subscribeMentions delivers what names the handle, from every topic', () => {
  it('delivers a mention on a topic nobody subscribed to, under that topic, and nothing else', async () => {
    const { plugin, fake } = await boot();
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));
    const elsewhere = `project-${rand()}`;

    fake.injectMessage({ topic: elsewhere, content: 'no one named here' });
    fake.injectMessage({ topic: elsewhere, content: 'over to you @**claude-code-taskqueue|7**' });
    fake.injectMessage({ topic: 'general', content: 'and @**claude-code-other**, not you' });

    await vi.waitFor(() => expect(got).toHaveLength(1));
    await sleep(300);
    expect(got.map((m) => [m.topic, m.content])).toEqual([
      [elsewhere, 'over to you @**claude-code-taskqueue|7**'],
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

  it('places a mention on the Parley topic that claimed its Zulip topic', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`Ops-${rand()}`);
    await plugin.subscribe(topic, () => undefined);
    const got: Message[] = [];
    await plugin.subscribeMentions(ME, (m) => got.push(m));

    fake.injectMessage({ topic: topic.toLowerCase(), content: '@**claude-code-taskqueue** look' });

    await vi.waitFor(() => expect(got.map((m) => m.topic)).toEqual([topic]));
  });
});
