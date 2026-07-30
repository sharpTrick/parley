/**
 * A blocking `fetchRecent` must wake from whatever primitive is available at that moment — a live
 * subscribe loop's queue when one is draining the topic, its own short-lived queue when not, and a
 * paced retry when the server offers no push at all. The table walks every state a subscription can
 * be in while a caller is blocked on the same topic, crossing the ways a loop can lose its ability
 * to deliver — answering with an error, answering with nothing usable, and never answering at all.
 * The class it guards is that a caller NEVER parks behind a loop that cannot wake it: a loop that is
 * not delivering must stop being advertised as piggyback-able, so the fetch opens its own queue.
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
  /**
   * True when a live loop's queue must carry the wake — no second queue may be opened. False is the
   * other half of the same claim and is asserted just as hard: the fetch must open a queue of its
   * OWN, because a loop that cannot deliver must not be advertised as piggyback-able.
   */
  reusesTheLoopQueue: boolean;
  /**
   * How long the wake may take. Only a state where NO wake edge exists anywhere — the server accepts
   * every `/events` poll and answers none, so the fetch's own queue is as mute as the loop's — is
   * allowed the whole budget; everything else has a live edge and must use it.
   */
  wakesWithin?: number;
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
    // The one fault that never yields a status code: our own long-poll cap is the only thing that
    // ends the request, so a loop grading itself on that cap alone would look healthy forever.
    name: "a loop whose /events is a black hole (accepted, never answered)",
    prepare: async ({ plugin, fake }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      fake.hangRoute('GET /api/v1/events');
      await sleep(1200); // past two full events_timeout_ms caps
    },
    reusesTheLoopQueue: false,
    wakesWithin: BLOCK_MS + 700,
  },
  {
    name: 'a loop answering /events 200 with a body carrying no events',
    prepare: async ({ plugin, fake }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      fake.failRoute('GET /api/v1/events', { status: 200, body: { result: 'success' } });
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
    const within = state.wakesWithin ?? PROMPT_MS;
    it(`wakes within ${within}ms of a concurrent post with ${state.name}`, async () => {
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
      expect(Date.now() - started).toBeLessThan(within);
      // Both directions, so that "did not piggyback" cannot be satisfied by doing nothing: a healthy
      // loop must carry the wake on its own queue, and an unhealthy one must have handed the fetch
      // back its own.
      const opened = fake.requestCount(REGISTER) - queuesBefore;
      expect(opened === 0, `${opened} queue(s) opened`).toBe(state.reusesTheLoopQueue);
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

  /**
   * With no live loop to piggyback on, every pass of a blocked fetch mints and drops an event queue
   * of its own, so the pace of those passes is a RATE against the operator's server — Zulip's
   * default per-user limit is 200 requests/minute, and core's `catchup.block_max_ms` defaults to
   * 60s. A flat pace that looks fine over one second is 50× over budget over that minute, so the
   * bound is expressed per second of budget and asserted on EVERY route a pass touches, including
   * the ones that answer 200: a wake that never came is the same non-event whether the server said
   * so with an error, with an empty body, or by ignoring the request to park.
   */
  const DEGRADATIONS: Array<{ name: string; apply: (fake: FakeZulip) => void }> = [
    {
      name: 'every event queue is rejected as stale',
      apply: (fake) =>
        fake.failRoute('GET /api/v1/events', {
          status: 400,
          body: { result: 'error', code: 'BAD_EVENT_QUEUE_ID', msg: 'gone' },
        }),
    },
    {
      name: '/events answers 500',
      apply: (fake) => fake.failRoute('GET /api/v1/events', { status: 500 }),
    },
    {
      name: '/events answers 200 carrying no events',
      apply: (fake) => fake.failRoute('GET /api/v1/events', { status: 200, body: { result: 'success' } }),
    },
    {
      name: '/events answers 200 carrying only a heartbeat',
      apply: (fake) =>
        fake.failRoute('GET /api/v1/events', {
          status: 200,
          body: { result: 'success', events: [{ id: 1, type: 'heartbeat' }] },
        }),
    },
    {
      name: '/events is a black hole',
      apply: (fake) => fake.hangRoute('GET /api/v1/events'),
    },
  ];
  /** Every route one pass of a blocked fetch issues — the recovery routes that answer 200 included. */
  const PASS_ROUTES = [
    REGISTER,
    'GET /api/v1/events',
    'DELETE /api/v1/events',
    'GET /api/v1/messages',
  ] as const;

  for (const mode of DEGRADATIONS) {
    for (const blockMs of [1200, 6000]) {
      it(`paces its own retries over ${blockMs}ms when ${mode.name}`, async () => {
        const { plugin, fake } = await boot();
        const topic = asTopic(`spin-${rand()}`);
        await plugin.post(topic, SENDER, 'old');
        const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
        mode.apply(fake);
        const before = new Map(PASS_ROUTES.map((r) => [r, fake.requestCount(r)]));

        const started = Date.now();
        const res = await plugin.fetchRecent({ topic, since: tail, blockMs });

        expect(res.messages).toEqual([]);
        // The budget is spent waiting, not returned early — the other half of "does not spin".
        expect(Date.now() - started).toBeGreaterThanOrEqual(blockMs - 100);
        const passes = Math.ceil(2 + blockMs / 2000);
        const spent = PASS_ROUTES.map((r) => [r, fake.requestCount(r) - (before.get(r) ?? 0)]);
        // Two history reads per pass; every other route is issued at most once.
        const over = spent.filter(([r, n]) => (n as number) > passes * (r === PASS_ROUTES[3] ? 2 : 1));
        expect([over, spent]).toEqual([[], spent]);
      }, 20_000);
    }
  }

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
  /** Far past every budget below, so honouring one is unmistakable rather than a slow round trip. */
  const HINT_SECONDS = 8;

  const SLOW_STATES: Array<{
    name: string;
    apply: (fake: FakeZulip) => void;
    /** A rate-limited HISTORY read has no answer to give inside the budget, so it fails loudly. */
    rejects?: boolean;
  }> = [
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
    // A rate limit is the one slow answer the server DICTATES the length of, and the retry sleep
    // that honours it races only `isStopped()` — no caller deadline can cut it short, so a hint
    // must be refused up front by a budget rather than waited out. Every route the wait path
    // touches gets a row, and both hint carriers (header and body field) are exercised.
    {
      name: `a 429 on register hinting ${HINT_SECONDS}s in the header`,
      apply: (fake: FakeZulip) =>
        fake.rateLimit(REGISTER, { times: 1, headerSeconds: HINT_SECONDS }),
    },
    {
      name: `a 429 on /events hinting ${HINT_SECONDS}s in the header`,
      apply: (fake: FakeZulip) =>
        fake.rateLimit('GET /api/v1/events', { times: 1, headerSeconds: HINT_SECONDS }),
    },
    {
      name: `a 429 on /events hinting ${HINT_SECONDS}s in the body field`,
      apply: (fake: FakeZulip) =>
        fake.rateLimit('GET /api/v1/events', { times: 1, bodySeconds: HINT_SECONDS }),
    },
    {
      name: `a 429 on the history read hinting ${HINT_SECONDS}s in the header`,
      apply: (fake: FakeZulip) =>
        fake.rateLimit('GET /api/v1/messages', { times: 1, headerSeconds: HINT_SECONDS }),
      rejects: true,
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
        const pending = plugin.fetchRecent({ topic, since: tail, blockMs });
        if (state.rejects === true) {
          await expect(pending).rejects.toThrow('429');
          expect(Date.now() - started).toBeLessThanOrEqual(blockMs + SLACK_MS);
          return;
        }
        const res = await pending;
        const elapsed = Date.now() - started;

        expect(res.messages).toEqual([]);
        expect(elapsed).toBeLessThanOrEqual(blockMs + SLACK_MS);
        // The budget is a ceiling on the whole call, not a licence to abandon the wait early.
        expect(elapsed).toBeGreaterThanOrEqual(blockMs - 100);
      }, 20_000);
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
