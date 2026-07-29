/**
 * A blocking `fetchRecent` must wake from whatever primitive is available at that moment — a live
 * subscribe loop's queue when one is draining the topic, its own short-lived queue when not, and a
 * paced retry when the server offers no push at all. The table walks every state a subscription can
 * be in while a caller is blocked on the same topic; the class it guards is that NONE of them
 * silently costs the caller its whole budget.
 */
import { asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import type { FakeZulip } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip, type ZulipPair } from './harness.js';

const boot = useZulip();

const BLOCK_MS = 4000;
/** A wake that lands inside this is a wake; anything slower is the budget expiring. */
const PROMPT_MS = BLOCK_MS / 4;
const REGISTER = 'POST /api/v1/register';

interface LoopState {
  name: string;
  prepare: (pair: ZulipPair, topic: string) => Promise<void>;
  /** True when a live loop's queue must carry the wake — no second queue may be opened. */
  reusesTheLoopQueue: boolean;
}

const LOOP_STATES: LoopState[] = [
  {
    name: 'no subscription at all',
    prepare: async () => undefined,
    reusesTheLoopQueue: false,
  },
  {
    name: 'one healthy subscribe loop',
    prepare: async ({ plugin }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
    },
    reusesTheLoopQueue: true,
  },
  {
    name: 'two healthy subscribe loops on the same topic',
    prepare: async ({ plugin }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      await plugin.subscribe(asTopic(topic), () => undefined);
    },
    reusesTheLoopQueue: true,
  },
  {
    name: 'a loop parked in failure backoff (500 on /events)',
    prepare: async ({ plugin, fake }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      fake.failRoute('GET /api/v1/events', { status: 500 });
      await sleep(600);
    },
    reusesTheLoopQueue: false,
  },
  {
    name: 'a loop taking a non-queue 400 on /events',
    prepare: async ({ plugin, fake }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      fake.failRoute('GET /api/v1/events', {
        status: 400,
        body: { result: 'error', code: 'BAD_REQUEST', msg: 'nope' },
      });
      await sleep(600);
    },
    reusesTheLoopQueue: false,
  },
  {
    name: 'a loop whose queue was GCd, re-registering and gap-filling',
    prepare: async ({ plugin, fake }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      fake.gcQueues();
    },
    reusesTheLoopQueue: false,
  },
  {
    name: 'a loop that never started because register keeps failing',
    prepare: async ({ plugin, fake }, topic) => {
      fake.failRoute(REGISTER, { status: 500 });
      await expect(plugin.subscribe(asTopic(topic), () => undefined)).rejects.toThrow();
      await sleep(50);
      fake.clearRouteFailures();
    },
    reusesTheLoopQueue: false,
  },
  {
    name: 'no queue can be opened at all (register is 500 throughout)',
    prepare: async ({ fake }) => {
      fake.failRoute(REGISTER, { status: 500 });
    },
    reusesTheLoopQueue: false,
  },
];

