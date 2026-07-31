/**
 * `disconnect()` tears down the connection AND every subscription. A push loop can be parked at any
 * of several awaits when that happens, and each one is a chance for it to outlive its subscription
 * — most dangerously by sleeping through the teardown and waking up inside the NEXT connection.
 * The table parks the loop at every await and asserts the loop is dead, not merely that
 * `disconnect()` returned.
 */
import { asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { FAULTS } from './fake-zulip.js';
import {
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
  {
    name: 'a gap-fill in flight',
    park: async ({ fake }, topic) => {
      fake.holdResponse('GET /api/v1/messages', 400);
      fake.gcQueues();
      fake.injectMessage({ topic, content: 'in-the-gap' });
      await sleep(300);
    },
    repair: ({ fake }) => fake.clearRouteFailures(),
  },
  {
    name: 'the backoff between gap-fill retries',
    park: async ({ fake }, topic) => {
      fake.gcQueues();
      fake.failMessagesReads(20);
      fake.injectMessage({ topic, content: 'in-the-gap' });
      await sleep(SETTLE_MS);
    },
    repair: ({ fake }) => fake.failMessagesReads(0),
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
 * leaves the previous connection's state addressing the new one — a blocking `fetchRecent` spends
 * its whole budget parked behind a wake source that no longer exists, and the old server's event
 * queues are never released. The table crosses both entry paths with both servers, because a
 * reconnect to a DIFFERENT site_url is also where a queue id minted by one server is offered to
 * another. The park points are shared with the table above, so a state added there is graded here.
 */
describe('zulip starts every connection from clean per-connection state', () => {
  const WAKE_BLOCK_MS = 4000;
  /** A wake that lands inside this is a wake; anything slower is the caller's budget expiring. */
  const WAKE_WITHIN_MS = 1500;

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
          const tail = (await plugin.fetchRecent({ topic })).nextCursor;
          const registersBefore = next.requestCount(REGISTER);
          const started = Date.now();
          const late = setTimeout(() => void plugin.post(topic, SENDER, 'late'), 200);
          const res = await plugin.fetchRecent({ topic, since: tail, blockMs: WAKE_BLOCK_MS });
          clearTimeout(late);

          expect(res.messages.map((m) => m.content)).toEqual(['late']);
          expect(Date.now() - started).toBeLessThan(WAKE_WITHIN_MS);
          // The new connection carries no subscription, so the blocked fetch must have opened a
          // queue of its OWN — the other half of "it did not park behind the old one".
          expect(next.requestCount(REGISTER)).toBeGreaterThan(registersBefore);
          expect(releasedOnOld).toBeGreaterThanOrEqual(mintedOnOld);
        }, 30_000);
      }
    }
  }
});

/**
 * CLASS: no seam call outlives the connection that ISSUED it. The push loop is bound to the
 * connection generation and so cannot be resurrected by the next `connect()`; nothing that talks to
 * the server on a caller's thread was, and `connect()` clears the `stopped` flag those paths
 * re-checked — so a call parked in an HTTP await across a reconnect finished against whatever server
 * was current when its response landed, answering a cursor minted in one id space out of another's
 * history. Each row parks the call in the one route it must touch, replaces the connection while it
 * is parked, and asserts it never answers from the new one.
 */
