import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, expectNoLeaks, FakeXmpp } from './fake-xmpp.js';

// Class: a lost wakeup caused by arming the wake source AFTER the state snapshot it races.
// `fetchRecent({blockMs})` is MAM-query + live-wait; if the waiter is armed only once a query has
// come back empty, a message that lands during that query's round trip fires into the void and the
// caller waits out the whole budget (up to catchup.block_max_ms) for a message that already exists.
// The table injects a realistic remote round trip and drops a message into EVERY stage of the
// blocking path — before the query is snapshotted, inside the in-flight window, and after the
// waiter is armed — asserting an upper bound on latency in each, not just "it eventually returned".

const TOPIC = asTopic('t-longpoll');
const LATENCY_MS = 200;
const BLOCK_MS = 4_000;
/** Generous over one round trip, far under the budget: only a lost wake reaches the deadline. */
const PROMPT_MS = 1_500;

type Stage =
  | 'before-query-snapshot'
  | 'in-flight-after-snapshot'
  | 'in-flight-of-the-recheck'
  | 'after-waiter-armed';

const stages: Array<{ stage: Stage; note: string }> = [
  { stage: 'before-query-snapshot', note: 'the query itself must return it' },
  { stage: 'in-flight-after-snapshot', note: 'invisible to the in-flight query; only a wake finds it' },
  { stage: 'in-flight-of-the-recheck', note: 'lands during the blocking path own re-query' },
  { stage: 'after-waiter-armed', note: 'delivered between arming and parking' },
];

describe('XMPP long-poll wakeup (no lost wakes across the blocking path)', () => {
  it.each(stages)(
    'returns promptly when a message lands $stage ($note)',
    async ({ stage }) => {
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      const p = attach(plugin, fake);
      const room = p.roomJid(TOPIC);
      p.joined.set(room, Promise.resolve());
      const seed = fake.archiveOnly(room, 'old');

      let delivered = false;
      const deliverOnce = (): void => {
        if (delivered) return;
        delivered = true;
        fake.deliver(room, 'fresh');
      };
      fake.mamLatencyMs = LATENCY_MS;
      if (stage === 'before-query-snapshot') fake.onMamRequest = deliverOnce;
      if (stage === 'in-flight-after-snapshot') fake.onMamInFlight = deliverOnce;
      if (stage === 'in-flight-of-the-recheck') {
        let queries = 0;
        fake.onMamInFlight = () => {
          if (++queries > 1) deliverOnce();
        };
      }
      if (stage === 'after-waiter-armed') {
        const armWaiter = p.armWaiter.bind(plugin);
        p.armWaiter = (r: string, ms: number) => {
          const waiter = armWaiter(r, ms);
          deliverOnce();
          return waiter;
        };
      }

      const started = Date.now();
      const res = await plugin.fetchRecent({
        topic: TOPIC,
        since: asCursor(seed.archId),
        blockMs: BLOCK_MS,
      });
      const elapsed = Date.now() - started;

      expect(res.messages.map((m) => m.content)).toEqual(['fresh']);
      expect(elapsed).toBeLessThan(PROMPT_MS);
      expectNoLeaks(plugin);
      await plugin.disconnect();
    },
  );

  it('holds the full budget (and leaks nothing) when nothing is posted', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    p.joined.set(room, Promise.resolve());
    const seed = fake.archiveOnly(room, 'old');

    const started = Date.now();
    const res = await plugin.fetchRecent({
      topic: TOPIC,
      since: asCursor(seed.archId),
      blockMs: 300,
    });
    const elapsed = Date.now() - started;

    expect(res.messages).toEqual([]);
    expect(String(res.nextCursor)).toBe(seed.archId);
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expectNoLeaks(plugin);
    await plugin.disconnect();
  });

  it('a spurious wake (live stanza the archive does not hold) re-arms instead of returning early', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    p.joined.set(room, Promise.resolve());
    const seed = fake.archiveOnly(room, 'old');

    const started = Date.now();
    const pending = plugin.fetchRecent({
      topic: TOPIC,
      since: asCursor(seed.archId),
      blockMs: 400,
    });
    setTimeout(() => fake.reflectOnly(room, 'not-archived'), 50);
    const res = await pending;

    expect(res.messages).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380); // kept waiting; did not bail at 50 ms
    expectNoLeaks(plugin);
    await plugin.disconnect();
  });

  it('returns as soon as the archive catches up after a live wake (MAM lag)', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    p.joined.set(room, Promise.resolve());
    const seed = fake.archiveOnly(room, 'old');

    const started = Date.now();
    const pending = plugin.fetchRecent({
      topic: TOPIC,
      since: asCursor(seed.archId),
      blockMs: 4_000,
    });
    // Live copy first, archive commit 120 ms later: the wake alone cannot satisfy the fetch.
    setTimeout(() => fake.reflectOnly(room, 'lagging'), 30);
    setTimeout(() => fake.archiveOnly(room, 'lagging'), 150);
    const res = await pending;

    expect(res.messages.map((m) => m.content)).toEqual(['lagging']);
    expect(Date.now() - started).toBeLessThan(1_000);
    expectNoLeaks(plugin);
    await plugin.disconnect();
  });
});
