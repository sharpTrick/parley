/**
 * Three lifecycle CLASSES that a single-instance plugin gets wrong quietly:
 *
 * (0) RECONNECT OWNERSHIP. Only the loss of an ESTABLISHED connection is a reconnect; every other
 *     handshake failure belongs to the caller that asked for it. Deriving that distinction from
 *     anything but "did this connection see `hello`" misreads the shapes where the failure settles
 *     the handshake BEFORE the close it causes — a handshake timeout, or a websocket `error` from a
 *     URL that refuses the connection — and hands each one a reconnect owner that immediately
 *     redials, whose own failure mints another. The table below crosses every failure shape with
 *     whether a live socket existed first, and grades both the owner count and the dial rate over a
 *     sustained outage, because the harm is O(dials against `apps.connections.open`).
 *
 * (1) A lazily-memoized async singleton must not cache FAILURE. `wsReady` and `authTestPromise`
 *     are both "start it once, everyone awaits the same promise" fields; if a rejected promise
 *     stays in the field, every later caller replays the old error without touching the network,
 *     so one transient failure disables that path for the whole process lifetime. The table drives
 *     each singleton N times against a fake that fails the first K attempts, and asserts both that
 *     the endpoint was hit N times AND that attempt K+1 succeeds.
 *
 * (2) A teardown racing an in-flight resource acquisition must leave nothing open AND must settle
 *     what the caller is holding. `disconnect()` can land while `apps.connections.open` is still in
 *     flight, or while the websocket that opened is waiting for a `hello` that a degraded Socket
 *     Mode edge never sends. Grading only `liveSockets` grades socket hygiene and nothing the
 *     caller observes, so the race table below states an OUTCOME per row: a blocking `fetchRecent`
 *     must RESOLVE with an empty page at the cursor it was given (never reject), and a `subscribe`
 *     must settle inside a bound. An acquisition whose only exit is a message the peer may never
 *     send has no bound at all, which is what the `silent` mode is here to prove.
 */
import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { DIAL_BACKOFF_MS, MAX_DIAL_BACKOFF_MS, SlackPlugin } from '../src/index.js';
import { FakeSlack, type GreetMode } from './fake-slack.js';
import {
  capture,
  settleWithin,
  sleep,
  startSlack,
  type SlackHarness,
  type SlackHarnessOptions,
} from './harness.js';

/** Short enough that a silent handshake is provably bounded without a slow test. */
const HANDSHAKE_MS = 400;

/** Every row here runs on the same short handshake bound; only `opts` varies. */
const startPlugin = (opts: SlackHarnessOptions = {}): Promise<SlackHarness> =>
  startSlack({ handshakeTimeoutMs: HANDSHAKE_MS, ...opts });

/** Long enough that a reconnect loop on its own backoff gets several attempts in. */
const OUTAGE_MS = 2000;

/** Dials `apps.connections.open` may cost over `elapsed` ms of unbroken outage. */
const dialBound = (elapsed: number): number => Math.ceil(elapsed / DIAL_BACKOFF_MS) + 1;

/**
 * A way for Socket Mode to be unavailable. The first two settle the handshake through the socket's
 * own close; the last two settle it BEFORE the close they cause, which is the distinction the owner
 * count is graded on.
 */
const OUTAGES: Array<{ name: string; arm: (fake: FakeSlack) => void }> = [
  {
    name: 'apps.connections.open answering ok:false',
    arm: (fake) => fake.failMethod('apps.connections.open', 'internal_error'),
  },
  { name: 'a socket that closes before hello', arm: (fake) => fake.setGreet('pre-hello-close') },
  { name: 'a socket that accepts and stays silent', arm: (fake) => fake.setGreet('silent') },
  {
    name: 'a handed-out ws URL that refuses the connection',
    arm: (fake) => fake.setWsUrl('ws://127.0.0.1:1/socket'),
  },
];

const spyReconnect = (plugin: SlackPlugin) =>
  vi.spyOn(plugin as unknown as { reconnect: () => Promise<void> }, 'reconnect');

