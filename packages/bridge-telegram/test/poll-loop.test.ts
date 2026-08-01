import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { ObservedStore } from '../src/store.js';
import {
  captureStderr,
  connectFresh,
  connectTo,
  SENDER,
  startFake,
  storePath,
} from './rig.js';

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
    await connectFresh(fake);

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
    await connectFresh(fake);

    await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBeGreaterThan(3), {
      timeout: 5000,
      interval: 20,
    });
    expect(stderr.filter((l) => l.includes('Internal Server Error'))).toHaveLength(1);
  });

  /**
   * The throttle is per failure CLASS, and these two classes are fixed by different operator
   * actions: a record the store REFUSED is permanent loss on the one backend with no history
   * endpoint, while a write that failed is held back unacknowledged and clears when the disk does.
   * An unrelated failure chattering in the same minute must not be able to swallow either
   * diagnostic — the refusal's, because it is the only notice of a lost message, and the hold's,
   * because it is the only notice that ingestion has stopped making progress.
   */
  it('throttles each failure kind independently', async () => {
    const fake = await startFake();
    const stderr = captureStderr();
    // Both configured chats are served, so a third chat has nothing unserved to displace.
    const plugin = await connectFresh(fake, {
      observed_max_chats: 2,
      chat_map: { a: '-1009400001', b: '-1009400002' },
    });
    await plugin.post(asTopic('a'), SENDER, 'seed-a');
    await plugin.post(asTopic('b'), SENDER, 'seed-b');

    vi.spyOn(ObservedStore.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    fake.injectUserMessage('-1009400001', 'alice', 'boom');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(/holding update/), {
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
    const plugin = await connectTo(fake, store);
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
      const plugin = await connectFresh(fake);
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
    const plugin = await connectFresh(fake, { poll_timeout_s: 40 });
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
    const plugin = await connectFresh(fake);
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
      const plugin = await connectFresh(fake, { poll_timeout_s: pollTimeoutS });
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
      const plugin = await connectFresh(fake, { poll_timeout_s: 1 });
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
