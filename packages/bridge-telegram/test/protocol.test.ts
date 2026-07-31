import { readFileSync } from 'node:fs';
import { asBackendMsgId, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import {
  captureStderr,
  connectTo as connectPlugin,
  registerCleanup,
  seqOf,
  startFake,
  startRig,
  storePath,
} from './rig.js';
import { ObservedStore } from '../src/store.js';
import { type FakeTelegram, KNOWN_CHANNEL } from './fake-telegram.js';

const SENDER = asHandle('me');

const connectTo = (fake: FakeTelegram, extra: Record<string, unknown> = {}): Promise<TelegramPlugin> =>
  connectPlugin(fake, storePath(), extra);

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
    await expect(connectTo(fake, { [key]: 1 })).resolves.toBeDefined();
  });

  it('rejects connect when a chat_map entry names no reachable chat', async () => {
    const fake = await startFake();
    captureStderr();
    await expect(connectTo(fake, { chat_map: { ops: 'not-a-chat-id' } })).rejects.toThrow(
      /not a Telegram chat id/,
    );
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
   *
   * The second axis is WHO can act on it. An inbound update has no caller, so the throttled stderr
   * line is all there is. `post` has one: resolving with a `backendMsgId` the store never took hands
   * back an id no `fetchRecent` will ever return and no reconnect can recover (own posts never come
   * back via `getUpdates`) — a silent, permanent loss on the one path where the caller is still
   * there to be told. The plugin already refuses that outcome when a teardown causes it; the cause
   * cannot be what decides.
   */
  const REFUSAL_CAUSES = [
    { name: 'the chat cap', open: true, cause: /maximum number of chats/ },
    { name: 'a store with no append descriptor', open: false, cause: /no append descriptor/ },
  ];
  const REFUSAL_CELLS = REFUSAL_CAUSES.flatMap((refusal) =>
    (['an inbound update', 'an own post'] as const).map((path) => ({ ...refusal, path })),
  );

  it.each(REFUSAL_CELLS)('names $name as the reason $path was dropped', async ({ open, cause, path }) => {
    const fake = await startFake();
    const stderr = captureStderr();
    const store = storePath();
    const plugin = await connectPlugin(fake, store);
    const chat = '-1009450001';
    vi.spyOn(ObservedStore.prototype, 'append').mockReturnValue(undefined);
    vi.spyOn(ObservedStore.prototype, 'isOpen').mockReturnValue(open);

    if (path === 'an inbound update') {
      fake.injectUserMessage(chat, 'alice', 'dropped');
      await vi.waitFor(() => expect(stderr.join('')).toMatch(cause), { timeout: 8000, interval: 20 });
      expect(stderr.join('')).toContain(chat);
      return;
    }
    const err = await plugin.post(asTopic(chat), SENDER, 'dropped').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    // Telegram accepted it, so the rejection has to name what exists upstream and where it is
    // missing — the caller cannot otherwise tell this from a message that never left.
    expect(fake.sent.at(-1)?.text).toBe('dropped');
    expect(err?.message).toContain(`${chat}:1`);
    expect(err?.message).toContain(store);
    expect((await plugin.fetchRecent({ topic: asTopic(chat), limit: 100 })).messages).toEqual([]);
  }, 20_000);
});

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
      const plugin = await connectTo(fake);
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

  /**
   * The other side of the same budget. `pollBudgetMs()` (the long poll plus 40% slack) is the only
   * number that may abandon a poll — a shared per-call default the plugin does not override
   * instead cuts every HEALTHY long poll past `poll_timeout_s: 30`, turning the sole ingestion path
   * into an abort-and-retry loop whose only symptom is one throttled stderr line a minute.
   *
   * Telegram accepts a `getUpdates` timeout up to 50s and most bot frameworks default to 30–50, so
   * this has to hold past any shared default; proving it costs the wall-clock it claims.
   */
  it('does not abandon a healthy long poll at a shared per-call default', async () => {
    const fake = await startFake();
    const stderr = captureStderr();
    const plugin = await connectTo(fake, { poll_timeout_s: 40 });
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(1), { timeout: 5000, interval: 20 });

    await new Promise((r) => setTimeout(r, 32_000));

    expect(stderr.join('')).not.toMatch(/deadline|timed out/);
    expect(fake.callCount('getUpdates')).toBe(1);
    expect(fake.parkedPolls()).toBe(1);
    const chat = '-1009300002';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await plugin.subscribe(topic, (m) => live.push(m));
    fake.injectUserMessage(chat, 'alice', 'after the default deadline');
    await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after the default deadline'), {
      timeout: 5000,
      interval: 20,
    });
  }, 60_000);
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

  /**
   * The cadence must not depend on the upstream behaving. It is a property of the LOOP — "this
   * iteration acknowledged nothing, so wait" — never of the answer's shape: a floor that only reads
   * `updates.length === 0` is skipped entirely by an upstream that answers instantly with a batch it
   * never retires, which spins the single ingestion loop at the speed of the network against the
   * operator's bot token. That is a flood wait or a ban, and every record in the batch dedups, so
   * there is no message loss to notice it by. One row per way a poll can come back without progress.
   */
  const MISBEHAVIOURS = [
    { name: 'the long poll is ignored', longPoll: true, offset: false, seed: false },
    { name: 'offset is ignored', longPoll: false, offset: true, seed: true },
    { name: 'an already-consumed batch is re-served', longPoll: true, offset: true, seed: true },
    { name: 'only non-message updates arrive', longPoll: true, offset: false, seed: false, kind: 'edited' },
  ];
  const CADENCE_CELLS = [1, 25, 50].flatMap((pollTimeoutS) =>
    MISBEHAVIOURS.map((misbehaviour) => ({ pollTimeoutS, misbehaviour })),
  );

  it.each(CADENCE_CELLS)(
    'stays below a handful of polls a second at poll_timeout_s $pollTimeoutS when $misbehaviour.name',
    async ({ pollTimeoutS, misbehaviour }) => {
      const fake = await startFake();
      const plugin = await connectTo(fake, { poll_timeout_s: pollTimeoutS });
      const chat = '-1009200002';
      const topic = asTopic(chat);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      // Arm the misbehaviour BEFORE seeding: an upstream that still honours `offset` deletes the
      // batch as soon as the loop reads it, and there is then nothing left for it to re-serve.
      fake.ignoreLongPoll(misbehaviour.longPoll);
      fake.ignoreOffset(misbehaviour.offset);
      if (misbehaviour.seed) {
        fake.injectUserMessage(chat, 'alice', 'seed');
        await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('seed'), {
          timeout: 5000,
          interval: 10,
        });
      }
      if (misbehaviour.kind === 'edited') {
        for (let i = 0; i < 5; i++) fake.injectRawUpdate({ edited_message: { message_id: i } });
      }

      const calls = fake.callCount('getUpdates');
      await new Promise((r) => setTimeout(r, 1000));
      const spent = fake.callCount('getUpdates') - calls;
      expect(spent).toBeLessThanOrEqual(8);
      // Throttled, never stalled: the loop is still polling, and a message still arrives promptly.
      expect(spent).toBeGreaterThan(0);
      fake.injectUserMessage(chat, 'alice', 'still flowing');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('still flowing'), {
        timeout: 5000,
        interval: 10,
      });
    },
    20_000,
  );

  /**
   * The upstream-conformance axis of the same cadence property. `offset` is the only acknowledgement
   * this protocol has and its sole input is `update_id` — a field a rewriting middlebox or a
   * non-conforming local Bot API server supplies. A value the arithmetic is not defined on poisons
   * the offset in one of two silent directions: NaN is below everything, so the loop re-reads one
   * backlog forever and never sees another message, while a value past the safe-integer range is
   * above everything, so the loop acknowledges updates that never arrived and goes deaf to every
   * one that follows. Neither loses a message loudly — every re-serve dedups — so the offset the
   * loop puts ON THE WIRE is where it is visible at all.
   *
   * NaN and Infinity are not rows: `JSON.stringify` writes both as `null`, so the null row IS their
   * spelling on the wire.
   */
  const NON_CONFORMING_IDS = [
    { name: 'no update_id at all', update: {} },
    { name: 'a null update_id', update: { update_id: null } },
    { name: 'a string update_id', update: { update_id: 'seventeen' } },
    { name: 'a fractional update_id', update: { update_id: 1.5 } },
    { name: 'an update_id past the safe-integer range', update: { update_id: 1e21 } },
    { name: 'a negative update_id', update: { update_id: -5 } },
  ];

  const CARRIER_CHAT = '-1009200003';

  it.each(NON_CONFORMING_IDS)(
    'keeps acknowledging, ingesting and pacing when an update arrives with $name',
    async ({ update }) => {
      const fake = await startFake();
      const plugin = await connectTo(fake, { poll_timeout_s: 1 });
      const topic = asTopic(CARRIER_CHAT);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));

      fake.injectMalformedUpdate({
        ...update,
        message: {
          message_id: 777,
          date: 1_600_000_000,
          chat: { id: Number(CARRIER_CHAT) },
          from: { id: 5, is_bot: false, username: 'alice' },
          text: 'carried by a non-conforming update',
        },
      });
      // A conforming update behind it: acknowledging THIS one is what the poisoned offset would
      // have taken down with it.
      fake.injectUserMessage(CARRIER_CHAT, 'alice', 'sentinel');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('sentinel'), {
        timeout: 8000,
        interval: 20,
      });

      // The message the non-conforming update carried is ingested — exactly once, however many
      // times an upstream that cannot order it re-serves it.
      expect(live.filter((m) => m.content === 'carried by a non-conforming update')).toHaveLength(1);

      const before = fake.callCount('getUpdates');
      await new Promise((r) => setTimeout(r, 1000));
      expect(fake.callCount('getUpdates') - before).toBeLessThanOrEqual(8);
      // Every offset the loop put on the wire over that second stayed a plain non-negative integer,
      // and advanced: `NaN`, `2.5` and `1e+21` are each a loop that has silently stopped
      // acknowledging — deaf from here on, with no lost message to notice it by.
      const offsets = fake.pollOffsets();
      for (const offset of offsets) expect(offset).toMatch(/^\d+$/);
      expect(Math.max(...offsets.map(Number))).toBeGreaterThan(0);
    },
    20_000,
  );
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
    const plugin = await connectTo(fake);
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
      const plugin = await connectPlugin(fake, path);
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
    const first = await connectPlugin(fake, path);
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
    const plugin = await connectPlugin(fake, path);
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
describe('telegram cursor grammar', () => {
  type Verdict = 'serves' | 'malformed' | 'unqualified' | 'foreign' | 'ahead';

  /** How each rejection announces itself; `serves` is the absence of one. */
  const VERDICTS: Record<Exclude<Verdict, 'serves'>, RegExp> = {
    malformed: /malformed cursor/,
    unqualified: /carries no store identity/,
    foreign: /issued by a different observed-message store/,
    ahead: /ahead of every message this store has observed/,
  };

  const POSTED = ['a', 'b', 'c'];

  interface Row {
    since: string;
    verdict: Verdict;
    /** The observation sequence a SERVED cursor names — everything above it is the page. */
    seq?: number;
  }

  /**
   * The whole grammar `requireOwnCursor` implements, straddling every branch's boundary. The table
   * used to hold only its syntactically-broken half — every row failed the bare-digit and the
   * qualified pattern alike — so the branch that refuses an unqualified NON-ZERO sequence had no
   * coverage anywhere in the package: replacing it with `return Number(raw)` left the suite green
   * while `since: '3'` was answered out of a sequence space unrelated to the one that minted it,
   * and every message below it became unreachable with no error anywhere. That is the permanently
   * short page `cursor-lifecycle.test.ts` exists to make impossible, through the one door it left
   * open.
   */
  const spellings = (epoch: string): Row[] => {
    const other = epoch === 'a'.repeat(16) ? 'b'.repeat(16) : 'a'.repeat(16);
    return [
      // Nothing the grammar can read at all.
      { since: '', verdict: 'malformed' },
      { since: 'abc', verdict: 'malformed' },
      { since: '1.5', verdict: 'malformed' },
      { since: '-1', verdict: 'malformed' },
      { since: 'NaN', verdict: 'malformed' },
      { since: '1e999', verdict: 'malformed' },
      { since: '0x10', verdict: 'malformed' },
      { since: ' 1', verdict: 'malformed' },
      { since: '1 ', verdict: 'malformed' },
      { since: '1,2', verdict: 'malformed' },
      // Qualified in shape but not in this grammar: an identity of the wrong width or case, a
      // missing half, a third component, a negative sequence.
      { since: `${epoch}.`, verdict: 'malformed' },
      { since: '.1', verdict: 'malformed' },
      { since: `${epoch}.1.2`, verdict: 'malformed' },
      { since: `${epoch}.-1`, verdict: 'malformed' },
      { since: `${epoch.toUpperCase()}.1`, verdict: 'malformed' },
      { since: `${epoch.slice(0, 15)}.1`, verdict: 'malformed' },
      { since: `${epoch}0.1`, verdict: 'malformed' },
      // Unqualified: '0' names the start of the retained window whatever store reads it, and every
      // other bare sequence names a sequence space nothing can identify.
      { since: '0', verdict: 'serves', seq: 0 },
      { since: '00', verdict: 'serves', seq: 0 },
      { since: '0000000000', verdict: 'serves', seq: 0 },
      { since: '1', verdict: 'unqualified' },
      { since: '2', verdict: 'unqualified' },
      { since: String(POSTED.length), verdict: 'unqualified' },
      { since: '999', verdict: 'unqualified' },
      // Qualified by a store file this one did not inherit.
      { since: `${other}.1`, verdict: 'foreign' },
      { since: `${other}.999`, verdict: 'foreign' },
      // Qualified by this one, on both sides of its high-water mark.
      { since: `${epoch}.0`, verdict: 'serves', seq: 0 },
      { since: `${epoch}.1`, verdict: 'serves', seq: 1 },
      { since: `${epoch}.000000001`, verdict: 'serves', seq: 1 },
      { since: `${epoch}.${POSTED.length}`, verdict: 'serves', seq: POSTED.length },
      { since: `${epoch}.${POSTED.length + 1}`, verdict: 'ahead' },
      { since: `${epoch}.999`, verdict: 'ahead' },
    ];
  };

  const verdictOf = (answer: unknown): string => {
    if (!(answer instanceof Error)) return 'serves';
    for (const [name, pattern] of Object.entries(VERDICTS)) {
      if (pattern.test(answer.message)) return name;
    }
    return `unrecognized rejection: ${answer.message}`;
  };

  it('gives every cursor spelling the verdict its grammar states', async () => {
    const rig = await startRig();
    const topic = asTopic('-1009100001');
    for (const c of POSTED) await rig.plugin.post(topic, SENDER, c);
    const issued = (await rig.plugin.fetchRecent({ topic })).nextCursor as string;
    const epoch = issued.split('.')[0] ?? '';
    expect(epoch).toMatch(/^[0-9a-f]{16}$/);
    const rows = spellings(epoch);
    // A table that lost a branch's rows would pass vacuously: every verdict must be exercised.
    expect(new Set(rows.map((r) => r.verdict))).toEqual(
      new Set<Verdict>(['serves', 'malformed', 'unqualified', 'foreign', 'ahead']),
    );

    const graded = [];
    for (const row of rows) {
      const answer = await rig.plugin
        .fetchRecent({ topic, since: row.since as never, limit: 100 })
        .then(
          (page) => page,
          (err: unknown) => err as Error,
        );
      // A blocking call must reach the SAME verdict — never park past a cursor it should have
      // refused and then answer out of an unrelated sequence space.
      const blocking =
        row.verdict === 'serves'
          ? undefined
          : verdictOf(
              await rig.plugin
                .fetchRecent({ topic, since: row.since as never, limit: 100, blockMs: 300 })
                .then(
                  (page) => page,
                  (err: unknown) => err as Error,
                ),
            );
      graded.push({
        since: row.since,
        verdict: verdictOf(answer),
        blocking,
        page: answer instanceof Error ? undefined : answer.messages.map((m) => m.content),
      });
    }

    expect(graded).toEqual(
      rows.map((row) => ({
        since: row.since,
        verdict: row.verdict,
        blocking: row.verdict === 'serves' ? undefined : row.verdict,
        page: row.seq === undefined ? undefined : POSTED.slice(row.seq),
      })),
    );
  }, 30_000);
});

