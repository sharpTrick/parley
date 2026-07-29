/**
 * CLASS: a backend's absent-topic errors must map onto the seam's absent-topic contract, and
 * nothing else may. Core distinguishes "topic not present yet" (`NoSuchTopicError` — a normal
 * result, e.g. an empty presence roster) from a real backend failure (propagates). Slack signals
 * absence with `ok:false, error:'channel_not_found'`, which the generic `ok:false → Error` path
 * flattens into an indistinguishable failure — so a default deployment whose presence topic is not
 * a real channel id hard-fails `parley_list_users` instead of returning the empty roster.
 */
import { asCursor, asHandle, asTopic, NoSuchTopicError } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

type Op = 'fetchRecent' | 'fetchRecent-since' | 'post';

/** code → the ops for which it means "the topic is not there for us". */
const CODES: Array<{ code: string; absentFor: Op[] }> = [
  { code: 'channel_not_found', absentFor: ['fetchRecent', 'fetchRecent-since', 'post'] },
  { code: 'not_in_channel', absentFor: ['fetchRecent', 'fetchRecent-since'] },
  { code: 'is_archived', absentFor: [] },
  { code: 'invalid_auth', absentFor: [] },
  { code: 'ratelimited', absentFor: [] },
];

const OPS: Op[] = ['fetchRecent', 'fetchRecent-since', 'post'];
const METHOD_OF: Record<Op, string> = {
  fetchRecent: 'conversations.history',
  'fetchRecent-since': 'conversations.history',
  post: 'chat.postMessage',
};

async function run(plugin: SlackPlugin, op: Op): Promise<void> {
  const topic = asTopic('C0ABSENT');
  if (op === 'post') {
    await plugin.post(topic, asHandle('writer'), 'hello');
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
        await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
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