describe('slack reconnect ownership under a sustained outage', () => {
  for (const outage of OUTAGES) {
    for (const entry of ['subscribe', 'blocking-fetch'] as const) {
      it(`${outage.name}, hit cold via ${entry}, mints no reconnect owner and dials O(wall clock)`, async () => {
        const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0COLD'] });
        const topic = asTopic('C0COLD');
        const reconnect = spyReconnect(plugin);
        try {
          outage.arm(fake);
          const t0 = Date.now();
          if (entry === 'subscribe') {
            const outcome = await settleWithin(capture(plugin.subscribe(topic, () => undefined)), OUTAGE_MS);
            expect(outcome.status).toBe('rejected');
            await sleep(Math.max(0, OUTAGE_MS - (Date.now() - t0)));
          } else {
            await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: OUTAGE_MS });
          }
          const elapsed = Date.now() - t0;

          // Nothing was ever established, so nothing was LOST: the failure belongs to the caller
          // that asked for it, and a reconnect loop would redial on top of that caller's own retries.
          expect(reconnect, 'reconnect owners').toHaveBeenCalledTimes(0);
          expect(fake.hits('apps.connections.open')).toBeLessThanOrEqual(dialBound(elapsed));
        } finally {
          await cleanup();
        }
      });
    }

    it(`an established socket dropped into ${outage.name} keeps exactly one reconnect owner`, async () => {
      const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0DROP'] });
      const topic = asTopic('C0DROP');
      try {
        await plugin.subscribe(topic, () => undefined);
        const reconnect = spyReconnect(plugin);
        const dialsBefore = fake.hits('apps.connections.open');

        outage.arm(fake);
        const t0 = Date.now();
        fake.dropSockets();
        await sleep(OUTAGE_MS);
        const elapsed = Date.now() - t0;

        expect(reconnect, 'reconnect owners').toHaveBeenCalledTimes(1);
        expect(fake.hits('apps.connections.open') - dialsBefore).toBeLessThanOrEqual(
          dialBound(elapsed),
        );
      } finally {
        await cleanup();
      }
    });
  }

  /**
   * CLASS: the retry rate must be bounded by WALL CLOCK under every failure mode — including the
   * ones where the retried call SUCCEEDS. Every row of the OUTAGES table above makes the dial or the
   * handshake fail, which is the one path a dial-failure ladder already paces; an edge that accepts,
   * greets and then closes answers every `apps.connections.open` with `ok:true`, so a ladder only
   * failures advance never leaves its first rung and the loop redials at the edge's round-trip rate
   * against Slack's tightest-limit endpoint (Tier 1, ~1 request/minute).
   *
   * The intervals straddle the ladder: below the first rung, between rungs, and above it — the last
   * row is the control, where each connection SERVES for longer than a rung and the ladder must
   * therefore reset rather than climb. Both entry points are graded, because a blocked `fetchRecent`
   * reaches the same loop by its own route, and both a ceiling AND a floor are asserted: never
   * redialling at all satisfies every ceiling here perfectly.
   */
  const FLAP_WINDOW_MS = 3000;
  const FLAP_INTERVALS = [10, 100, 700, 2500];

  for (const everyMs of FLAP_INTERVALS) {
    for (const entry of ['subscribe', 'blocking-fetch'] as const) {
      it(`an edge that greets and drops every ${everyMs}ms, held open by ${entry}, redials O(wall clock)`, async () => {
        const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0FLAP'] });
        const topic = asTopic('C0FLAP');
        try {
          await plugin.subscribe(topic, () => undefined);
          const dialsBefore = fake.hits('apps.connections.open');
          const t0 = Date.now();
          fake.flap(everyMs);
          if (entry === 'subscribe') {
            await sleep(FLAP_WINDOW_MS);
          } else {
            await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: FLAP_WINDOW_MS });
          }
          fake.stopFlap();
          const elapsed = Date.now() - t0;
          const dials = fake.hits('apps.connections.open') - dialsBefore;

          expect(dials, 'dials vs wall clock').toBeLessThanOrEqual(dialBound(elapsed));
          // …and the pacing is not a stall: every row loses at least one established socket, so at
          // least one redial is owed, and the slow row must be back on a live stream at the end.
          expect(fake.establishedClosed, 'sockets actually dropped').toBeGreaterThanOrEqual(1);
          expect(dials, 'redial floor').toBeGreaterThanOrEqual(1);
          if (everyMs > MAX_DIAL_BACKOFF_MS / 2) {
            await vi.waitFor(() => expect(fake.liveSockets).toBe(1), { timeout: 8000, interval: 20 });
          }
        } finally {
          await cleanup();
        }
      });
    }
  }

  it('one reconnect owner survives the whole outage and resumes live delivery on recovery', async () => {
    const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0RESUME'] });
    const topic = asTopic('C0RESUME');
    try {
      const received: string[] = [];
      await plugin.subscribe(topic, (m) => received.push(m.content));
      const reconnect = spyReconnect(plugin);

      fake.setGreet('pre-hello-close');
      fake.dropSockets();
      // Sampled through the outage: a second concurrent `openSocket` orphans a socket nothing will
      // ever close, which shows up as a live-socket count that ratchets rather than staying at most 1.
      for (let i = 0; i < 20; i++) {
        expect(fake.liveSockets, `live sockets ${i * 50}ms into the outage`).toBeLessThanOrEqual(1);
        await sleep(50);
      }

      fake.setGreet('greet');
      await vi.waitFor(() => expect(fake.liveSockets).toBe(1), { timeout: 8000, interval: 20 });
      await plugin.post(topic, asHandle('writer'), 'after-recovery');
      await vi.waitFor(() => expect(received).toContain('after-recovery'), {
        timeout: 4000,
        interval: 10,
      });
      expect(reconnect, 'reconnect owners across outage and recovery').toHaveBeenCalledTimes(1);
      expect(fake.liveSockets).toBe(1);

      await plugin.disconnect();
      await vi.waitFor(() => expect(fake.liveSockets).toBe(0), { timeout: 4000, interval: 20 });
    } finally {
      await cleanup();
    }
  });
});