/**
 * `limit` means the same thing on both fetchRecent branches. `slice(-0)` is `slice(0)` — the
 * whole history — so an unnormalized limit inverts its own meaning at zero and drops leading
 * messages when negative. And on BOTH branches the cursor a caller is handed back must be at
 * least the one it came in with: a truncated (or empty) page that reports '0' sends the next
 * catch-up back to the beginning of the retained window, replaying everything.
 */
describe('telegram fetchRecent limit normalization', () => {
  const LIMITS = [0, 1, 2, -5, 1.5, 1000, undefined];
  const POSTED = ['a', 'b', 'c', 'd', 'e', 'f'];

  it.each(LIMITS)('limit %s means the same with and without `since`', async (limit) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const empty = asTopic('-1009900002');
    const topic = asTopic('-1009900001');
    // An empty topic has no tail to report, on any limit.
    expect(seqOf((await plugin.fetchRecent({ topic: empty, limit })).nextCursor)).toBe(0);
    for (const c of POSTED) await plugin.post(topic, SENDER, c);

    const cap = (n: number): number =>
      limit === undefined ? n : Math.max(0, Math.min(Math.floor(limit), n));
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
    expect(seqOf(tail.nextCursor)).toBeGreaterThanOrEqual(seqOf(since));
  });

  /**
   * `limit` and `blockMs` are independent knobs, and the decision to PARK belongs to the second one
   * alone: whether anything sits above `since`, never how many rows the first one let through. A
   * gate that reads the sliced page instead parks a call the store could answer immediately — at
   * `limit: 0` it blocks for the whole `blockMs` on a topic full of messages and then returns
   * nothing, which is the plugin's advertised native long-poll doing the opposite of its job.
   *
   * The product is what grades it: the limit table never passed `blockMs`, and the blocking cases
   * never varied `limit`, so no cell of it was covered.
   */
  it.each(LIMITS)(
    'limit %s parks only when nothing is newer',
    async (limit) => {
      const fake = await startFake();
      const plugin = await connectTo(fake);
      const topic = asTopic('-1009900003');
      await plugin.post(topic, SENDER, 'a');
      const head = (await plugin.fetchRecent({ topic, limit: 100 })).nextCursor;
      await plugin.post(topic, SENDER, 'b');
      await plugin.post(topic, SENDER, 'c');

      // Something IS newer than `head`: the call must not park, whatever the limit does to the page.
      const started = Date.now();
      const served = await plugin.fetchRecent({ topic, since: head, limit, blockMs: 400 });
      expect(Date.now() - started).toBeLessThan(200);
      const expected = ['b', 'c'].slice(0, limit === undefined ? 2 : Math.max(0, Math.floor(limit)));
      expect(served.messages.map((m) => m.content)).toEqual(expected);
      // An empty page never moves the caller backwards, so the next catch-up still finds b and c.
      expect(seqOf(served.nextCursor)).toBeGreaterThanOrEqual(seqOf(head));
      const next = await plugin.fetchRecent({ topic, since: served.nextCursor, limit: 100 });
      expect([...served.messages, ...next.messages].map((m) => m.content)).toEqual(['b', 'c']);

      // Nothing newer than the tail: NOW it must wait, and come back with a stable cursor.
      const tail = (await plugin.fetchRecent({ topic, limit: 100 })).nextCursor;
      const idleStarted = Date.now();
      const idle = await plugin.fetchRecent({ topic, since: tail, limit, blockMs: 400 });
      expect(Date.now() - idleStarted).toBeGreaterThanOrEqual(350);
      expect(idle.messages).toEqual([]);
      expect(idle.nextCursor).toBe(tail);
    },
    20_000,
  );

  /**
   * `blockMs` is the caller's own budget, so the park must be measured AGAINST IT and not merely be
   * "some wait". This axis used to ride on the limit table as `[400, 5000]`, where the only
   * assertion it reached was `elapsed < Math.min(blockMs / 2, 200)` — 200 for both values — while
   * the half of the case that actually parks hardcoded 400. The two rows were exact behavioural
   * duplicates: six cases that could not fail independently, and a `blockMs` axis that was counted
   * as covered and was not. Both bounds here are derived FROM the row, so a park that collapsed to
   * a constant would fail one row or the other.
   */
  it.each([300, 1200])('parks for its own blockMs budget of %i and no longer', async (blockMs) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const topic = asTopic('-1009900004');
    await plugin.post(topic, SENDER, 'a');
    const tail = (await plugin.fetchRecent({ topic, limit: 100 })).nextCursor;

    const started = Date.now();
    const idle = await plugin.fetchRecent({ topic, since: tail, limit: 100, blockMs });
    const elapsed = Date.now() - started;
    expect(idle.messages).toEqual([]);
    expect(idle.nextCursor).toBe(tail);
    expect(elapsed).toBeGreaterThanOrEqual(blockMs * 0.85);
    expect(elapsed).toBeLessThan(blockMs * 2);
  }, 20_000);
});