describe('zulip: no seam call answers from a connection it did not address', () => {
  /** Long enough that the reconnect lands well inside the parked request. */
  const HOLD_MS = 800;

  interface SeamCall {
    name: string;
    /** The route the call must be parked in for a reconnect to land mid-flight. */
    route: string;
    issue: (pair: ZulipPair, topic: string, since: string) => Promise<unknown>;
  }

  const SEAM_CALLS: SeamCall[] = [
    {
      name: 'fetchRecent',
      route: 'GET /api/v1/messages',
      issue: async ({ plugin }, topic) => plugin.fetchRecent({ topic: asTopic(topic) }),
    },
    {
      name: 'fetchRecent with blockMs, parked in its first history read',
      route: 'GET /api/v1/messages',
      issue: async ({ plugin }, topic, since) =>
        plugin.fetchRecent({ topic: asTopic(topic), since: asCursor(since), blockMs: 4000 }),
    },
    {
      name: 'post',
      route: 'POST /api/v1/messages',
      issue: async ({ plugin }, topic) => plugin.post(asTopic(topic), SENDER, 'in-flight'),
    },
    {
      name: 'resolveIdentity',
      route: 'GET /api/v1/users',
      issue: async ({ plugin }) => plugin.resolveIdentity(asHandle('pat@example.com')),
    },
  ];

  for (const call of SEAM_CALLS) {
    for (const entry of ENTRIES) {
      for (const target of TARGETS) {
        it(`${call.name} rejects when ${entry.name} against ${target.name} lands mid-flight`, async () => {
          const pair = await boot();
          const { plugin, fake } = pair;
          const topic = `hop-${rand()}`;
          for (let i = 0; i < 5; i++) await plugin.post(asTopic(topic), SENDER, `a${i}`);
          const tail = (await plugin.fetchRecent({ topic: asTopic(topic) })).nextCursor;

          const elsewhere = target.elsewhere ? await boot() : pair;
          if (target.elsewhere) {
            // History of its own on the SAME topic, so answering out of it would be visible as
            // messages, and as a cursor in the other server's id space.
            for (let i = 0; i < 4; i++) {
              await elsewhere.plugin.post(asTopic(topic), SENDER, `b${i}`);
            }
          }
          const next = elsewhere.fake;
          const servedByNext = next.requestCount(call.route);

          fake.holdResponse(call.route, HOLD_MS);
          const pending = call.issue(pair, topic, tail);
          await sleep(HOLD_MS / 4);
          await entry.end(plugin, next.url);

          await expect(pending).rejects.toThrow(/connection was replaced/i);
          // Only a different server can show the other half — that the call did not RE-ISSUE
          // itself against the connection that replaced the one it addressed.
          if (target.elsewhere) expect(next.requestCount(call.route)).toBe(servedByNext);
        }, 20_000);
      }
    }
  }

  /**
   * The other shape the same call can be parked in: the WAIT rather than a request. A wait ends on
   * teardown by design, so the honest answer there is the caller's own cursor and an empty window —
   * never the new server's messages, and never a cursor in its id space.
   */
  for (const entry of ENTRIES) {
    for (const target of TARGETS) {
      it(`a blocking fetchRecent parked in its wait returns its own cursor across ${entry.name} against ${target.name}`, async () => {
        const pair = await boot();
        const { plugin } = pair;
        const topic = asTopic(`park-${rand()}`);
        for (let i = 0; i < 5; i++) await plugin.post(topic, SENDER, `a${i}`);
        const tail = (await plugin.fetchRecent({ topic })).nextCursor;

        const elsewhere = target.elsewhere ? await boot() : pair;
        if (target.elsewhere) {
          for (let i = 0; i < 4; i++) await elsewhere.plugin.post(topic, SENDER, `b${i}`);
        }

        const pending = plugin.fetchRecent({ topic, since: tail, blockMs: 4000 });
        await sleep(200);
        await entry.end(plugin, elsewhere.fake.url);

        const settled = await pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if ('error' in settled) {
          expect(String(settled.error)).toMatch(/connection was replaced/i);
          return;
        }
        expect(settled.value).toEqual({ messages: [], nextCursor: tail });
      }, 20_000);
    }
  }
});

/**
 * Every event queue the plugin opens is a server-side resource against the bot's queue budget, and
 * only the plugin knows the id. The ledger below is the class: whatever path minted a queue —
 * subscribe, a re-register after a GC, a blocking fetch's dedicated queue — the plugin must have
 * asked the server to drop it by the time `disconnect()` returns.
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
});