interface Singleton {
  name: string;
  method: string;
  /** Make the next attempt fail (K times) in this singleton's characteristic way. */
  arm: (fake: FakeSlack, times: number) => void;
  drive: (plugin: SlackPlugin) => Promise<unknown>;
}

const SINGLETONS: Singleton[] = [
  {
    name: 'wsReady / apps.connections.open ok:false',
    method: 'apps.connections.open',
    arm: (fake, times) => fake.failMethod('apps.connections.open', 'internal_error', times),
    drive: (plugin) => plugin.subscribe(asTopic('C0LIVE'), () => undefined),
  },
  {
    name: 'authTestPromise / auth.test ok:false',
    method: 'auth.test',
    arm: (fake, times) => fake.failMethod('auth.test', 'internal_error', times),
    drive: (plugin) => plugin.resolveIdentity(asHandle('parley-bot')),
  },
];

describe('slack memoized async singletons', () => {
  for (const singleton of SINGLETONS) {
    for (const failFirst of [1, 3]) {
      it(`${singleton.name}: ${failFirst} transient failures do not poison later attempts`, async () => {
        const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0LIVE'] });
        try {
          singleton.arm(fake, failFirst);
          const attempts = failFirst + 2;
          const outcomes: Array<'ok' | 'threw'> = [];
          for (let i = 0; i < attempts; i++) {
            try {
              await singleton.drive(plugin);
              outcomes.push('ok');
            } catch {
              outcomes.push('threw');
            }
          }
          // Every FAILING attempt reached the wire, and the eventual success is memoized after
          // that: hits === failures + 1. A cached rejection collapses this to 1.
          expect(fake.hits(singleton.method)).toBe(failFirst + 1);
          expect(outcomes.slice(0, failFirst).every((o) => o === 'threw')).toBe(true);
          expect(outcomes.slice(failFirst)).toEqual(Array(attempts - failFirst).fill('ok'));
        } finally {
          await cleanup();
        }
      });
    }
  }

  it('a socket that fails to establish is retried after the cooldown, not replayed and not stormed', async () => {
    const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0BLOCK'] });
    const topic = asTopic('C0BLOCK');
    try {
      fake.failMethod('apps.connections.open', 'internal_error', 1);
      // Degrades to the non-blocking path once, then cools down.
      await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 50 });
      const afterFirst = fake.hits('apps.connections.open');
      // Core re-drives fetchRecent on its poll cadence; within the cooldown none of those dial.
      for (let i = 0; i < 5; i++) {
        await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 20 });
      }
      expect(fake.hits('apps.connections.open')).toBe(afterFirst);
      // The failure is NOT memoized: once the cooldown lapses the next blocking fetch dials again.
      await sleep(600);
      await plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 50 });
      expect(fake.hits('apps.connections.open')).toBeGreaterThan(afterFirst);
    } finally {
      await cleanup();
    }
  });

  it('subscribe is never gated by the poll cooldown: each call dials', async () => {
    const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0SUBDIAL'] });
    const topic = asTopic('C0SUBDIAL');
    try {
      fake.failMethod('apps.connections.open', 'internal_error', 2);
      for (let i = 0; i < 2; i++) {
        await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow();
      }
      expect(fake.hits('apps.connections.open')).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

/**
 * CLASS: a precondition on a shared resource must be checked where the resource is acquired, not in
 * one of its callers. `subscribe` and a blocking `fetchRecent` both need the shared Socket Mode
 * socket, and a reactive-only deployment configures no `app_token` at all — a legal configuration.
 * A guard living in one caller leaves the other dialling `apps.connections.open`, Slack's
 * tightest-limit endpoint, once per configured topic at startup, under a vendor error naming neither
 * `app_token` nor Socket Mode. Both entry points are graded on the same two observables: what the
 * caller is told, and whether anything reached the wire.
 */
const SOCKET_ENTRIES: Array<{
  name: string;
  /** Whether the absent-token outcome is a rejection naming the token, or a degraded empty page. */
  rejects: boolean;
  run: (plugin: SlackPlugin, topic: string) => Promise<unknown>;
}> = [
  {
    name: 'subscribe',
    rejects: true,
    run: (plugin, topic) => plugin.subscribe(asTopic(topic), () => undefined),
  },
  {
    name: 'blocking fetchRecent',
    rejects: false,
    run: (plugin, topic) =>
      plugin.fetchRecent({ topic: asTopic(topic), since: asCursor('0'), blockMs: 300 }),
  },
];

describe('slack entry points that need the shared socket agree about a missing app_token', () => {
  for (const entry of SOCKET_ENTRIES) {
    for (const appToken of ['xapp-test', null] as const) {
      const absent = appToken === null;
      it(`${entry.name} with ${absent ? 'no' : 'an'} app_token ${absent ? 'never dials' : 'dials'}`, async () => {
        const { fake, plugin, cleanup } = await startPlugin({ appToken, channels: ['C0TOKEN'] });
        try {
          const outcome = await capture(entry.run(plugin, 'C0TOKEN'));
          if (absent && entry.rejects) {
            expect(outcome.status).toBe('rejected');
            expect(String((outcome as { reason: unknown }).reason)).toMatch(/app_token/);
          } else {
            expect(outcome.status).toBe('fulfilled');
          }
          expect(fake.hits('apps.connections.open'), 'dials').toBe(absent ? 0 : 1);
          expect(fake.unauthedHits('apps.connections.open'), 'token-less dials').toBe(0);
        } finally {
          await cleanup();
        }
      });
    }
  }
});

const BLOCK_MS = 2000;

describe('slack teardown racing an in-flight connect', () => {
  for (const greet of ['greet', 'pre-hello-close', 'silent'] as GreetMode[]) {
    for (const delayMs of [0, 1, 5, 20, 50, 120]) {
      for (const start of ['subscribe', 'blocking-fetch'] as const) {
        it(`disconnect ${delayMs}ms into ${start} on a ${greet} socket settles it and leaves no socket open`, async () => {
          // Hold the handshake open long enough that the teardown lands mid-acquisition for the
          // small delays and after establishment for the large ones.
          const { fake, plugin } = await startPlugin({
            channels: ['C0RACE'],
            greet,
            arm: (f: FakeSlack) => f.setLatency('apps.connections.open', 60),
          });
          const topic = asTopic('C0RACE');
          try {
            const inFlight = capture<unknown>(
              start === 'subscribe'
                ? plugin.subscribe(topic, () => undefined)
                : plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: BLOCK_MS }),
            );

            await sleep(delayMs);
            await plugin.disconnect();
            // Generous versus the teardown, tight versus the budgets that would hide the bug:
            // under `blockMs`, and under the handshake timeout the silent rows would otherwise run.
            const outcome = await settleWithin(inFlight, 300);

            const where = `${start} / ${greet} / +${delayMs}ms`;
            expect(outcome.status, where).not.toBe('pending');
            if (start === 'blocking-fetch') {
              // The caller's observable contract: an interrupted long-poll is an empty page at the
              // cursor it was given — core surfaces a rejection here as a tool error.
              expect(outcome.status, where).toBe('fulfilled');
              const value = (outcome as { value: { messages: unknown[]; nextCursor: string } }).value;
              expect(value.messages, where).toEqual([]);
              expect(String(value.nextCursor), where).toBe('0');
            }

            await sleep(300);
            expect(fake.liveSockets, where).toBe(0);
          } finally {
            await fake.close();
          }
        });
      }
    }
  }

  it('a socket that never says hello bounds subscribe and every blocking fetch on its own', async () => {
    const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0SILENT'], greet: 'silent' });
    const topic = asTopic('C0SILENT');
    try {
      // The long-poll's own budget, not the handshake's, is what a blocked fetch_recent observes —
      // so ask for a budget well UNDER the handshake timeout and hold the call to it.
      const fetchStarted = Date.now();
      const fetched = await settleWithin(
        capture(plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: HANDSHAKE_MS / 4 })),
        HANDSHAKE_MS * 4,
      );
      expect(fetched.status).toBe('fulfilled');
      expect(Date.now() - fetchStarted).toBeLessThan(HANDSHAKE_MS);

      const subscribed = await settleWithin(
        capture(plugin.subscribe(topic, () => undefined)),
        HANDSHAKE_MS * 6,
      );
      expect(subscribed.status).toBe('rejected');
      expect(String((subscribed as { reason: unknown }).reason)).toMatch(/no hello within \d+ms/);
    } finally {
      await cleanup();
    }
  });

  /**
   * CLASS: teardown must close every socket the plugin HOLDS, not the one field it happens to track.
   * A `disconnect: warning` rotation deliberately runs two Socket Mode connections at once, so any
   * state that can hold more than one is a state `disconnect()` owes an answer for — an orphan goes
   * on acking envelopes to Slack, marking them delivered against a bridge that has cleared its
   * routes, and burns one of the ~10 connections an app token gets.
   *
   * `live` is asserted BEFORE the teardown, so a row cannot silently stop reaching the state it
   * names and go on passing on the strength of the teardown alone.
   */
  const SOCKET_STATES: Array<{
    name: string;
    live: number;
    reach: (fake: FakeSlack, plugin: SlackPlugin, topic: Topic) => Promise<void>;
  }> = [
    { name: 'cold', live: 0, reach: async () => undefined },
    {
      name: 'establishing',
      live: 1,
      reach: async (fake, plugin, topic) => {
        fake.setGreet('silent');
        void capture(plugin.subscribe(topic, () => undefined));
        await vi.waitFor(() => expect(fake.liveSockets).toBe(1), { timeout: 4000, interval: 5 });
      },
    },
    {
      name: 'established',
      live: 1,
      reach: async (_fake, plugin, topic) => {
        await plugin.subscribe(topic, () => undefined);
      },
    },
    {
      name: 'rotating',
      live: 2,
      reach: async (fake, plugin, topic) => {
        await plugin.subscribe(topic, () => undefined);
        // The replacement stays silent, so the overlap the rotation opens is stable rather than a
        // window a poll has to catch; Slack never closes its half here either.
        fake.setGreet('silent');
        fake.pushUnackedEnvelope({ type: 'disconnect', reason: 'warning' });
        await vi.waitFor(() => expect(fake.liveSockets).toBe(2), { timeout: 4000, interval: 5 });
      },
    },
  ];

  for (const state of SOCKET_STATES) {
    it(`disconnect from the ${state.name} state closes every socket the plugin holds`, async () => {
      // Long enough that a silent socket stays open across the row rather than being reaped by the
      // handshake bound mid-assertion.
      const { fake, plugin } = await startSlack({
        handshakeTimeoutMs: 5000,
        channels: ['C0OWN'],
      });
      try {
        await state.reach(fake, plugin, asTopic('C0OWN'));
        expect(fake.liveSockets, `${state.name}: sockets held`).toBe(state.live);

        await plugin.disconnect();
        await vi.waitFor(() => expect(fake.liveSockets).toBe(0), { timeout: 4000, interval: 5 });
      } finally {
        await fake.close();
      }
    });
  }

  /**
   * CLASS: any period in which the plugin holds more than one event source for one channel. Slack
   * OPENS that period deliberately — the warning exists so the replacement is up before the old
   * socket goes — but the plugin owns its END: Slack routes each payload to any ONE of an app's open
   * connections and promises nothing about ordering across them, and an edge that never closes its
   * half would otherwise leave one established connection behind per rotation, against the ~10 an
   * app token gets. The fake never closes the old half here, so only the plugin can end this.
   */
  const ROTATION_GRACE_MS = 500;

  it('a rotation bounds its own grace, and the replacement carries the stream', async () => {
    const { fake, plugin, cleanup } = await startPlugin({
      channels: ['C0ROTATE'],
      rotationGraceMs: ROTATION_GRACE_MS,
    });
    const topic = asTopic('C0ROTATE');
    try {
      const seen: string[] = [];
      await plugin.subscribe(topic, (m) => seen.push(m.content));
      expect(fake.helloSent).toBe(1);

      fake.pushUnackedEnvelope({ type: 'disconnect', reason: 'warning' });
      // The grace opens: both connections are up, which is what makes the rotation gapless…
      await vi.waitFor(() => expect(fake.liveSockets).toBe(2), { timeout: 4000, interval: 5 });
      expect(fake.helloSent, 'replacement established').toBe(2);
      // …and closes on the plugin's own clock, not the vendor's.
      await vi.waitFor(() => expect(fake.liveSockets).toBe(1), { timeout: 4000, interval: 5 });

      await plugin.post(topic, asHandle('writer'), 'after the rotation');
      await vi.waitFor(() => expect(seen).toContain('after the rotation'), {
        timeout: 4000,
        interval: 10,
      });
    } finally {
      await cleanup();
    }
  });

  it('every rotation is bounded, so a flood of warnings cannot accumulate connections', async () => {
    const { fake, plugin, cleanup } = await startPlugin({
      channels: ['C0ROTFLOOD'],
      rotationGraceMs: ROTATION_GRACE_MS,
    });
    const topic = asTopic('C0ROTFLOOD');
    try {
      await plugin.subscribe(topic, () => undefined);
      for (let i = 0; i < 4; i++) {
        fake.pushUnackedEnvelope({ type: 'disconnect', reason: 'warning' });
        await vi.waitFor(() => expect(fake.liveSockets).toBe(2), { timeout: 4000, interval: 5 });
        await vi.waitFor(() => expect(fake.liveSockets).toBe(1), { timeout: 4000, interval: 5 });
      }
    } finally {
      await cleanup();
    }
  });

});

