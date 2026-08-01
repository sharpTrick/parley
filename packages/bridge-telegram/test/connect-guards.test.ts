import { readFileSync } from 'node:fs';
import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, KNOWN_CHANNEL } from './fake-telegram.js';
import {
  captureStderr,
  connectFresh,
  connectTo,
  registerCleanup,
  SENDER,
  startFake,
  storePath,
} from './rig.js';

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

  /**
   * A numeric knob is a promise: `poll_timeout_s: 0` is Telegram's "short polling", which turns the
   * single ingestion loop into a request flood against the operator's token, a negative one kills
   * ingestion outright, and a retention bound of 0 used to become the built-in 10000 — the
   * opposite of what was asked, persisted to disk. Every knob × every out-of-domain value, so the
   * class cannot come back through whichever knob is added next.
   */
  const NUMERIC_KNOBS = [
    'poll_timeout_s',
    'observed_retention_per_chat',
    'observed_retention_per_topic',
    'observed_max_chats',
  ] as const;
  const OUT_OF_DOMAIN = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9];
  const KNOB_CELLS = NUMERIC_KNOBS.flatMap((key) =>
    OUT_OF_DOMAIN.map((value) => ({ key, value })),
  );

  it.each(KNOB_CELLS)('rejects connect on $key = $value, naming the key', async ({ key, value }) => {
    const fake = await startFake();
    const plugin = new TelegramPlugin();
    await expect(
      plugin.connect({
        token: fake.token,
        api_url: fake.url,
        store_path: storePath(),
        poll_timeout_s: 1,
        [key]: value,
      }),
    ).rejects.toThrow(new RegExp(`backend_config\\.${key}`));
    await plugin.disconnect();
  });

  it.each(NUMERIC_KNOBS)('accepts %s at the low end of its range', async (key) => {
    const fake = await startFake();
    await expect(connectFresh(fake, { [key]: 1 })).resolves.toBeDefined();
  });

  it('rejects connect when a chat_map entry names no reachable chat', async () => {
    const fake = await startFake();
    captureStderr();
    await expect(connectFresh(fake, { chat_map: { ops: 'not-a-chat-id' } })).rejects.toThrow(
      /not a Telegram chat id/,
    );
  });
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
    const plugin = await connectFresh(fake);
    await plugin.disconnect();
    await expect(invoke(plugin, call)).rejects.toThrow(/not connected/);
  });

  /**
   * The same guard one await later. Every seam call resolves its topic across an await, so a call
   * in flight when `disconnect()` lands resumes against a CLOSED store — realistic on shutdown,
   * with a `parley_fetch_recent` still open as the bridge tears down. `close()` clears the
   * per-chat index, so a fetchRecent that answers anyway reports a topic tail of zero and sends
   * the next session's catch-up back to the start of the retained window, and a post reaches
   * Telegram with nothing left to record it in.
   */
  it.each(SEAM_CALLS)('%s rejects when disconnect lands mid-call', async (call) => {
    const fake = await startFake();
    const plugin = await connectFresh(fake);
    const topic = asTopic('-1009100002');
    for (const c of ['a', 'b', 'c']) await plugin.post(topic, SENDER, c);
    const sentBefore = fake.sent.length;

    const inFlight = invoke(plugin, call);
    await plugin.disconnect();

    await expect(inFlight).rejects.toThrow(/not connected/);
    // A rejected post never reached Telegram, so nothing was sent that nothing can record.
    expect(fake.sent).toHaveLength(sentBefore);
  });

  /**
   * WHERE in the call the teardown lands is a second axis, and the halves are not equivalent. Before
   * the network call the message never left, so rejecting costs the caller nothing. AFTER it,
   * Telegram has the message and this bridge has no store to record it in — and an own post never
   * comes back via `getUpdates`, so unlike an inbound message it cannot be recovered on reconnect.
   * Resolving with a `backendMsgId` no store will ever hold is the one outcome nothing downstream
   * can detect: every cell therefore grades the call's outcome AND that nothing was accepted
   * upstream without either a local record or an error naming what is missing.
   */
  const SEND_CHAT = '-1009100005';
  const TEARDOWN_CELLS = [
    { call: 'post' as const, hold: 'getChat', topic: KNOWN_CHANNEL.username, accepted: false },
    { call: 'fetchRecent' as const, hold: 'getChat', topic: KNOWN_CHANNEL.username, accepted: false },
    { call: 'subscribe' as const, hold: 'getChat', topic: KNOWN_CHANNEL.username, accepted: false },
    { call: 'post' as const, hold: 'sendMessage', topic: SEND_CHAT, accepted: true },
  ];

  it.each(TEARDOWN_CELLS)(
    '$call rejects when disconnect lands inside $hold, upstream accepted: $accepted',
    async ({ call, hold, topic: t, accepted }) => {
      const fake = await startFake();
      const path = storePath();
      const config = { token: fake.token, api_url: fake.url, store_path: path, poll_timeout_s: 1 };
      const plugin = await connectTo(fake, path);
      const seeded = asTopic(SEND_CHAT);
      // Seeded on the numeric topic, whose resolution needs no network — so the hold below lands
      // where the cell asks for it and not on a resolution this seed already paid for.
      await plugin.post(seeded, SENDER, 'seed');
      const topic = asTopic(t);
      const sentBefore = fake.sent.length;
      const holdCount = fake.callCount(hold);

      const held = fake.holdMethod(hold);
      const inFlight =
        call === 'post'
          ? plugin.post(topic, SENDER, 'lost?')
          : call === 'fetchRecent'
            ? plugin.fetchRecent({ topic })
            : plugin.subscribe(topic, () => undefined);
      await vi.waitFor(() => expect(fake.callCount(hold)).toBeGreaterThan(holdCount), {
        timeout: 3000,
        interval: 5,
      });
      await plugin.disconnect();
      held.release();

      const err = await inFlight.then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/not connected/);
      expect(fake.sent).toHaveLength(sentBefore + (accepted ? 1 : 0));
      if (accepted) {
        // Telegram has it: the error has to name the `<chat>:<mid>` that exists upstream and is
        // missing locally, or the caller cannot tell this from a message that never left.
        expect(fake.sent.at(-1)?.text).toBe('lost?');
        expect(err?.message).toContain(`${SEND_CHAT}:2`);
        expect(err?.message).toContain(path);
      }
      // Either way the store never gained a record for it, and a reconnect does not invent one.
      expect(readFileSync(path, 'utf8')).not.toContain('lost?');
      const restarted = new TelegramPlugin();
      await plugin.disconnect();
      await restarted.connect(config);
      const page = await restarted.fetchRecent({ topic: seeded, limit: 100 });
      expect(page.messages.map((m) => m.content)).toEqual(['seed']);
      await restarted.disconnect();
    },
    20_000,
  );

  it('rejects a second connect and keeps exactly one poll loop', async () => {
    const fake = await startFake();
    const plugin = await connectFresh(fake);
    await expect(
      plugin.connect({ token: fake.token, api_url: fake.url, store_path: storePath(), poll_timeout_s: 1 }),
    ).rejects.toThrow(/already connected/);

    const before = fake.callCount('getUpdates');
    await new Promise((r) => setTimeout(r, 1500));
    const spent = fake.callCount('getUpdates') - before;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(4);
  }, 20_000);

  /**
   * The README's "one file per process, and this is enforced", at the seam that enforces it. Two
   * bridges on one store file is the shape nothing downstream can detect — they hand the same
   * cursor to two different messages and each compaction renames its own view over the other's
   * history — so the second one has to fail `connect` rather than come up. It must also leave the
   * FIRST one untouched, and take the file over once that one disconnects.
   */
  it('refuses to connect a second bridge onto a store file another one holds', async () => {
    const fake = await startFake();
    const path = storePath();
    const config = { token: fake.token, api_url: fake.url, store_path: path, poll_timeout_s: 1 };
    const first = await connectTo(fake, path);
    const topic = asTopic('-1009100004');
    await first.post(topic, SENDER, 'mine');

    const second = new TelegramPlugin();
    await expect(second.connect(config)).rejects.toThrow(
      new RegExp(`already claimed by process ${process.pid}`),
    );
    await expect(second.connect(config)).rejects.toThrow(path);
    // The holder is unharmed, and the refused bridge answers as unconnected rather than half-up.
    expect((await first.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['mine']);
    await expect(second.fetchRecent({ topic })).rejects.toThrow(/not connected/);

    await first.disconnect();
    await second.connect(config);
    registerCleanup(() => second.disconnect());
    expect((await second.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['mine']);
  }, 20_000);

  it('disconnects idempotently and reconnects onto the same store', async () => {
    const fake = await startFake();
    const path = storePath();
    const config = { token: fake.token, api_url: fake.url, store_path: path, poll_timeout_s: 1 };
    const plugin = await connectTo(fake, path);
    const topic = asTopic('-1009100003');
    await plugin.post(topic, SENDER, 'before');

    await plugin.disconnect();
    await expect(plugin.disconnect()).resolves.toBeUndefined();
    await plugin.connect(config);
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['before']);
  });
});