describe('zulip blocking fetchRecent wakes promptly whatever state the subscribe loop is in', () => {
  for (const state of LOOP_STATES) {
    it(`wakes within ${PROMPT_MS}ms of a concurrent post with ${state.name}`, async () => {
      const pair = await boot();
      const { plugin, fake } = pair;
      const topic = asTopic(`wake-${rand()}`);
      await plugin.post(topic, SENDER, 'old');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
      await state.prepare(pair, topic);

      const queuesBefore = fake.requestCount(REGISTER);
      const started = Date.now();
      const late = setTimeout(() => void plugin.post(topic, SENDER, 'late'), 100);
      const res = await plugin.fetchRecent({ topic, since: tail, blockMs: BLOCK_MS });
      clearTimeout(late);

      expect(res.messages.map((m) => m.content)).toEqual(['late']);
      expect(res.nextCursor).not.toBe(tail);
      expect(Date.now() - started).toBeLessThan(PROMPT_MS);
      if (state.reusesTheLoopQueue) {
        expect(fake.requestCount(REGISTER) - queuesBefore).toBe(0);
      }
    });
  }

  it('arms the piggyback wake BEFORE re-reading history, so a wake in that window is not lost', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`arm-${rand()}`);
    await plugin.post(topic, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
    await plugin.subscribe(topic, () => undefined);

    // Every history answer is now computed on request and delivered 250ms later, so the message
    // injected mid-flight lands after the re-check's snapshot: only a wake can end this wait.
    fake.holdResponse('GET /api/v1/messages', 250);
    const started = Date.now();
    const injected = setTimeout(() => fake.injectMessage({ topic, content: 'late' }), 350);
    const res = await plugin.fetchRecent({ topic, since: tail, blockMs: BLOCK_MS });
    clearTimeout(injected);

    expect(res.messages.map((m) => m.content)).toEqual(['late']);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  const DISCONNECT_MODES = [
    { name: 'piggybacking on a live loop', subscribe: true },
    { name: 'on its own dedicated queue', subscribe: false },
  ];
  for (const mode of DISCONNECT_MODES) {
    it(`releases a blocked fetch ${mode.name} when disconnect lands mid-wait`, async () => {
      const { plugin } = await boot();
      const topic = asTopic(`cut-${rand()}`);
      await plugin.post(topic, SENDER, 'old');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
      if (mode.subscribe) await plugin.subscribe(topic, () => undefined);

      const started = Date.now();
      const pending = plugin.fetchRecent({ topic, since: tail, blockMs: BLOCK_MS });
      await sleep(150);
      await plugin.disconnect();
      const res = await pending;

      expect(res.messages).toEqual([]);
      expect(res.nextCursor).toBe(tail);
      expect(Date.now() - started).toBeLessThan(PROMPT_MS);
    });
  }

  it('does not spin when the server rejects every event queue it is handed', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`spin-${rand()}`);
    await plugin.post(topic, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
    // A rejected queue ANSWERS rather than blocking, so an unpaced retry loop runs flat out.
    fake.failRoute('GET /api/v1/events', {
      status: 400,
      body: { result: 'error', code: 'BAD_EVENT_QUEUE_ID', msg: 'gone' },
    });

    const started = Date.now();
    const res = await plugin.fetchRecent({ topic, since: tail, blockMs: 1200 });

    expect(res.messages).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(fake.requestCount(REGISTER)).toBeLessThan(10);
  });

  it('a topic with no live loop still waits out its budget rather than returning instantly', async () => {
    const { plugin } = await boot();
    const topic = asTopic(`idle-${rand()}`);
    await plugin.post(topic, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;

    const started = Date.now();
    const res = await plugin.fetchRecent({ topic, since: tail, blockMs: 600 });
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });
});

/**
 * `blockMs` is a CEILING, not a hint: DESIGN §11 sizes `catchup.block_max_ms` under the client tool
 * timeout, so anything the plugin does on the caller's thread after the wait — registering the
 * queue it is about to wait on, dropping it afterwards — has to live inside the budget too. The
 * table crosses budgets with the server states that make each of those steps slow.
 */
describe('zulip blocking fetchRecent never overruns its blockMs', () => {
  /** Scheduling, the history re-read, and the fake's own round trips. */
  const SLACK_MS = 700;

  const SLOW_STATES = [
    { name: 'a responsive server', apply: () => undefined },
    {
      name: 'DELETE /events answering 500',
      apply: (fake: FakeZulip) => fake.failRoute('DELETE /api/v1/events', { status: 500 }),
    },
    {
      name: 'DELETE /events a black hole',
      apply: (fake: FakeZulip) => fake.hangRoute('DELETE /api/v1/events'),
    },
    {
      name: 'DELETE /events slower than the whole budget',
      apply: (fake: FakeZulip) => fake.holdResponse('DELETE /api/v1/events', 4000),
    },
    {
      name: 'register a black hole',
      apply: (fake: FakeZulip) => fake.hangRoute(REGISTER),
    },
    {
      name: 'register slower than the whole budget',
      apply: (fake: FakeZulip) => fake.holdResponse(REGISTER, 4000),
    },
    {
      name: '/events slower than the whole budget',
      apply: (fake: FakeZulip) => fake.holdResponse('GET /api/v1/events', 4000),
    },
  ];

  for (const state of SLOW_STATES) {
    for (const blockMs of [200, 600, 2000]) {
      it(`returns within ${blockMs}ms (+slack) with ${state.name}`, async () => {
        const { plugin, fake } = await boot();
        const topic = asTopic(`ceil-${rand()}`);
        await plugin.post(topic, SENDER, 'old');
        const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
        state.apply(fake);

        const started = Date.now();
        const res = await plugin.fetchRecent({ topic, since: tail, blockMs });
        const elapsed = Date.now() - started;

        expect(res.messages).toEqual([]);
        expect(elapsed).toBeLessThanOrEqual(blockMs + SLACK_MS);
      });
    }
  }
});

/** The wake must survive the loop losing, and regaining, its ability to deliver. */
describe('zulip blocking fetchRecent tracks a loop degrading and recovering', () => {
  const DEGRADE_THEN = [
    { name: 'stays down', repair: (_fake: FakeZulip) => undefined },
    { name: 'recovers first', repair: (fake: FakeZulip) => fake.clearRouteFailures() },
  ];
  for (const mode of DEGRADE_THEN) {
    it(`wakes when the loop ${mode.name}`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`degrade-${rand()}`);
      await plugin.post(topic, SENDER, 'old');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
      await plugin.subscribe(topic, () => undefined);

      const started = Date.now();
      // The loop is healthy when the wait is armed and breaks immediately afterwards.
      const broke = setTimeout(() => fake.failRoute('GET /api/v1/events', { status: 500 }), 30);
      const repaired = setTimeout(() => mode.repair(fake), 300);
      const late = setTimeout(() => void plugin.post(topic, SENDER, 'late'), 400);
      const res = await plugin.fetchRecent({ topic, since: tail, blockMs: BLOCK_MS });
      for (const t of [broke, repaired, late]) clearTimeout(t);

      expect(res.messages.map((m) => m.content)).toEqual(['late']);
      expect(Date.now() - started).toBeLessThan(PROMPT_MS + 400);
    });
  }
});
