/**
 * Two lifecycle CLASSES that a single-instance plugin gets wrong quietly:
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
import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack, type GreetMode } from './fake-slack.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Short enough that a silent handshake is provably bounded without a slow test. */
const HANDSHAKE_MS = 400;

async function makePlugin(fake: FakeSlack): Promise<SlackPlugin> {
  const plugin = new SlackPlugin();
  await plugin.connect({
    api_url: fake.apiUrl,
    bot_token: 'xoxb-test',
    app_token: 'xapp-test',
    handshake_timeout_ms: HANDSHAKE_MS,
  });
  return plugin;
}

type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'pending' };

/**
 * Attach the outcome handlers to `p` NOW — a call that rejects before the test gets round to
 * awaiting it is an unhandled rejection, which vitest reports as a run-level error rather than a
 * row failure — and report which way it went, or `pending`, once `ms` has passed. A test that
 * simply awaits the call cannot fail on a call that never settles: it hangs.
 */
function capture<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): Settled<T> => ({ status: 'rejected', reason }),
  );
}

async function settleWithin<T>(captured: Promise<Settled<T>>, ms: number): Promise<Settled<T>> {
  const pending: Settled<T> = { status: 'pending' };
  return Promise.race([captured, sleep(ms).then(() => pending)]);
}

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
        const fake = await FakeSlack.start();
        fake.createChannel('C0LIVE');
        const plugin = await makePlugin(fake);
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
          await plugin.disconnect();
          await fake.close();
        }
      });
    }
  }

  it('a socket that fails to establish is retried after the cooldown, not replayed and not stormed', async () => {
    const fake = await FakeSlack.start();
    const topic = asTopic('C0BLOCK');
    fake.createChannel(topic);
    const plugin = await makePlugin(fake);
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
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('subscribe is never gated by the poll cooldown: each call dials', async () => {
    const fake = await FakeSlack.start();
    const topic = asTopic('C0SUBDIAL');
    fake.createChannel(topic);
    const plugin = await makePlugin(fake);
    try {
      fake.failMethod('apps.connections.open', 'internal_error', 2);
      for (let i = 0; i < 2; i++) {
        await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow();
      }
      expect(fake.hits('apps.connections.open')).toBe(2);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

const BLOCK_MS = 2000;

describe('slack teardown racing an in-flight connect', () => {
  for (const greet of ['greet', 'pre-hello-close', 'silent'] as GreetMode[]) {
    for (const delayMs of [0, 1, 5, 20, 50, 120]) {
      for (const start of ['subscribe', 'blocking-fetch'] as const) {
        it(`disconnect ${delayMs}ms into ${start} on a ${greet} socket settles it and leaves no socket open`, async () => {
          const fake = await FakeSlack.start();
          const topic = asTopic('C0RACE');
          fake.createChannel(topic);
          fake.setGreet(greet);
          // Hold the handshake open long enough that the teardown lands mid-acquisition for the
          // small delays and after establishment for the large ones.
          fake.setLatency('apps.connections.open', 60);
          const plugin = await makePlugin(fake);
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
    const fake = await FakeSlack.start();
    const topic = asTopic('C0SILENT');
    fake.createChannel(topic);
    fake.setGreet('silent');
    const plugin = await makePlugin(fake);
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
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('a handler registered before a disconnect never fires on the next connection', async () => {
    const fake = await FakeSlack.start();
    const stale = asTopic('C0STALE');
    const fresh = asTopic('C0FRESH');
    fake.createChannel(stale);
    fake.createChannel(fresh);
    const plugin = await makePlugin(fake);
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
      await plugin.disconnect();
      await fake.close();
    }
  });
});
