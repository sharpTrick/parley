import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { ObservedStore } from '../src/store.js';
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
    captureStderr();
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

  /**
   * The throttle is per failure CLASS. A dropped or refused record is permanent message loss —
   * the update is acknowledged to Telegram before the store sees it — so an unrelated failure
   * chattering in the same minute must not be able to swallow its only diagnostic.
   */
  it('throttles each failure kind independently', async () => {
    const fake = await startFake();
    const stderr = captureStderr();
    // Both configured chats are served, so a third chat has nothing unserved to displace.
    const plugin = await connectTo(fake, {
      observed_max_chats: 2,
      chat_map: { a: '-1009400001', b: '-1009400002' },
    });
    await plugin.post(asTopic('a'), SENDER, 'seed-a');
    await plugin.post(asTopic('b'), SENDER, 'seed-b');

    vi.spyOn(ObservedStore.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    fake.injectUserMessage('-1009400001', 'alice', 'boom');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(/dropped update/), {
      timeout: 5000,
      interval: 20,
    });

    fake.injectUserMessage('-1009409999', 'mallory', 'refused');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(/dropped a message for chat/), {
      timeout: 5000,
      interval: 20,
    });
  }, 20_000);

  /**
   * The two reasons a store refuses a record are fixed by different operator actions — raise
   * `observed_max_chats` versus free the disk the compaction could not reopen the store on — so
   * the diagnostic has to name which one happened rather than always blaming the chat cap.
   */
  it.each([
    { name: 'the chat cap', open: true, cause: /maximum number of chats/ },
    { name: 'a store with no append descriptor', open: false, cause: /no append descriptor/ },
  ])('names $name as the reason a record was dropped', async ({ open, cause }) => {
    const fake = await startFake();
    const stderr = captureStderr();
    await connectTo(fake);
    vi.spyOn(ObservedStore.prototype, 'append').mockReturnValue(undefined);
    vi.spyOn(ObservedStore.prototype, 'isOpen').mockReturnValue(open);

    fake.injectUserMessage('-1009450001', 'alice', 'dropped');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(cause), { timeout: 8000, interval: 20 });
    expect(stderr.join('')).toContain('-1009450001');
  }, 20_000);
});

/**
 * The long poll is the ONLY ingestion path and it is shared: a connection that is accepted and
 * then never answered (idle NAT drop, hung proxy, half-written body) must not be able to park it
 * for the lifetime of the process. There is no second consumer to notice.
 */
describe('telegram poll watchdog', () => {
  it.each(['never-answer', 'half-body', 'close-mid-body'] as const)(
    'ingestion recovers after a %s stall',
    async (mode) => {
      const fake = await startFake();
      captureStderr();
      const plugin = await connectTo(fake);
      const chat = '-1009300001';
      const topic = asTopic(chat);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));

      const before = fake.callCount('getUpdates');
      fake.stallMethod('getUpdates', mode);
      await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBeGreaterThan(before), {
        timeout: 5000,
        interval: 20,
      });
      fake.stallMethod('getUpdates', undefined);
      fake.injectUserMessage(chat, 'alice', 'after-stall');

      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after-stall'), {
        timeout: 20_000,
        interval: 25,
      });
    },
    30_000,
  );
});

/**
 * `offset` is Telegram's acknowledgement protocol: a loop that never advances it re-reads the
 * whole retained backlog on every iteration, never parks in the long poll, and hammers the Bot
 * API until it is rate limited — while looking, from the outside, exactly like a healthy one.
 */
describe('telegram getUpdates acknowledgement', () => {
  it('confirms consumed updates and keeps polling proportional to time, not to messages', async () => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const chat = '-1009200001';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await plugin.subscribe(topic, (m) => live.push(m));

    for (let i = 0; i < 12; i++) fake.injectUserMessage(chat, 'alice', `m${i}`);
    await vi.waitFor(() => expect(live).toHaveLength(12), { timeout: 8000, interval: 10 });
    await vi.waitFor(() => expect(fake.retainedUpdates()).toBe(0), { timeout: 8000, interval: 20 });

    // One quiet long-poll period: a loop parked in the long poll spends a call or two, a loop
    // re-reading an unacknowledged backlog spends hundreds.
    const calls = fake.callCount('getUpdates');
    await new Promise((r) => setTimeout(r, 1200));
    expect(fake.callCount('getUpdates') - calls).toBeLessThanOrEqual(4);
  }, 20_000);
});

/**
 * Unguarded lifecycle transitions: a second `connect` used to leak the previous store's append
 * fd and start a SECOND getUpdates loop on a token that allows exactly one consumer.
 */
