/**
 * CLASS: a backend's absent-topic errors must map onto the seam's absent-topic contract, and
 * nothing else may. Core distinguishes "topic not present yet" (`NoSuchTopicError` — a normal
 * result, e.g. an empty presence roster) from a real backend failure (propagates). Slack signals
 * absence with `ok:false, error:'channel_not_found'`, which the generic `ok:false → Error` path
 * flattens into an indistinguishable failure — so a default deployment whose presence topic is not
 * a real channel id hard-fails `parley_list_users` instead of returning the empty roster.
 */
import { asCursor, asHandle, asTopic, NoSuchTopicError, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

/**
 * `subscribe` is an op here because it is the one seam call that can report success and then deliver
 * nothing forever: Socket Mode says nothing about whether a channel exists or is readable, so a
 * typo'd `channel_map` target, a channel the bot was never invited to, or a missing
 * `message.channels` event subscription would otherwise resolve and go silent — while `fetchRecent`
 * on the SAME topic correctly reports absence, and core's "topic does not exist yet" branch never
 * runs. Every future absence code has to state its `subscribe` answer alongside the others.
 */
type Op = 'fetchRecent' | 'fetchRecent-since' | 'post' | 'subscribe';

/** code → the ops for which it means "the topic is not there for us". */
const CODES: Array<{ code: string; absentFor: Op[] }> = [
  { code: 'channel_not_found', absentFor: ['fetchRecent', 'fetchRecent-since', 'post', 'subscribe'] },
  { code: 'not_in_channel', absentFor: ['fetchRecent', 'fetchRecent-since', 'subscribe'] },
  { code: 'is_archived', absentFor: [] },
  { code: 'invalid_auth', absentFor: [] },
  { code: 'ratelimited', absentFor: [] },
];

const OPS: Op[] = ['fetchRecent', 'fetchRecent-since', 'post', 'subscribe'];
const METHOD_OF: Record<Op, string> = {
  fetchRecent: 'conversations.history',
  'fetchRecent-since': 'conversations.history',
  post: 'chat.postMessage',
  subscribe: 'conversations.history',
};

async function run(plugin: SlackPlugin, op: Op): Promise<void> {
  const topic = asTopic('C0ABSENT');
  if (op === 'post') {
    await plugin.post(topic, asHandle('writer'), 'hello');
    return;
  }
  if (op === 'subscribe') {
    await plugin.subscribe(topic, () => undefined);
    return;
  }
  await plugin.fetchRecent(
    op === 'fetchRecent' ? { topic } : { topic, since: asCursor('0') },
  );
}

describe('slack absent-topic semantics', () => {
  for (const { code, absentFor } of CODES) {
    for (const op of OPS) {
      const absent = absentFor.includes(op);
      it(`${op} on ${code} → ${absent ? 'NoSuchTopicError' : 'a plain Error'}`, async () => {
        const fake = await FakeSlack.start();
        fake.createChannel('C0ABSENT');
        const plugin = new SlackPlugin();
        await plugin.connect({
          api_url: fake.apiUrl,
          bot_token: 'xoxb-test',
          app_token: 'xapp-test',
        });
        try {
          fake.failMethod(METHOD_OF[op], code);
          const err = await run(plugin, op).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(Error);
          expect(err instanceof NoSuchTopicError).toBe(absent);
          if (!absent) expect(String(err)).toContain(code);
        } finally {
          await plugin.disconnect();
          await fake.close();
        }
      });
    }
  }

  // The negative control the table above cannot state: a REACHABLE topic must not be refused by the
  // reachability probe, and must still deliver live. Without this, mapping every code to absent —
  // or rejecting every subscribe outright — would pass every row.
  it('subscribe on a reachable channel resolves and still delivers live', async () => {
    const fake = await FakeSlack.start();
    const topic = asTopic('C0REACHABLE');
    fake.createChannel(topic);
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      await plugin.post(topic, asHandle('writer'), 'delivered');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toEqual(['delivered']), {
        timeout: 3000,
        interval: 10,
      });
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  // A channel id that was NEVER created is the everyday shape of the defect — a `channel_map` typo —
  // and reaches the plugin as the vendor's own `channel_not_found` rather than an injected failure.
  it('subscribe on a channel that does not exist rejects, and registers no route', async () => {
    const fake = await FakeSlack.start();
    const missing = asTopic('C0TYPO');
    const real = asTopic('C0REAL');
    fake.createChannel(real);
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const live: Message[] = [];
      await expect(plugin.subscribe(missing, (m) => live.push(m))).rejects.toBeInstanceOf(
        NoSuchTopicError,
      );
      // Both delivery paths must agree that the topic is absent — the asymmetry IS the defect.
      await expect(plugin.fetchRecent({ topic: missing })).rejects.toBeInstanceOf(NoSuchTopicError);
      // A rejected subscribe left no route behind: the channel later existing must not resurrect it.
      fake.createChannel(missing);
      await plugin.subscribe(real, () => undefined);
      await plugin.post(missing, asHandle('writer'), 'to the abandoned route');
      await new Promise((r) => setTimeout(r, 300));
      expect(live).toEqual([]);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('an EXISTING but empty channel still returns an empty page, not an absent topic', async () => {
    const fake = await FakeSlack.start();
    const topic = asTopic('C0EMPTY');
    fake.createChannel(topic);
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
    try {
      const first = await plugin.fetchRecent({ topic });
      expect(first.messages).toEqual([]);
      const again = await plugin.fetchRecent({ topic, since: first.nextCursor });
      expect(again.messages).toEqual([]);
      expect(again.nextCursor).toBe(first.nextCursor);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});
