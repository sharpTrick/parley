/**
 * `disconnect()` tears down the connection AND every subscription. A push loop can be parked at any
 * of several awaits when that happens, and each one is a chance for it to outlive its subscription
 * — most dangerously by sleeping through the teardown and waking up inside the NEXT connection.
 * The table parks the loop at every await and asserts the loop is dead, not merely that
 * `disconnect()` returned.
 */
import { asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { ANY_ROUTE, FAULTS, startFakeZulip } from './fake-zulip.js';
import { TEARDOWN_TIMEOUT_MS } from '../src/http.js';
import { ZulipPlugin } from '../src/index.js';
import {
  type ConnectionEnding,
  CONNECTION_ENDINGS,
  rand,
  SENDER,
  sleep,
  useZulip,
  type ZulipPair,
} from './harness.js';

const boot = useZulip();

const REGISTER = 'POST /api/v1/register';
const DELETE_QUEUE = 'DELETE /api/v1/events';
/** Long enough that a loop parked in a backoff would still be asleep when disconnect lands. */
const SETTLE_MS = 900;

/**
 * A loop failing this long is sleeping off a backoff LONGER than teardown is willing to wait for
 * it — the state in which a loop that is merely flagged, rather than orphaned, survives to the
 * next connection.
 */
const DEEP_BACKOFF_MS = 3100;

interface ParkPoint {
  name: string;
  park: (pair: ZulipPair, topic: string) => Promise<void>;
  /** Undo the failure so a resurrected loop would have a working server to replay against. */
  repair?: (pair: ZulipPair) => void;
  /** How long to watch for a loop that comes back; must outlast whatever it is sleeping off. */
  observeMs?: number;
  /** Registrations this park makes FAIL, which mint no queue and so cannot balance a queue ledger. */
  registerFails?: true;
}

const PARK_POINTS: ParkPoint[] = [
  {
    name: 'the events long-poll',
    park: async () => sleep(100),
  },
  {
    name: 'a failure backoff deeper than the teardown budget (500 on /events)',
    park: async ({ fake }) => {
      fake.failRoute('GET /api/v1/events', FAULTS.serverError);
      await sleep(DEEP_BACKOFF_MS);
    },
    repair: ({ fake }) => fake.clearRouteFailures(),
    observeMs: DEEP_BACKOFF_MS + 1200,
  },
  {
    name: 'the backoff after a failed re-register',
    park: async ({ fake }) => {
      fake.failRoute(REGISTER, FAULTS.serverError);
      fake.gcQueues();
      await sleep(SETTLE_MS);
    },
    repair: ({ fake }) => fake.clearRouteFailures(),
    registerFails: true,
  },
];

const TEARDOWNS = [
  { name: 'disconnect', reconnect: false },
  { name: 'disconnect then connect again', reconnect: true },
];

describe('zulip push loop dies with its subscription, whatever it is parked in', () => {
  for (const point of PARK_POINTS) {
    for (const teardown of TEARDOWNS) {
      it(`parked in ${point.name}: ${teardown.name} leaves no loop behind`, async () => {
        const pair = await boot();
        const { plugin, fake } = pair;
        const topic = asTopic(`life-${rand()}`);
        const got: Message[] = [];
        await plugin.subscribe(topic, (m) => got.push(m));
        await plugin.post(topic, SENDER, 'live');
        await sleep(200);

        await point.park(pair, topic);
        const startedTeardown = Date.now();
        await plugin.disconnect();
        expect(Date.now() - startedTeardown).toBeLessThan(3000);

        point.repair?.(pair);
        const deliveredAtTeardown = got.length;
        const registersAtTeardown = fake.requestCount(REGISTER);
        if (teardown.reconnect) {
          await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
        }
        fake.injectMessage({ topic, content: 'after-teardown' });
        await sleep(point.observeMs ?? 1200);

        expect(got).toHaveLength(deliveredAtTeardown);
        expect(fake.requestCount(REGISTER)).toBe(registersAtTeardown);
      });
    }
  }
});

/** Both ways a connection can be REPLACED, and both servers the replacement can point at. */
const ENTRIES = CONNECTION_ENDINGS.filter((e) => e.reconnects);
const TARGETS = [
  { name: 'the same server', elsewhere: false },
  { name: 'a different server', elsewhere: true },
];

/**
 * CLASS: every per-connection registry starts a connection EMPTY, on every entry path. `connect()`
 * is reachable without a `disconnect()` before it, and a registry cleared in only one of those paths
 * leaves the previous connection's state addressing the new one — a `subscribe` piggybacking a loop
 * that no longer exists, and the old server's event queues never released. The table crosses both
 * entry paths with both servers, because a
 * reconnect to a DIFFERENT site_url is also where a queue id minted by one server is offered to
 * another. The park points are shared with the table above, so a state added there is graded here.
 */
describe('zulip starts every connection from clean per-connection state', () => {
  /** A delivery that lands inside this is push; anything slower is not a live path at all. */
  const DELIVERED_WITHIN_MS = 4000;

  for (const point of PARK_POINTS.filter((p) => p.registerFails !== true)) {
    for (const entry of ENTRIES) {
      for (const target of TARGETS) {
        it(`${entry.name} against ${target.name} with a loop parked in ${point.name}`, async () => {
          const pair = await boot();
          const { plugin, fake } = pair;
          const topic = asTopic(`reset-${rand()}`);
          await plugin.subscribe(topic, () => undefined);
          await plugin.post(topic, SENDER, 'live');
          await sleep(200);
          await point.park(pair, topic);
          point.repair?.(pair);

          const next = target.elsewhere ? (await boot()).fake : fake;
          await entry.end(plugin, next.url);

          // Taken now, so the queues the new connection opens on the same server cannot flatter it.
          const releasedOnOld = fake.requestCount(DELETE_QUEUE);
          const mintedOnOld = fake.requestCount(REGISTER);

          await plugin.post(topic, SENDER, 'seed');
          const registersBefore = next.requestCount(REGISTER);
          const got: string[] = [];
          await plugin.subscribe(topic, (m) => got.push(m.content));
          const started = Date.now();
          await plugin.post(topic, SENDER, 'late');
          for (let i = 0; i < 400 && !got.includes('late'); i++) await sleep(10);

          expect(got).toContain('late');
          expect(Date.now() - started).toBeLessThan(DELIVERED_WITHIN_MS);
          // The new connection carries no subscription state, so this subscribe must have opened a
          // queue of its OWN on the new server — the other half of "it did not join the old one".
          expect(next.requestCount(REGISTER)).toBeGreaterThan(registersBefore);
          expect(releasedOnOld).toBeGreaterThanOrEqual(mintedOnOld);
        }, 30_000);
      }
    }
  }
});

/**
 * CLASS: no seam call outlives the connection that ISSUED it, and none of them resolves as though it
 * had been answered by one. The push loop is bound to the connection generation and so cannot be
 * resurrected by the next `connect()`; nothing that talks to the server on a caller's thread was, and
 * `connect()` clears the `stopped` flag those paths re-checked — so a call parked in an HTTP await
 * across a reconnect finished against whatever server was current when its response landed,
 * answering a cursor minted in one id space out of another's history, or — worst of all, for
 * `subscribe` — reporting success while leaving no subscription anywhere.
 *
 * A call is a SEQUENCE of round trips and every one of them is such a window, so the rows walk the
 * call's own round trips by INDEX rather than naming the route each happens to address: a call that
 * grows a round trip is graded on it the day it is added, and one whose endpoints are renamed or
 * reordered is graded unchanged. `ANY_ROUTE` parks whichever endpoint the Nth round trip turns out
 * to be, and the walk stops when the call settles before an Nth request was ever issued.
 */
describe('zulip: no seam call answers from a connection it did not address', () => {
  /** Long enough that the reconnect lands well inside the parked request. */
  const HOLD_MS = 500;
  /** How deep into a call's round trips the walk goes. */
  const MAX_ROUND_TRIPS = 3;

  interface SeamCall {
    name: string;
    issue: (pair: ZulipPair, topic: string, since: string) => Promise<unknown>;
  }

  const SEAM_CALLS: SeamCall[] = [
    {
      name: 'fetchRecent',
      issue: async ({ plugin }, topic) => plugin.fetchRecent({ topic: asTopic(topic) }),
    },
    {
      name: 'fetchRecent from a cursor',
      issue: async ({ plugin }, topic, since) =>
        plugin.fetchRecent({ topic: asTopic(topic), since: asCursor(since) }),
    },
    {
      name: 'post',
      issue: async ({ plugin }, topic) => plugin.post(asTopic(topic), SENDER, 'in-flight'),
    },
    {
      name: 'subscribe',
      issue: async ({ plugin }, topic) => plugin.subscribe(asTopic(topic), () => undefined),
    },
    {
      name: 'resolveIdentity',
      issue: async ({ plugin }) => plugin.resolveIdentity(asHandle('pat@example.com')),
    },
  ];

  /**
   * Replace the connection while `call`'s `nth` round trip is parked in the fake, and grade the
   * answer. Reports whether that round trip existed at all — the call settling before an `nth`
   * request reached the server ends the walk.
   */
  async function gradeParkedAt(
    call: SeamCall, entry: ConnectionEnding, elsewhereTarget: boolean, nth: number,
  ): Promise<boolean> {
    const pair = await boot();
    const { plugin, fake } = pair;
    const topic = `hop-${rand()}`;
    for (let i = 0; i < 5; i++) await plugin.post(asTopic(topic), SENDER, `a${i}`);
    const tail = (await plugin.fetchRecent({ topic: asTopic(topic) })).nextCursor;

    const elsewhere = elsewhereTarget ? await boot() : pair;
    if (elsewhereTarget) {
      // History of its own on the SAME topic, so answering out of it would be visible as
      // messages, and as a cursor in the other server's id space.
      for (let i = 0; i < 4; i++) await elsewhere.plugin.post(asTopic(topic), SENDER, `b${i}`);
    }
    const next = elsewhere.fake;

    fake.holdResponse(ANY_ROUTE, HOLD_MS);
    const issuedBefore = fake.requestCount();
    let settled = false;
    const outcome = call.issue(pair, topic, tail).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    while (!settled && fake.requestCount() <= issuedBefore + nth) await sleep(5);
    if (settled) {
      await outcome;
      return false;
    }

    const servedByNext = next.requestCount();
    await entry.end(plugin, next.url);
    const answer = await outcome;

    expect(answer).not.toHaveProperty('value');
    expect(String((answer as { error: unknown }).error)).toMatch(/connection was replaced/i);
    // Drain the DETACHED cleanup the abandoned call leaves behind before counting, so that a
    // teardown request aimed at the wrong server cannot pass merely by landing after the read.
    await plugin.disconnect();
    // Only a different server can show the other half — that neither the call nor anything it
    // left behind addressed the connection that replaced the one it was issued against.
    if (elsewhereTarget) expect(next.requestCount()).toBe(servedByNext);
    return true;
  }

  for (const call of SEAM_CALLS) {
    for (const entry of ENTRIES) {
      for (const target of TARGETS) {
        it(`${call.name} rejects when ${entry.name} against ${target.name} lands mid-flight, whichever round trip it is parked in`, async () => {
          let graded = 0;
          for (let nth = 0; nth < MAX_ROUND_TRIPS; nth++) {
            if (!(await gradeParkedAt(call, entry, target.elsewhere, nth))) break;
            graded++;
          }
          expect(graded).toBeGreaterThan(0);
        }, 60_000);
      }
    }
  }

});

/**
 * CLASS: a request issued on a CALLER's path is not registered with teardown, so `disconnect()`
 * cannot cut it and returns while that request is still in flight. Every other table in this file
 * grades a `subscribe()` that has already RESOLVED, or a loop that is already running; the rows
 * below grade the handshake window before either exists, which is the one place a request answers
 * to nobody once teardown has passed — `runBackendCli` calls `process.exit(0)` the moment
 * `shutdown()` resolves, so a `register` still in flight then is killed without its queue ever
 * being read back, let alone released.
 *
 * Every round trip of the handshake is such a window, so the routes are DERIVED from a clean
 * `subscribe()` rather than hand-listed — a handshake that grows a third request is graded the day
 * it appears. A black hole is the fault that isolates teardown from every other bound: the server
 * accepts the request and answers nothing, so only an abort can end it, and the transport deadline
 * that would eventually end it anyway is far past the window these rows allow.
 */
const HANDSHAKE_ROUTES: string[] = await (async (): Promise<string[]> => {
  const fake = await startFakeZulip({ heartbeatMs: 200 });
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
  try {
    const topic = asTopic(`hs-${rand()}`);
    await plugin.post(topic, SENDER, 'old');
    const seen = new Set<string>();
    let handshaking = true;
    fake.setResponseHook((route) => {
      if (handshaking) seen.add(route);
    });
    await plugin.subscribe(topic, () => undefined);
    handshaking = false;
    fake.setResponseHook(undefined);
    return [...seen].sort();
  } finally {
    await plugin.disconnect();
    await fake.close();
  }
})();

/**
 * Every event queue the plugin opens is a server-side resource against the bot's queue budget, and
 * only the plugin knows the id. The ledger below is the class: whatever path minted a queue —
 * subscribe, or a re-register after a GC — the plugin must have asked the server to drop it by the
 * time `disconnect()` returns.
 */
describe('zulip releases every event queue it opens', () => {
  for (const recoveries of [1, 3, 10]) {
    it(`asks the server to drop every queue after ${recoveries} queue GC(s)`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`ledger-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      for (let i = 0; i < recoveries; i++) {
        const registersBefore = fake.requestCount(REGISTER);
        fake.expireQueues();
        await vi.waitFor(() => expect(fake.requestCount(REGISTER)).toBeGreaterThan(registersBefore), {
          timeout: 5000,
          interval: 10,
        });
        await plugin.post(topic, SENDER, `after-gc-${i}`);
        await vi.waitFor(() => expect(got).toHaveLength(i + 1), { timeout: 5000, interval: 10 });
      }

      await plugin.disconnect();
      expect(fake.requestCount(REGISTER)).toBe(recoveries + 1);
      expect(fake.requestCount(DELETE_QUEUE)).toBeGreaterThanOrEqual(fake.requestCount(REGISTER));
    });
  }

  it('the handshake routes are the ones subscribe() issues, and include the one that mints a queue', () => {
    // Not a COUNT: the handshake is one round trip today and was two before the pre-register tail
    // probe went, so a figure here would pin the shape rather than the property. What has to hold is
    // that the derivation found something and that the request which mints a queue is in it.
    expect(HANDSHAKE_ROUTES).not.toEqual([]);
    expect(HANDSHAKE_ROUTES).toContain(REGISTER);
  });

  for (const route of HANDSHAKE_ROUTES) {
    for (const entry of CONNECTION_ENDINGS) {
      it(`${entry.name} cuts a subscribe() handshake black-holed at ${route}`, async () => {
        const { plugin, fake } = await boot();
        const topic = asTopic(`hang-${rand()}`);
        await plugin.post(topic, SENDER, 'old');

        fake.hangRoute(route);
        let settled = false;
        const outcome = plugin.subscribe(topic, () => undefined).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        // Park in the handshake: the hung route must have been REACHED, or the row grades a
        // subscribe that never got that far.
        await vi.waitFor(() => expect(fake.requestCount(route)).toBeGreaterThan(0), {
          timeout: 5000,
          interval: 5,
        });
        expect(settled).toBe(false);

        await entry.end(plugin, fake.url);
        // Bounded, so that a handshake teardown cannot cut answers by TIMING OUT the row: the
        // transport deadline settles it eventually either way, and only a settle inside this window
        // is teardown doing the cutting.
        const answer = await Promise.race([
          outcome,
          sleep(SETTLE_MS).then(() => 'still in flight' as const),
        ]);

        expect(answer).not.toEqual('still in flight');
        expect(answer).not.toHaveProperty('value');
        expect(String((answer as { error: unknown }).error)).toMatch(/connection was replaced/i);
        // The queue ledger is deliberately NOT asserted here: a black-holed route never reaches the
        // fake's queue-minting code, so no queue exists to release and `DELETE >= REGISTER` would
        // grade nothing. The resolved-subscribe table above is what grades the ledger.
      }, 30_000);
    }
  }
});

/**
 * CLASS: teardown ENDS the request it is waiting on rather than waiting it out. `disconnect()`
 * awaits every push loop, and a loop parked in an `/events` long-poll exits only when that request
 * ends — so a teardown that does not cancel the in-flight poll spends the whole `events_timeout_ms`
 * (bounded from above only by the loop-exit race), per connection, on every disconnect a caller
 * makes and on every MCP process exit.
 *
 * Graded as the LATENCY a caller observes against the budget the config publishes, never as the
 * presence of a registry the abort happens to be spelled with today.
 */
describe('disconnect ends an in-flight events long-poll instead of waiting it out', () => {
  const EVENTS_TIMEOUT_MS = 8000;
  /** Generous for a cancel-and-await, and strictly under the LOWEST ceiling above it. */
  const SETTLE_BOUND_MS = 800;
  /** One row: with the abort deleted every topic count settles at the same ceiling, so a second
   *  count discriminates nothing and costs another parked connection. */
  const PARKED_TOPICS = 3;

  /**
   * The ceiling the bound below has to beat is NOT `events_timeout_ms`. `disconnect()` races the
   * loop exits against {@link TEARDOWN_TIMEOUT_MS} and gives up there, so a teardown that cancels
   * NOTHING still returns at that figure. A settle bound at or above it grades the race and not the
   * abort: lower `TEARDOWN_TIMEOUT_MS` under the bound and the row below passes with the abort loop
   * deleted. Read the real constant, so that moving it reddens here rather than hollowing the row
   * out.
   */
  it('bounds the settle strictly under the race that would otherwise cut it', () => {
    expect(
      SETTLE_BOUND_MS,
      'the settle bound is at or above the teardown race, so a disconnect that cancels nothing ' +
        'satisfies it',
    ).toBeLessThan(TEARDOWN_TIMEOUT_MS);
    expect(TEARDOWN_TIMEOUT_MS).toBeLessThan(EVENTS_TIMEOUT_MS);
  });

  it(`with ${PARKED_TOPICS} topics parked on the server`, async () => {
    const topics = PARKED_TOPICS;
    // No heartbeat inside the test's lifetime: every poll is genuinely parked server-side, which is
    // the healthy idle state a live deployment spends almost all of its time in.
    const { plugin, fake } = await boot(
      { heartbeatMs: 120_000 },
      { events_timeout_ms: EVENTS_TIMEOUT_MS },
    );
    const names = Array.from({ length: topics }, () => `t-${rand()}`);
    for (const name of names) await plugin.subscribe(asTopic(name), () => undefined);

    await vi.waitFor(
      () => expect(fake.requestCount('GET /api/v1/events')).toBeGreaterThanOrEqual(topics),
      { timeout: 4000, interval: 10 },
    );

    const t0 = Date.now();
    await plugin.disconnect();
    expect(
      Date.now() - t0,
      `disconnect took longer than a cancel-and-await: it either waited out the ` +
        `${EVENTS_TIMEOUT_MS}ms events budget or fell through to the ${TEARDOWN_TIMEOUT_MS}ms ` +
        'teardown race, instead of cancelling the poll it was parked on',
    ).toBeLessThan(SETTLE_BOUND_MS);
  });
});