describe('telegram lifecycle', () => {
  const SEAM_CALLS = ['post', 'fetchRecent', 'subscribe', 'resolveIdentity'] as const;
  const invoke = (plugin: TelegramPlugin, call: (typeof SEAM_CALLS)[number]): Promise<unknown> => {
    const topic = asTopic('-1009100002');
    if (call === 'post') return plugin.post(topic, SENDER, 'x');
    if (call === 'fetchRecent') return plugin.fetchRecent({ topic });
    if (call === 'subscribe') return plugin.subscribe(topic, () => undefined);
    return plugin.resolveIdentity(SENDER);
  };

  it.each(SEAM_CALLS)('%s rejects before connect', async (call) => {
    await expect(invoke(new TelegramPlugin(), call)).rejects.toThrow(/not connected/);
  });

  it.each(SEAM_CALLS)('%s rejects after disconnect', async (call) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    await plugin.disconnect();
    await expect(invoke(plugin, call)).rejects.toThrow(/not connected/);
  });

  it('rejects a second connect and keeps exactly one poll loop', async () => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    await expect(
      plugin.connect({ token: fake.token, api_url: fake.url, store_path: storePath(), poll_timeout_s: 1 }),
    ).rejects.toThrow(/already connected/);

    const before = fake.callCount('getUpdates');
    await new Promise((r) => setTimeout(r, 1500));
    const spent = fake.callCount('getUpdates') - before;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(4);
  }, 20_000);

  it('disconnects idempotently and reconnects onto the same store', async () => {
    const fake = await startFake();
    const path = storePath();
    const plugin = new TelegramPlugin();
    const config = { token: fake.token, api_url: fake.url, store_path: path, poll_timeout_s: 1 };
    await plugin.connect(config);
    cleanups.push(() => plugin.disconnect());
    const topic = asTopic('-1009100003');
    await plugin.post(topic, SENDER, 'before');

    await plugin.disconnect();
    await expect(plugin.disconnect()).resolves.toBeUndefined();
    await plugin.connect(config);
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['before']);
  });
});

/**
 * A cursor this plugin never issued is a caller bug, and core feeds `nextCursor` straight back in
 * as `since`: swallowing it turns the topic permanently empty with no error anywhere. `bridge-
 * sqlite` rejects exactly this input — the house norm.
 */
describe('telegram malformed cursor', () => {
  const BAD = ['', 'abc', '1.5', '-1', 'NaN', '1e999', '0x10', ' 1', '1,2'];

  it.each(BAD)('rejects fetchRecent since=%j', async (since) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const topic = asTopic('-1009100001');
    await plugin.post(topic, SENDER, 'a');

    await expect(plugin.fetchRecent({ topic, since: since as never })).rejects.toThrow(
      /malformed cursor/,
    );
    await expect(
      plugin.fetchRecent({ topic, since: since as never, blockMs: 300 }),
    ).rejects.toThrow(/malformed cursor/);
  });

  it('accepts the zero cursor and a cursor it issued', async () => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const topic = asTopic('-1009100004');
    await plugin.post(topic, SENDER, 'a');
    const head = await plugin.fetchRecent({ topic, since: asCursor('0') });
    expect(head.messages.map((m) => m.content)).toEqual(['a']);
    await plugin.post(topic, SENDER, 'b');
    const tail = await plugin.fetchRecent({ topic, since: head.nextCursor });
    expect(tail.messages.map((m) => m.content)).toEqual(['b']);
  });
});

/**
 * `limit` means the same thing on both fetchRecent branches. `slice(-0)` is `slice(0)` — the
 * whole history — so an unnormalized limit inverts its own meaning at zero and drops leading
 * messages when negative. And on BOTH branches the cursor a caller is handed back must be at
 * least the one it came in with: a truncated (or empty) page that reports '0' sends the next
 * catch-up back to the beginning of the retained window, replaying everything.
 */
describe('telegram fetchRecent limit normalization', () => {
  const LIMITS = [0, 1, 2, -5, 1000, undefined];
  const POSTED = ['a', 'b', 'c', 'd', 'e', 'f'];

  it.each(LIMITS)('limit %s means the same with and without `since`', async (limit) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const empty = asTopic('-1009900002');
    const topic = asTopic('-1009900001');
    // An empty topic has no tail to report, on any limit.
    expect((await plugin.fetchRecent({ topic: empty, limit })).nextCursor).toBe('0');
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
    const topicTail = all.at(-1)!.cursor;
    // The since-less branch always reports the topic's tail: it has already returned the newest
    // messages there are, so nothing below the tail is left for a later catch-up to find.
    expect(head.nextCursor).toBe(topicTail);

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
    captureStderr();
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