/**
 * A page size outside the domain `fetchRecent` slices with is refused, not silently reinterpreted.
 * `slice(NaN)` is the whole retained window and `slice(0, NaN)` is empty, so one un-normalized
 * value means the OPPOSITE thing on either side of `since`: an unbounded page on the default
 * branch and a topic that looks permanently drained on the catch-up branch, with a stable cursor
 * and no error anywhere. Every other numeric input this package takes is domain-checked; the page
 * size is one of them, and `FetchRecentArgs.limit` is a published seam type that callers other than
 * core's zod-validated tool reach.
 */
describe('telegram fetchRecent limit domain', () => {
  const REFUSED = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it.each(REFUSED)('refuses limit %s identically on both branches', async (limit) => {
    const fake = await startFake();
    const plugin = await connectTo(fake);
    const topic = asTopic('-1009900005');
    for (const c of ['a', 'b', 'c']) await plugin.post(topic, SENDER, c);
    const head = (await plugin.fetchRecent({ topic, limit: 100 })).messages[0]?.cursor;

    const refusal = /limit must be a finite number/;
    await expect(plugin.fetchRecent({ topic, limit })).rejects.toThrow(refusal);
    await expect(plugin.fetchRecent({ topic, since: head, limit })).rejects.toThrow(refusal);
    // Blocking too: a refused limit must never park first and then answer out of the same hole.
    const started = Date.now();
    await expect(
      plugin.fetchRecent({ topic, since: head, limit, blockMs: 2000 }),
    ).rejects.toThrow(refusal);
    expect(Date.now() - started).toBeLessThan(500);
    // And the topic is untouched by the refusal.
    expect((await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content)).toEqual(
      ['a', 'b', 'c'],
    );
  }, 20_000);
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
