import { asBackendMsgId, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { type FakeTelegram, KNOWN_CHANNEL } from './fake-telegram.js';
import { captureStderr, connectFresh, SENDER, startFake } from './rig.js';

/**
 * A memoized resolution must never remember a FAILURE. `chatIdByTopic` and `canonicalById` live for
 * the whole connection, so one transient `getChat` failure would otherwise make an
 * `@channelusername` topic permanently unresolvable: every post, subscribe and catch-up on it
 * rejects for the life of the connection, and core's presence loop swallows the rejection, so the
 * only symptom is a topic that is silently never delivered. Each cell fails the resolution ONCE and
 * then repeats the identical call on the same instance.
 */
describe('telegram transient resolution failures', () => {
  const FAILURES = [
    {
      name: 'a 500',
      arm: (f: FakeTelegram) => f.failMethod('getChat', { status: 500, description: 'Internal Server Error' }),
      clear: (f: FakeTelegram) => f.failMethod('getChat', undefined),
    },
    {
      name: 'a transport failure',
      arm: (f: FakeTelegram) => f.stallMethod('getChat', 'close-mid-body'),
      clear: (f: FakeTelegram) => f.stallMethod('getChat', undefined),
    },
    {
      name: 'a 429 asking for longer than the call has',
      arm: (f: FakeTelegram) =>
        f.failMethod('getChat', {
          status: 429,
          description: 'Too Many Requests: retry later',
          retryAfterBody: 3600,
        }),
      clear: (f: FakeTelegram) => f.failMethod('getChat', undefined),
    },
    {
      name: 'a 2xx carrying ok:false',
      arm: (f: FakeTelegram) =>
        f.malformMethod('getChat', '{"ok":false,"error_code":400,"description":"chat not found"}'),
      clear: (f: FakeTelegram) => f.malformMethod('getChat', undefined),
    },
  ];
  const RESOLVING_CALLS = ['post', 'fetchRecent', 'subscribe'] as const;
  const MEMO_CELLS = FAILURES.flatMap((failure) =>
    RESOLVING_CALLS.map((call) => ({ failure, call })),
  );

  it.each(MEMO_CELLS)(
    '$failure.name resolving a topic fails $call once, and the next identical call succeeds',
    async ({ failure, call }) => {
      const fake = await startFake();
      captureStderr();
      const plugin = await connectFresh(fake);
      const topic = asTopic(KNOWN_CHANNEL.username);
      const invoke = (): Promise<unknown> => {
        if (call === 'post') return plugin.post(topic, SENDER, 'x');
        if (call === 'fetchRecent') return plugin.fetchRecent({ topic });
        return plugin.subscribe(topic, () => undefined);
      };

      failure.arm(fake);
      await expect(invoke()).rejects.toThrow();
      failure.clear(fake);
      await expect(invoke()).resolves.not.toThrow();
      // And the resolution really happened rather than being served from a poisoned memo.
      await expect(plugin.fetchRecent({ topic, limit: 100 })).resolves.toBeDefined();
    },
    20_000,
  );
});

/**
 * The fake must reject what the real Bot API rejects — a fake that accepts any string as a
 * chat_id lets the whole suite pass on topics Telegram would answer with 400.
 */
describe('telegram chat_id validation', () => {
  const REFS = [
    { name: 'numeric id', ref: '-1001111111', status: 200 },
    { name: 'positive numeric id', ref: '4242', status: 200 },
    { name: '@channelusername', ref: KNOWN_CHANNEL.username, status: 200 },
    { name: 'arbitrary literal', ref: 'chat-3-a9f2', status: 400 },
    { name: 'too-short @name', ref: '@ab', status: 400 },
    { name: 'empty', ref: '', status: 400 },
  ];

  it.each(REFS)('the fake answers $status for $name', async ({ ref, status }) => {
    const fake = await startFake();
    const res = await fetch(`${fake.url}/bot${fake.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ref, text: 'x' }),
    });
    expect(res.status).toBe(status);
  });

  it.each(REFS.filter((r) => r.status === 400))('the plugin refuses a topic naming $name', async ({ ref }) => {
    const fake = await startFake();
    captureStderr();
    const plugin = await connectFresh(fake);
    const topic = asTopic(ref === '' ? ' ' : ref);
    await expect(plugin.post(topic, SENDER, 'x')).rejects.toThrow(/not a Telegram chat id/);
    await expect(plugin.fetchRecent({ topic })).rejects.toThrow(/not a Telegram chat id/);
    await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow(/not a Telegram chat id/);
  });
});

/**
 * `backendMsgId` is composite because `message_id` is unique only PER CHAT; a composite from
 * another chat therefore denotes nothing here and must not be threaded onto whatever local
 * message happens to share the number.
 */
describe('telegram inReplyTo threading', () => {
  it.each([
    { name: 'same-chat composite', id: (chat: string, mid: number) => `${chat}:${mid}`, threads: true },
    { name: 'other-chat composite', id: (_c: string, mid: number) => `-1009999999:${mid}`, threads: false },
    { name: 'bare message id', id: (_c: string, mid: number) => String(mid), threads: false },
    { name: 'negative message id', id: (chat: string) => `${chat}:-4`, threads: false },
    { name: 'zero message id', id: (chat: string) => `${chat}:0`, threads: false },
    { name: 'non-numeric message id', id: (chat: string) => `${chat}:abc`, threads: false },
    { name: 'empty string', id: () => '', threads: false },
  ])('$name', async ({ id, threads }) => {
    const fake = await startFake();
    const plugin = await connectFresh(fake);
    const chat = '-1009800001';
    const topic = asTopic(chat);
    const first = await plugin.post(topic, SENDER, 'root');
    const mid = Number((first as string).split(':')[1]);

    await plugin.post(topic, SENDER, 'reply', { inReplyTo: asBackendMsgId(id(chat, mid)) });
    const body = fake.sent.at(-1);
    expect(body?.reply_to_message_id).toBe(threads ? mid : undefined);
  });
});