/**
 * The third lifecycle class: `connect` as a TRANSITION, not just an entry point.
 */
describe('slack connect is a session boundary, not a partial reset', () => {
  /**
   * CLASS: a lifecycle field the SECOND entry into a session forgets to reset. The table above adds
   * `disconnect` as the transition and holds the entry state fixed; this adds `connect` as a second
   * transition axis, because `connect` is where the config — and therefore the tokens every one of
   * those fields belongs to — changes. A half-reset leaves the previous session's routes firing off
   * a socket the new configuration never opened, its `auth.test` answer standing in for a different
   * `bot_token`, and its reconnect loop parked in a backoff that a later `connect` un-parks: it
   * wakes, sees `stopped` false again, and dials `apps.connections.open` for a session that asked
   * for no live path at all.
   *
   * Each row reaches a state under session A and then connects session B over it; the assertions
   * are the same four for every row, so a field that survives one transition and not another cannot
   * hide in a row of its own.
   */
  const STALE_TOPIC = 'C0SESSA';
  const FRESH_TOPIC = 'C0SESSB';

  const sessionConfig = (fake: FakeSlack, token: string): Record<string, unknown> => ({
    api_url: fake.apiUrl,
    bot_token: token,
    app_token: `xapp-${token}`,
    handshake_timeout_ms: HANDSHAKE_MS,
  });

  const ENTRY_STATES: Array<{
    name: string;
    arrive: (fake: FakeSlack, plugin: SlackPlugin, stale: (content: string) => void) => Promise<void>;
  }> = [
    { name: 'cold', arrive: async () => undefined },
    {
      name: 'connected, subscribed',
      arrive: async (fake, plugin, stale) => {
        await plugin.connect(sessionConfig(fake, 'xoxb-a'));
        await plugin.subscribe(asTopic(STALE_TOPIC), (m) => stale(m.content));
        await plugin.resolveIdentity(asHandle('parley-bot'));
      },
    },
    {
      name: 'connected, subscribed, disconnected',
      arrive: async (fake, plugin, stale) => {
        await plugin.connect(sessionConfig(fake, 'xoxb-a'));
        await plugin.subscribe(asTopic(STALE_TOPIC), (m) => stale(m.content));
        await plugin.resolveIdentity(asHandle('parley-bot'));
        await plugin.disconnect();
      },
    },
    {
      name: 'disconnected while a reconnect loop was parked in its backoff',
      arrive: async (fake, plugin, stale) => {
        await plugin.connect(sessionConfig(fake, 'xoxb-a'));
        await plugin.subscribe(asTopic(STALE_TOPIC), (m) => stale(m.content));
        await plugin.resolveIdentity(asHandle('parley-bot'));
        // An ESTABLISHED loss hands the redial to a reconnect owner; the failure parks it in the
        // backoff that outlives the teardown below.
        fake.failMethod('apps.connections.open', 'internal_error');
        fake.dropSockets();
        await sleep(150);
        await plugin.disconnect();
      },
    },
  ];

  for (const state of ENTRY_STATES) {
    it(`connect from ${state.name} starts a session that inherits nothing`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      const stale: string[] = [];
      const fresh: string[] = [];
      fake.createChannel(STALE_TOPIC);
      fake.createChannel(FRESH_TOPIC);
      try {
        await state.arrive(fake, plugin, (content) => stale.push(content));

        await plugin.connect(sessionConfig(fake, 'xoxb-b'));
        const dialsAtConnect = fake.hits('apps.connections.open');
        const authsAtConnect = fake.hits('auth.test');

        // (a) Nothing the new session did not ask for is open, and nothing it did not ask for dials.
        // The wait is longer than the parked reconnect backoff, so a resurrected loop shows up here.
        await sleep(800);
        fake.failMethod('apps.connections.open', 'internal_error', 0);
        expect(fake.liveSockets, 'sockets held by a session that has not subscribed').toBe(0);
        expect(fake.hits('apps.connections.open'), 'unrequested dials').toBe(dialsAtConnect);

        // (b) The previous session's handler is not on the new session's stream.
        await plugin.post(asTopic(STALE_TOPIC), asHandle('writer'), 'after the boundary');
        await sleep(200);
        expect(stale, 'a retired handler fired').toEqual([]);

        // (c) The previous session's memoized identity is not answered for the new bot_token.
        await plugin.resolveIdentity(asHandle('parley-bot'));
        expect(fake.hits('auth.test'), 'auth.test re-issued for the new token').toBe(
          authsAtConnect + 1,
        );

        // (d) …and the new session is fully usable, so none of the above is true by being broken.
        await plugin.subscribe(asTopic(FRESH_TOPIC), (m) => fresh.push(m.content));
        await plugin.post(asTopic(FRESH_TOPIC), asHandle('writer'), 'live in the new session');
        await vi.waitFor(() => expect(fresh).toEqual(['live in the new session']), {
          timeout: 4000,
          interval: 10,
        });
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }

  /**
   * CLASS: an async path RESUMING after the boundary. Every row above lets the previous session
   * SETTLE before `connect`, so none of them can fail on a call still in flight across it — and
   * `stopped`, the flag each post-await checkpoint reads, is cleared by the next `connect()`, so a
   * checkpoint written against it alone reads a retired call as live. The resumed call then acts on
   * the NEW session's state: it opens a Socket Mode connection on the retired `app_token` that
   * nothing subscribed for (a second event source into one channel, which is what the ascending-`ts`
   * handler guarantee rests on not existing), or its failure path deletes the route the new session
   * has just registered, leaving a `subscribe` that resolved and delivers nothing.
   *
   * Each row arms latency on ONE Web API method a seam entry point awaits, starts that entry point,
   * and lands `disconnect(); connect(configB)` inside the round trip — then the new session
   * subscribes to the SAME channel while the retired call is still out, so a late mutation has
   * something of the new session's to damage.
   */
  const IN_FLIGHT: Array<{
    name: string;
    method: string;
    /** Some paths only mutate on FAILURE; those rows fail the retired call's method exactly once. */
    failWith?: string;
    latencyMs: number;
    start: (plugin: SlackPlugin, onStale: (content: string) => void) => Promise<unknown>;
  }> = [
    {
      name: 'subscribe awaiting apps.connections.open',
      method: 'apps.connections.open',
      latencyMs: 250,
      start: (plugin, onStale) => plugin.subscribe(asTopic(STALE_TOPIC), (m) => onStale(m.content)),
    },
    {
      name: "subscribe awaiting its conversations.history probe, which then fails",
      method: 'conversations.history',
      failWith: 'not_in_channel',
      latencyMs: 300,
      start: (plugin, onStale) => plugin.subscribe(asTopic(STALE_TOPIC), (m) => onStale(m.content)),
    },
    {
      name: 'blocking fetchRecent awaiting apps.connections.open',
      method: 'apps.connections.open',
      latencyMs: 250,
      start: (plugin) =>
        plugin.fetchRecent({ topic: asTopic(STALE_TOPIC), since: asCursor('0'), blockMs: 3000 }),
    },
    {
      name: 'blocking fetchRecent awaiting conversations.history',
      method: 'conversations.history',
      latencyMs: 250,
      start: (plugin) =>
        plugin.fetchRecent({ topic: asTopic(STALE_TOPIC), since: asCursor('0'), blockMs: 3000 }),
    },
    {
      name: 'resolveIdentity awaiting auth.test',
      method: 'auth.test',
      latencyMs: 250,
      start: (plugin) => plugin.resolveIdentity(asHandle('parley-bot')),
    },
  ];

  for (const row of IN_FLIGHT) {
    it(`a ${row.name} across the boundary touches nothing in the new session`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      const stale: string[] = [];
      const fresh: string[] = [];
      fake.createChannel(STALE_TOPIC);
      try {
        await plugin.connect(sessionConfig(fake, 'xoxb-a'));
        fake.setLatency(row.method, row.latencyMs);
        if (row.failWith !== undefined) fake.failMethod(row.method, row.failWith, 1);
        const inFlight = capture(row.start(plugin, (content) => stale.push(content)));

        await sleep(60);
        await plugin.disconnect();
        await plugin.connect(sessionConfig(fake, 'xoxb-b'));
        const dialsAtConnect = fake.hits('apps.connections.open');
        const authsAtConnect = fake.hits('auth.test');

        // The new session subscribes while the retired call is STILL OUT — the only ordering in
        // which a late mutation can reach state the new session owns.
        await plugin.subscribe(asTopic(STALE_TOPIC), (m) => fresh.push(m.content));
        // A retired call has no caller left to serve, so it must settle on the teardown rather than
        // run its own budget out inside the new session — the rung loop re-reads history and arms a
        // waiter per rung, all of it against a configuration it was never given.
        const settled = await settleWithin(inFlight, 900);
        expect(settled.status, 'the retired call ran on into the new session').not.toBe('pending');
        await sleep(500);

        // (a) Exactly the one socket the new session's own subscribe opened, from its own one dial.
        expect(fake.liveSockets, 'sockets held after the retired call landed').toBe(1);
        expect(fake.hits('apps.connections.open'), 'dials').toBe(dialsAtConnect + 1);

        // (b) The retired session's handler is not on the new session's stream.
        // (c) …and the new session's subscribe still delivers, so nothing retired unsubscribed it.
        await plugin.post(asTopic(STALE_TOPIC), asHandle('writer'), 'live in the new session');
        await vi.waitFor(() => expect(fresh).toEqual(['live in the new session']), {
          timeout: 4000,
          interval: 10,
        });
        expect(stale, 'a retired handler fired').toEqual([]);

        // (d) The retired session's memoized identity is not answered for the new bot_token, and a
        // retired `auth.test` settling late does not evict the answer the new one memoized.
        await plugin.resolveIdentity(asHandle('parley-bot'));
        await plugin.resolveIdentity(asHandle('parley-bot'));
        expect(fake.hits('auth.test'), 'auth.test issued once for the new token').toBe(
          authsAtConnect + 1,
        );
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }

  it('a retired dial failing late does not put the new session into a cooldown it never earned', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    fake.createChannel(STALE_TOPIC);
    try {
      await plugin.connect(sessionConfig(fake, 'xoxb-a'));
      fake.setLatency('apps.connections.open', 300);
      fake.failMethod('apps.connections.open', 'internal_error', 1);
      const inFlight = capture(plugin.subscribe(asTopic(STALE_TOPIC), () => undefined));

      await sleep(60);
      await plugin.disconnect();
      await plugin.connect(sessionConfig(fake, 'xoxb-b'));
      fake.setLatency('apps.connections.open', 0);
      expect((await inFlight).status).toBe('rejected');
      await sleep(50);

      // The dial cooldown is what stops core's 250 ms re-drive becoming a storm against Slack's
      // tightest-limit endpoint — so a cooldown one session's failure imposes on the NEXT one
      // silently disables its live push for as long as the ladder rung lasts.
      const dialsBefore = fake.hits('apps.connections.open');
      await plugin.fetchRecent({
        topic: asTopic(STALE_TOPIC),
        since: asCursor('0'),
        blockMs: 100,
      });
      expect(fake.hits('apps.connections.open'), 'the new session dialled').toBe(dialsBefore + 1);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('a retired auth.test failing late does not evict the new session identity memo', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    try {
      await plugin.connect(sessionConfig(fake, 'xoxb-a'));
      fake.setLatency('auth.test', 300);
      const inFlight = capture(plugin.resolveIdentity(asHandle('parley-bot')));

      await sleep(60);
      await plugin.disconnect();
      await plugin.connect(sessionConfig(fake, 'xoxb-b'));

      fake.setLatency('auth.test', 0);
      await plugin.resolveIdentity(asHandle('parley-bot'));
      const authsAfterB = fake.hits('auth.test');
      // Armed only now, so the RETIRED call is the one it answers: the failure path is the only
      // place the memo is cleared, and it must clear nobody's entry but its own.
      fake.failMethod('auth.test', 'internal_error', 1);
      expect((await inFlight).status).toBe('rejected');
      await sleep(100);

      await plugin.resolveIdentity(asHandle('parley-bot'));
      expect(fake.hits('auth.test'), 'the new session re-asked').toBe(authsAfterB);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('a handler registered before a disconnect never fires on the next connection', async () => {
    const { fake, plugin, cleanup } = await startPlugin({ channels: ['C0STALE', 'C0FRESH'] });
    const stale = asTopic('C0STALE');
    const fresh = asTopic('C0FRESH');
    try {
      const before: string[] = [];
      const after: string[] = [];
      await plugin.subscribe(stale, (m) => before.push(m.content));
      await plugin.disconnect();

      await plugin.connect({
        api_url: fake.apiUrl,
        bot_token: 'xoxb-test',
        app_token: 'xapp-test',
        handshake_timeout_ms: HANDSHAKE_MS,
      });
      await plugin.subscribe(fresh, (m) => after.push(m.content));
      await plugin.post(stale, asHandle('writer'), 'to the stale route');
      await plugin.post(fresh, asHandle('writer'), 'to the live route');

      await sleep(400);
      expect(after).toEqual(['to the live route']);
      expect(before).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
