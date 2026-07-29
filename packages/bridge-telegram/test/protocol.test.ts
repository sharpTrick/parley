import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asBackendMsgId, asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, KNOWN_CHANNEL, startFakeTelegram } from './fake-telegram.js';

const SENDER = asHandle('me');
const here = fileURLToPath(new URL('.', import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

async function startFake(): Promise<FakeTelegram> {
  const fake = await startFakeTelegram();
  cleanups.push(() => fake.close());
  return fake;
}

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-proto-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.jsonl');
}

async function connectTo(fake: FakeTelegram, extra: Record<string, unknown> = {}): Promise<TelegramPlugin> {
  const plugin = new TelegramPlugin();
  await plugin.connect({
    token: fake.token,
    api_url: fake.url,
    store_path: storePath(),
    poll_timeout_s: 1,
    ...extra,
  });
  cleanups.push(() => plugin.disconnect());
  return plugin;
}

/** Capture stderr diagnostics without letting them pollute the test output. */
function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

/**
 * A backend that cannot authenticate must fail `connect`, not report "bridge up" and then be a
 * silent black hole polling a rejecting API forever.
 */
describe('telegram connect preflight', () => {
  const CASES = [
    { name: 'missing token', config: (f: FakeTelegram) => ({ api_url: f.url }) },
    { name: 'empty token', config: (f: FakeTelegram) => ({ token: '', api_url: f.url }) },
    { name: 'rejected token (401)', config: (f: FakeTelegram) => ({ token: 'revoked', api_url: f.url }) },
    { name: 'wrong api_url (404)', config: (f: FakeTelegram) => ({ token: f.token, api_url: `${f.url}/nope` }) },
    { name: 'unreachable api_url', config: () => ({ token: 't', api_url: 'http://127.0.0.1:1' }) },
  ];

  it.each(CASES)('rejects connect on $name', async ({ config }) => {
    const fake = await startFake();
    const plugin = new TelegramPlugin();
    await expect(
      plugin.connect({ store_path: storePath(), poll_timeout_s: 1, ...config(fake) }),
    ).rejects.toThrow();
    await plugin.disconnect();
  });

  it('rejects connect when a chat_map entry names no reachable chat', async () => {
    const fake = await startFake();
    const plugin = new TelegramPlugin();
    await expect(
      connectTo(fake, { chat_map: { ops: 'not-a-chat-id' } }),
    ).rejects.toThrow(/not a Telegram chat id/);
    await plugin.disconnect();
  });
});

/**
 * How the shared getUpdates loop reacts per error code, so no prose claim about an error code
 * rests on an unexecuted branch: a wrong token/URL never heals, a 409 might, and either way
 * the operator gets Telegram's own description instead of silence.
 */
describe('telegram getUpdates error handling', () => {
  const CASES = [
    { status: 401, description: 'Unauthorized', fatal: true },
    { status: 403, description: 'Forbidden: bot was kicked', fatal: true },
    { status: 404, description: 'Not Found', fatal: true },
    {
      status: 409,
      description: "Conflict: can't use getUpdates method while webhook is active",
      fatal: false,
    },
    { status: 500, description: 'Internal Server Error', fatal: false },
  ];

  it.each(CASES)('status $status: reports it, fatal=$fatal', async ({ status, description, fatal }) => {
    const fake = await startFake();
    const stderr = captureStderr();
    fake.failMethod('getUpdates', { status, description });
    await connectTo(fake);

    await vi.waitFor(() => expect(stderr.join('')).toContain(description), {
      timeout: 5000,
      interval: 10,
    });
    const seen = fake.callCount('getUpdates');
    if (fatal) {
      // The loop stopped: no further polling, and the operator was told why.
      expect(stderr.join('')).toMatch(/stopped/);
      await new Promise((r) => setTimeout(r, 300));
      expect(fake.callCount('getUpdates')).toBe(seen);
    } else {
      await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBeGreaterThan(seen), {
        timeout: 6000,
        interval: 20,
      });
    }
  });

  it('throttles a persistent failure to one diagnostic per minute', async () => {
    const fake = await startFake();
    const stderr = captureStderr();
    fake.failMethod('getUpdates', { status: 500, description: 'Internal Server Error' });
    await connectTo(fake);

    await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBeGreaterThan(3), {
      timeout: 5000,
      interval: 20,
    });
    expect(stderr.filter((l) => l.includes('Internal Server Error'))).toHaveLength(1);
  });
});

/**
 * `limit` means the same thing on both fetchRecent branches. `slice(-0)` is `slice(0)` — the
 * whole history — so an unnormalized limit inverts its own meaning at zero and drops leading
 * messages when negative.
 */
describe('telegram fetchRecent limit normalization', () => {
  const LIMITS = [0, 1, 2, -5, 1000, undefined];
  const POSTED = ['a', 'b', 'c', 'd', 'e', 'f'];

  it.each(LIMITS)('limit %s means the same with and without `since`', async (limit) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const topic = asTopic('-1009900001');
    for (const c of POSTED) await plugin.post(topic, SENDER, c);

    const cap = (n: number): number => (limit === undefined ? n : Math.max(0, Math.min(limit, n)));
    const head = await plugin.fetchRecent({ topic, limit });
    expect(head.messages).toHaveLength(cap(POSTED.length));
    // Default window = the most recent `limit`, ascending.
    expect(head.messages.map((m) => m.content)).toEqual(
      POSTED.slice(POSTED.length - cap(POSTED.length)),
    );

    const all = (await plugin.fetchRecent({ topic })).messages;
    const since = all[0]!.cursor;
    const tail = await plugin.fetchRecent({ topic, since, limit });
    expect(tail.messages).toHaveLength(cap(POSTED.length - 1));
    expect(tail.messages.map((m) => m.content)).toEqual(
      POSTED.slice(1, 1 + cap(POSTED.length - 1)),
    );
    // The cursor never regresses, whatever the limit.
    expect(Number(tail.nextCursor)).toBeGreaterThanOrEqual(Number(since));
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
    const plugin = await connectTo(fake);
    const chat = '-1009800001';
    const topic = asTopic(chat);
    const first = await plugin.post(topic, SENDER, 'root');
    const mid = Number((first as string).split(':')[1]);

    await plugin.post(topic, SENDER, 'reply', { inReplyTo: asBackendMsgId(id(chat, mid)) });
    const body = fake.sent.at(-1);
    expect(body?.reply_to_message_id).toBe(threads ? mid : undefined);
  });
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
    const plugin = await connectTo(fake);
    const topic = asTopic(ref === '' ? ' ' : ref);
    await expect(plugin.post(topic, SENDER, 'x')).rejects.toThrow(/not a Telegram chat id/);
    await expect(plugin.fetchRecent({ topic })).rejects.toThrow(/not a Telegram chat id/);
    await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow(/not a Telegram chat id/);
  });
});

/**
 * A shipped knob absent from the documented table is a knob operators cannot use and cannot
 * discover — and this one silently bounds the history the README's own section promises.
 */
describe('telegram README config table', () => {
  it('documents exactly the keys TelegramBackendConfig accepts', () => {
    const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
    const block = /export interface TelegramBackendConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const declared = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
    const table = /## Config \(`backend_config`\)([\s\S]*?)\n## /.exec(readme)?.[1] ?? '';
    const documented = [...table.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]);

    expect([...documented].sort()).toEqual([...declared].sort());
  });
});
