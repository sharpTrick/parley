/**
 * `disconnect()` tears down the connection AND every subscription. A push loop can be parked at any
 * of several awaits when that happens, and each one is a chance for it to outlive its subscription
 * — most dangerously by sleeping through the teardown and waking up inside the NEXT connection.
 * The table parks the loop at every await and asserts the loop is dead, not merely that
 * `disconnect()` returned.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { rand, SENDER, sleep, useZulip, type ZulipPair } from './harness.js';

const boot = useZulip();

const REGISTER = 'POST /api/v1/register';
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
}

const PARK_POINTS: ParkPoint[] = [
  {
    name: 'the events long-poll',
    park: async () => sleep(100),
  },
  {
    name: 'a failure backoff deeper than the teardown budget (500 on /events)',
    park: async ({ fake }) => {
      fake.failRoute('GET /api/v1/events', { status: 500 });
      await sleep(DEEP_BACKOFF_MS);
    },
    repair: ({ fake }) => fake.clearRouteFailures(),
    observeMs: DEEP_BACKOFF_MS + 1200,
  },
  {
    name: 'the backoff after a failed re-register',
    park: async ({ fake }) => {
      fake.failRoute(REGISTER, { status: 500 });
      fake.gcQueues();
      await sleep(SETTLE_MS);
    },
    repair: ({ fake }) => fake.clearRouteFailures(),
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
