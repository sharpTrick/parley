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
import { ZulipPlugin } from '../src/index.js';
import { REQUEST_DEADLINE_MS } from '../src/pacing.js';
import { FAULTS, type FakeZulip, startFakeZulip } from './fake-zulip.js';
import { CONNECTION_ENDINGS, rand, SENDER, sleep, useZulip, type ZulipPair } from './harness.js';

const boot = useZulip();

const BLOCK_MS = 4000;
/** A wake that lands inside this is a wake; anything slower is the budget expiring. */
const PROMPT_MS = BLOCK_MS / 4;
const REGISTER = 'POST /api/v1/register';

/**
 * The two primitives a blocked fetch can wake from. Shared across the tables below, so a dimension
 * one of them crosses cannot silently be a dimension the other does not.
 */
const WAKE_SOURCES = [
  { name: 'piggybacking on a live loop', subscribe: true },
  { name: 'on its own dedicated queue', subscribe: false },
];

/**
 * Every route ONE blocked `fetchRecent` issues, observed from a clean run against a healthy server
 * rather than hand-listed. Keep it derived, so that the fault table below cannot have a hole at a
 * route the call depends on — which is exactly what it shipped with.
 */
const CALL_ROUTES: string[] = await (async (): Promise<string[]> => {
  const fake = await startFakeZulip({ heartbeatMs: 200 });
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
  try {
    const topic = asTopic(`routes-${rand()}`);
    await plugin.post(topic, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
    const seen = new Set<string>();
    fake.setResponseHook((route) => seen.add(route));
    await plugin.fetchRecent({ topic, since: tail, blockMs: 600 });
    // The queue teardown is detached, so it can land after the call it belongs to has returned.
    await sleep(300);
    fake.setResponseHook(undefined);
    return [...seen].sort();
  } finally {
    await plugin.disconnect();
    await fake.close();
  }
})();

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
      fake.failRoute('GET /api/v1/events', FAULTS.serverError);
      await sleep(600);
    },
    reusesTheLoopQueue: false,
  },
  {
    name: 'a loop taking a non-queue 400 on /events',
    prepare: async ({ plugin, fake }, topic) => {
      await plugin.subscribe(asTopic(topic), () => undefined);
      fake.failRoute('GET /api/v1/events', FAULTS.nonQueueBadRequest);
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
      fake.failRoute('GET /api/v1/events', FAULTS.emptyBody);
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
      fake.failRoute(REGISTER, FAULTS.serverError);
      await expect(plugin.subscribe(asTopic(topic), () => undefined)).rejects.toThrow();
      await sleep(50);
      fake.clearRouteFailures();
    },
    reusesTheLoopQueue: false,
  },
  {
    name: 'no queue can be opened at all (register is 500 throughout)',
    prepare: async ({ fake }) => {
      fake.failRoute(REGISTER, FAULTS.serverError);
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

  /**
   * CLASS: a registry that advertises a live capability is emptied — and everyone parked on it
   * released — on EVERY path that ends that capability. A subscribe loop ends only when its
   * connection does, so `disconnect()` is what empties the waiter registry; the rows cross both wake
   * primitives with every ending, so a waiter left behind on one path cannot hide behind the other
   * and a new ending is graded the day {@link CONNECTION_ENDINGS} declares it.
   */
  for (const source of WAKE_SOURCES) {
    for (const ending of CONNECTION_ENDINGS) {
      it(`releases a blocked fetch ${source.name} when ${ending.name} lands mid-wait`, async () => {
        const { plugin, fake } = await boot();
        const topic = asTopic(`cut-${rand()}`);
        await plugin.post(topic, SENDER, 'old');
        const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
        if (source.subscribe) await plugin.subscribe(topic, () => undefined);

        const started = Date.now();
        const pending = plugin.fetchRecent({ topic, since: tail, blockMs: BLOCK_MS });
        await sleep(150);
        await ending.end(plugin, fake.url);
        const res = await pending;

        expect(res.messages).toEqual([]);
        expect(res.nextCursor).toBe(tail);
        expect(Date.now() - started).toBeLessThan(PROMPT_MS);
      });
    }
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
      apply: (fake) => fake.failRoute('GET /api/v1/events', FAULTS.staleQueue),
    },
    {
      name: '/events answers 500',
      apply: (fake) => fake.failRoute('GET /api/v1/events', FAULTS.serverError),
    },
    {
      name: '/events answers 200 carrying no events',
      apply: (fake) => fake.failRoute('GET /api/v1/events', FAULTS.emptyBody),
    },
    {
      name: '/events answers 200 carrying only a heartbeat',
      apply: (fake) => fake.failRoute('GET /api/v1/events', FAULTS.heartbeatOnly),
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
 * queue it is about to wait on, dropping it afterwards — has to live inside the budget too.
 *
 * CLASS: a fault table whose rows are hand-listed PER ROUTE silently omits the route the code under
 * test cannot proceed without. This one's routes are OBSERVED from a clean run of the very call it
 * grades, so `GET /api/v1/messages` — which a blocking fetch cannot do without, and which used to
 * appear here only as a 429 row — is crossed with every fault by construction, and a route the call
 * newly depends on is graded the day it starts being issued rather than the day someone adds a row.
 *
 * The other axis is the difference between a server that is merely SLOW and one that STATED a wait.
 * A caller's `blockMs` bounds how long it will wait for a message to ARRIVE; it says nothing about
 * how long this server takes to answer a query, so latency the caller never asked about must still
 * produce the empty page the seam requires at timeout ({@link REQUEST_DEADLINE_MS} is the most a
 * call may overrun by), while a stated wait past the budget is refused rather than slept through.
 */
describe('zulip blocking fetchRecent never overruns its blockMs', () => {
  /** Scheduling, the history re-read, and the fake's own round trips. */
  const SLACK_MS = 700;
  /** Far past every budget below, so honouring one is unmistakable rather than a slow round trip. */
  const HINT_SECONDS = 8;
  /**
   * Enough 429s that the call under test gets one. A transient limit is consumed by whoever reads
   * first — with a live loop draining the topic, that is the loop's own history read, not the
   * fetch's, and the row grades a fault the code under test never saw.
   */
  const RATE_LIMITED_TIMES = 99;
  /** The one request a blocked fetch cannot proceed without — the hole this table shipped with. */
  const REQUIRED_ROUTE = 'GET /api/v1/messages';
  /** Latencies of a healthy-but-slow server; each must still be answerable inside one read budget. */
  const HEALTHY_LATENCIES_MS = [100, 400, 700, 1500];

  interface Fault {
    name: string;
    apply: (fake: FakeZulip, route: string) => void;
    /** Set when the server still ANSWERS — mere latency, not a failure — and how late. */
    latencyMs?: number;
  }

  const LATENCY_KINDS: Fault[] = HEALTHY_LATENCIES_MS.map((ms) => ({
    name: `answering ${ms}ms late`,
    apply: (fake: FakeZulip, route: string) => fake.holdResponse(route, ms),
    latencyMs: ms,
  }));

  const FAILURE_KINDS: Fault[] = [
    {
      name: 'held past every budget',
      apply: (fake, route) => fake.holdResponse(route, 4000),
    },
    { name: 'a black hole', apply: (fake, route) => fake.hangRoute(route) },
    { name: 'answering 500', apply: (fake, route) => fake.failRoute(route, FAULTS.serverError) },
    // A rate limit is the one slow answer the server DICTATES the length of, and the retry sleep
    // that honours it races only `isStopped()` — no caller deadline can cut it short, so a hint
    // must be refused up front by a budget rather than waited out. Both hint carriers are exercised.
    {
      name: `a 429 hinting ${HINT_SECONDS}s in the header`,
      apply: (fake, route) =>
        fake.rateLimit(route, { times: RATE_LIMITED_TIMES, headerSeconds: HINT_SECONDS }),
    },
    {
      name: `a 429 hinting ${HINT_SECONDS}s in the body field`,
      apply: (fake, route) =>
        fake.rateLimit(route, { times: RATE_LIMITED_TIMES, bodySeconds: HINT_SECONDS }),
    },
  ];

  it('the routes it crosses are the ones the call issues, and include the one it requires', () => {
    expect(CALL_ROUTES.length).toBeGreaterThan(1);
    expect(CALL_ROUTES).toContain(REQUIRED_ROUTE);
  });

  it('every latency this table calls healthy fits inside one read budget', () => {
    expect(Math.max(...HEALTHY_LATENCIES_MS)).toBeLessThan(REQUEST_DEADLINE_MS);
    expect(LATENCY_KINDS.map((k) => k.latencyMs)).toEqual(HEALTHY_LATENCIES_MS);
    expect(FAILURE_KINDS.filter((k) => k.latencyMs !== undefined)).toEqual([]);
  });

  it('returns within its budget against a responsive server', async () => {
    const { plugin } = await boot();
    const topic = asTopic(`ceil-${rand()}`);
    await plugin.post(topic, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;

    const started = Date.now();
    const res = await plugin.fetchRecent({ topic, since: tail, blockMs: 600 });
    const elapsed = Date.now() - started;

    expect(res).toEqual({ messages: [], nextCursor: tail });
    expect(elapsed).toBeLessThanOrEqual(600 + SLACK_MS);
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });

  for (const route of CALL_ROUTES) {
    const required = route === REQUIRED_ROUTE;
    // The wake source can only change what happens to a read made INSIDE the wait, and only the
    // required route is read there; the optional routes are the dedicated queue's own and a
    // piggybacking call never issues them.
    const sources = required ? WAKE_SOURCES : [WAKE_SOURCES[1] as (typeof WAKE_SOURCES)[number]];
    // An optional route's own transport bound is the caller's deadline, applied as an abort signal,
    // so every latency past that deadline is absorbed identically and one representative stands for
    // the magnitudes. On the required route the deadline IS the transport bound, which is the whole
    // subject here, so every magnitude gets a row.
    const kinds = required
      ? [...LATENCY_KINDS, ...FAILURE_KINDS]
      : [LATENCY_KINDS[0] as Fault, ...FAILURE_KINDS];

    for (const source of sources) {
      for (const kind of kinds) {
        for (const blockMs of [200, 600, 2000]) {
          const answers = !required || kind.latencyMs !== undefined;
          // A call may overrun the ceiling its caller set by the ONE request it must still issue —
          // never by a second one, and never by the whole shared default deadline.
          const overrunMs = (required ? kind.latencyMs ?? REQUEST_DEADLINE_MS : REQUEST_DEADLINE_MS) + SLACK_MS;
          it(`${answers ? 'answers' : 'fails'} within ${blockMs}ms (+one read) with ${route} ${kind.name}, ${source.name}`, async () => {
            const { plugin, fake } = await boot();
            const topic = asTopic(`ceil-${rand()}`);
            await plugin.post(topic, SENDER, 'old');
            const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
            if (source.subscribe) await plugin.subscribe(topic, () => undefined);
            kind.apply(fake, route);

            const started = Date.now();
            const outcome = await plugin
              .fetchRecent({ topic, since: tail, blockMs })
              .then((res) => res as unknown, (err: unknown) => err);
            const elapsed = Date.now() - started;

            expect(elapsed).toBeLessThanOrEqual(blockMs + overrunMs);
            if (!answers) {
              expect(outcome).toBeInstanceOf(Error);
              return;
            }
            // Latency the caller never asked about is not a failure: the seam requires the empty
            // page at timeout, and a rejection here is the whole `parley_fetch_recent` tool call.
            expect(outcome).toEqual({ messages: [], nextCursor: tail });
            // The budget is a ceiling on the whole call, not a licence to abandon the wait early.
            expect(elapsed).toBeGreaterThanOrEqual(blockMs - 100);
          }, 20_000);
        }
      }
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
      const broke = setTimeout(() => fake.failRoute('GET /api/v1/events', FAULTS.serverError), 30);
      const repaired = setTimeout(() => mode.repair(fake), 300);
      const late = setTimeout(() => void plugin.post(topic, SENDER, 'late'), 400);
      const res = await plugin.fetchRecent({ topic, since: tail, blockMs: BLOCK_MS });
      for (const t of [broke, repaired, late]) clearTimeout(t);

      expect(res.messages.map((m) => m.content)).toEqual(['late']);
      expect(Date.now() - started).toBeLessThan(PROMPT_MS + 400);
    });
  }
});
