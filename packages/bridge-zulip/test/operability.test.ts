/**
 * A backend that fails in the background must stay cheap and stay visible, and a backend that
 * stops answering must not hold shutdown open. Both are operator-facing properties no conformance
 * case covers, so they get their own tables here.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { FAULTS, type FakeZulip, PERSISTENT_EVENTS_FAULTS } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip } from './harness.js';

const boot = useZulip();

/**
 * Every request the loop can issue. The bound below is asserted on ALL of them, not on the one the
 * failure is injected into: a recovery path that answers 200 (a re-register, a gap-fill read) is
 * exactly where an unpaced retry hides from a single-counter assertion.
 */
const LOOP_ROUTES = ['POST /api/v1/register', 'GET /api/v1/events', 'GET /api/v1/messages'] as const;

/**
 * Ways the push loop can stop making progress forever — none of them recoverable by retrying harder.
 * The dimension is deliberately wider than "ways to get an error status": the failures that carry no
 * status code at all — a poll that is accepted and never answered, or answered with a body the loop
 * cannot ack — are the ones a loop grading itself on its own client-side abort, or on the answer
 * being non-empty, cannot see.
 *
 * The PERSISTENT axis of the shared fault vocabulary supplies one row per shape (injected with no
 * `times`, so it never clears), because pacing is invisible to an injection that clears after one
 * request. The bespoke rows below it are the failures that are not a single wire shape at all: a
 * request nobody answers, and the RECOVERY paths — re-register and gap-fill — which are exactly
 * where an unpaced retry hides from a counter watching the route the fault was injected into.
 */
const PERMANENT_FAILURES: Array<{
  name: string;
  counted: (typeof LOOP_ROUTES)[number];
  apply: (fake: FakeZulip) => void;
  /** Wall clock the report must arrive inside; a fault with no status code takes a cycle to prove. */
  observeMs?: number;
}> = [
  ...PERSISTENT_EVENTS_FAULTS.map((row) => ({
    name: `every /events poll is answered ${row.key} (${row.failure.status})`,
    counted: 'GET /api/v1/events' as const,
    apply: (fake: FakeZulip) => fake.failRoute('GET /api/v1/events', row.failure),
  })),
  {
    // The only failure mode that never yields a status code: the plugin's own long-poll cap is what
    // ends the request, so a loop that reads its own abort as "the server parked for us" is blind.
    name: 'the server accepts every /events poll and never answers it',
    counted: 'GET /api/v1/events',
    apply: (fake: FakeZulip) => fake.hangRoute('GET /api/v1/events'),
    observeMs: 5000,
  },
  {
    name: 're-register keeps failing after a queue GC',
    counted: 'POST /api/v1/register',
    apply: (fake: FakeZulip) => {
      fake.failRoute('POST /api/v1/register', FAULTS.serverError);
      fake.gcQueues();
    },
  },
  {
    name: 'every fresh queue is rejected as stale and the gap-fill reads fail too',
    counted: 'POST /api/v1/register',
    apply: (fake: FakeZulip) => {
      fake.failRoute('GET /api/v1/events', FAULTS.staleQueue);
      fake.failMessagesReads(1_000_000);
    },
  },
  {
    name: 'the gap-fill after a queue GC keeps failing',
    counted: 'GET /api/v1/messages',
    apply: (fake: FakeZulip) => {
      fake.failMessagesReads(1_000_000);
      fake.expireQueues();
    },
  },
];

describe('zulip push loop backs off and reports when it fails permanently', () => {
  for (const mode of PERMANENT_FAILURES) {
    it(`escalates its retry wait and names the backend on stderr when ${mode.name}`, async () => {
      const { plugin, fake } = await boot();
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      const topic = asTopic(`loop-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));
      await plugin.post(topic, SENDER, 'live');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000, interval: 10 });

      const before = new Map(LOOP_ROUTES.map((r) => [r, fake.requestCount(r)]));
      mode.apply(fake);
      await sleep(mode.observeMs ?? 3000);
      const attempts = new Map(
        LOOP_ROUTES.map((r) => [r, fake.requestCount(r) - (before.get(r) ?? 0)]),
      );

      expect(attempts.get(mode.counted)).toBeGreaterThan(0); // it is still trying
      // …but not at a flat, hot interval — on ANY route, including the ones that answer 200.
      const hot = LOOP_ROUTES.filter((r) => (attempts.get(r) ?? 0) >= 10);
      expect([hot, [...attempts]]).toEqual([[], [...attempts]]);
      expect(errors.filter((e) => e.includes('[parley-zulip]')).length).toBeGreaterThan(0);
    });
  }
});

const SERVER_STATES = [
  { name: 'responsive', apply: () => undefined },
  { name: 'answering 500', apply: (fake: FakeZulip) => fake.failRoute('DELETE /api/v1/events', FAULTS.serverError) },
  { name: 'a black hole', apply: (fake: FakeZulip) => fake.hangRoute('DELETE /api/v1/events') },
];

describe('zulip disconnect completes in bounded time whatever the server does', () => {
  for (const state of SERVER_STATES) {
    for (const liveQueues of [0, 1, 3]) {
      it(`resolves with ${liveQueues} live queue(s) against ${state.name}`, async () => {
        const { plugin, fake } = await boot();
        for (let i = 0; i < liveQueues; i++) {
          await plugin.subscribe(asTopic(`down-${i}-${rand()}`), () => undefined);
        }
        state.apply(fake);

        const started = Date.now();
        const outcome = await Promise.race([
          plugin.disconnect().then(() => 'closed'),
          sleep(3000).then(() => 'stalled'),
        ]);
        expect(outcome).toBe('closed');
        expect(Date.now() - started).toBeLessThan(3000);
      });
    }
  }
});
