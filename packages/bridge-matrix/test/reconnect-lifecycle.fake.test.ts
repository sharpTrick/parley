import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin } from '../src/index.js';
import {
  aliasForTopic,
  bearerFor,
  connectFake,
  fakeConfig,
  FakeSynapse,
  HOMESERVER_URL,
  OTHER_HOMESERVER_URL,
} from './fake-synapse.js';

/**
 * CLASS: no background loop may outlive the `disconnect()` that stopped it — including across a
 * subsequent `connect()`. A loop that only watches a shared stopped flag is resurrected the moment
 * that flag clears, and then runs against a stale token, room and handler, invisible to every map
 * `disconnect()` cleared. Parameterized over WHERE the loop was parked when the disconnect landed,
 * because each parking spot re-reads the flag at a different point.
 */

const WRITER = asHandle('writer');
const TOPIC = asTopic('lifecycle');
/** Longer than the retry backoff the loop is parked in, so a resurrected loop has time to show. */
const OBSERVE_MS = 3000;
/** Long enough that a park which only re-checks on its next tick shows up as latency, not a race. */
const SLOW_SYNC_MS = 4000;

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Park the subscribe loop the way this case wants, then hand back the plugin. */
const PARKED_IN = {
  'an in-flight /sync': async (p: MatrixPlugin) => {
    await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(3), {
      timeout: 4000,
      interval: 5,
    });
  },
  'the retry backoff after a failed /sync': async () => {
    fake.syncFailures = Number.POSITIVE_INFINITY;
    await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(4), {
      timeout: 8000,
      interval: 5,
    });
  },
} as const;

describe('a subscribe loop does not survive disconnect + connect', () => {
  for (const [name, park] of Object.entries(PARKED_IN)) {
    it(`parked in ${name}: the pre-disconnect handler goes quiet and issues no more requests`, async () => {
      const p = await connectFake({});
      const got: string[] = [];
      await p.subscribe(TOPIC, (m) => got.push(m.content));
      await park(p);

      await p.disconnect();
      await settle(50); // let a request already on the wire at the disconnect be recorded.
      const attemptsAtDisconnect = fake.syncAttempts.length;
      await p.connect(fakeConfig());
      fake.syncFailures = 0;
      fake.addMessage(String(TOPIC), 'after-reconnect');

      await settle(OBSERVE_MS);

      expect(got).toEqual([]);
      expect(fake.syncAttempts.length).toBe(attemptsAtDisconnect);
      await p.disconnect();
    }, 30_000);
  }
});

/**
 * CLASS: no registry entry may outlive the work it describes. `liveTopics` is a claim that a running
 * `/sync` loop covers a (room, topic) pair; a blocking `fetchRecent` trusts it and declines to open
 * its own dedicated `/sync`. A phantom entry therefore costs a landed message a full slice of
 * `sync_timeout_ms` of silence — and in production `catchup.block_max_ms` is 60s.
 */
const REGISTRIES = ['liveTopics', 'waiters', 'controllers', 'rooms'] as const;

const sizeOf = (p: MatrixPlugin, name: (typeof REGISTRIES)[number]): number =>
  (p as unknown as Record<string, { size: number }>)[name]!.size;

const LIFECYCLES: Record<string, (p: MatrixPlugin) => Promise<void>> = {
  'subscribe → disconnect → connect': async (p) => {
    await p.subscribe(TOPIC, () => undefined);
    await p.disconnect();
    await p.connect(fakeConfig());
  },
  'subscribe → connect (a reconnect with no disconnect)': async (p) => {
    await p.subscribe(TOPIC, () => undefined);
    await p.connect(fakeConfig());
  },
  'a disconnect racing an in-flight subscribe': async (p) => {
    const subscribing = p.subscribe(TOPIC, () => undefined);
    await p.disconnect();
    await subscribing;
  },
};

describe('every internal registry is empty after a lifecycle that stood the loop down', () => {
  for (const [name, sequence] of Object.entries(LIFECYCLES)) {
    it(`${name}: no registry outlives it`, async () => {
      const p = await connectFake({});
      await sequence(p);

      // A `/sync` already on the wire when the sequence ended drains within one fake round-trip; a
      // registry the plugin never cleared never empties, so the timeout is the real assertion.
      await vi.waitFor(
        () => expect(REGISTRIES.map((r) => [r, sizeOf(p, r)])).toEqual(REGISTRIES.map((r) => [r, 0])),
        { timeout: 4000, interval: 10 },
      );
      await p.disconnect();
    }, 30_000);
  }

  it('a blocking fetchRecent afterwards still wakes far inside its budget', async () => {
    const p = await connectFake({ syncTimeoutMs: 8000 });
    await p.subscribe(TOPIC, () => undefined);
    await p.connect(fakeConfig({ syncTimeoutMs: 8000 }));
    await p.post(TOPIC, WRITER, 'seed');
    const tail = (await p.fetchRecent({ topic: TOPIC, limit: 10 })).nextCursor;

    const started = Date.now();
    const pending = p.fetchRecent({ topic: TOPIC, since: tail, blockMs: 3000 });
    const lands = setTimeout(() => void p.post(TOPIC, WRITER, 'fresh'), 150);
    const woke = await pending;
    clearTimeout(lands);

    expect(woke.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(Date.now() - started).toBeLessThan(1500);
    await p.disconnect();
  }, 30_000);
});

/**
 * CLASS: a staleness gate placed BEFORE the await it is supposed to cover. Every seam call resolves
 * a room over two or three round-trips, and a `disconnect()` can land inside any one of them: the
 * work then completes against a cleared token and writes its result into a registry the teardown has
 * already emptied, handing the NEXT generation a room, a route or a waiter it never asked for. A gate
 * checked only before the await it guards cannot see that.
 *
 * WHERE the disconnect lands is driven off the fake's own request hook — the teardown runs while the
 * named request is in flight, not racing a wall-clock timer — and each row proves the phase it names
 * actually fired, so a row that armed nothing fails instead of grading some other window.
 */
const disconnectDuring = (
  p: MatrixPlugin,
  matches: (path: string) => boolean,
): { fired: () => boolean; since: () => string[] } => {
  let after: string[] | undefined;
  fake.onRequest = (method, path) => {
    if (after !== undefined) {
      after.push(`${method} ${path}`);
      return;
    }
    if (!matches(path)) return;
    after = [];
    void p.disconnect();
  };
  return { fired: () => after !== undefined, since: () => after ?? [] };
};

/** Requests that must never follow a teardown: every long-poll and every catch-up read. */
const POST_TEARDOWN_FORBIDDEN = /\/v3\/sync|\/messages$|\/context\//;

/** The page size every driver below reads with, so a noise depth can be stated in pages. */
const PAGE_LIMIT = 5;

/**
 * Raw timeline noise the teardown table seeds before it arms, in PAGES of `PAGE_LIMIT`. `/messages`
 * bounds a page BEFORE filtering, so non-belonging events are what force a read to page: a room
 * holding one page of them lets every paging loop exit on its first empty chunk, and a gate missing
 * from the loop is then unobservable no matter which phase the teardown lands in.
 */
const seedNoisePages = (pages: number): void => {
  for (let i = 0; i < pages * PAGE_LIMIT; i++) {
    fake.addRaw(i % 2 === 0 ? 'm.reaction' : 'm.room.member', aliasForTopic(String(TOPIC)));
  }
};

const TEARDOWN_DRIVERS: Record<
  string,
  {
    setup?: (p: MatrixPlugin) => Promise<unknown>;
    drive: (p: MatrixPlugin, ctx: unknown) => Promise<unknown>;
    /** True only for `post`: the caller's own WRITE finishes rather than standing down. */
    writes: boolean;
  }
> = {
  'a since-less fetchRecent': {
    writes: false,
    drive: (p) => p.fetchRecent({ topic: TOPIC, limit: PAGE_LIMIT }),
  },
  'a post': { writes: true, drive: (p) => p.post(TOPIC, WRITER, 'x') },
  'a subscribe': { writes: false, drive: (p) => p.subscribe(TOPIC, () => undefined) },
  'a blocking fetchRecent from the empty sentinel': {
    writes: false,
    drive: (p) =>
      p.fetchRecent({ topic: TOPIC, since: asCursor(''), blockMs: 1500, limit: PAGE_LIMIT }),
  },
  'a blocking fetchRecent parked at the tail': {
    writes: false,
    setup: async (p) => {
      await p.post(TOPIC, WRITER, 'seed');
      return (await p.fetchRecent({ topic: TOPIC, limit: PAGE_LIMIT })).nextCursor;
    },
    drive: (p, since) =>
      p.fetchRecent({ topic: TOPIC, since: since as never, blockMs: 1500, limit: PAGE_LIMIT }),
  },
};

/**
 * Each phase names the drivers that actually reach it, so no row can arm a request nobody issues,
 * and how DEEP a read the room holds when it does. Depth can only change the outcome where the
 * teardown lands on a request the read may issue AGAIN — every other phase stands the call down
 * before its first page, so those rows stay at one depth rather than paying for a third copy.
 */
const TEARDOWN_PHASES: Record<
  string,
  { matches: (path: string) => boolean; drivers: string[]; noisePages: number[] }
> = {
  'the /directory alias lookup': {
    matches: (path) => path.includes('/directory/room/'),
    noisePages: [0],
    drivers: [
      'a since-less fetchRecent',
      'a post',
      'a subscribe',
      'a blocking fetchRecent from the empty sentinel',
    ],
  },
  'the /join that follows it': {
    matches: (path) => path.endsWith('/join'),
    noisePages: [0],
    drivers: [
      'a since-less fetchRecent',
      'a post',
      'a subscribe',
      'a blocking fetchRecent from the empty sentinel',
    ],
  },
  'the positioning /sync': {
    matches: (path) => path.endsWith('/v3/sync'),
    noisePages: [0],
    drivers: ['a subscribe', 'a blocking fetchRecent parked at the tail'],
  },
  'a /messages page': {
    matches: (path) => path.endsWith('/messages'),
    noisePages: [1, 2, 5],
    drivers: ['a since-less fetchRecent', 'a blocking fetchRecent from the empty sentinel'],
  },
};

describe('a disconnect landing inside a round-trip leaves nothing behind', () => {
  for (const [phaseName, phase] of Object.entries(TEARDOWN_PHASES)) {
    for (const driverName of phase.drivers) {
      for (const noisePages of phase.noisePages) {
        const driver = TEARDOWN_DRIVERS[driverName]!;
        const depth = noisePages === 0 ? '' : ` / ${noisePages} page(s) deep`;
        it(`${driverName} / disconnect lands during ${phaseName}${depth}`, async () => {
          const p = await connectFake({});
          seedNoisePages(noisePages);
          const ctx = await driver.setup?.(p);
          const sentBefore = fake.sentBodies.length;
          const armed = disconnectDuring(p, phase.matches);

          await driver.drive(p, ctx).catch(() => undefined);
          const settled = armed.since().length;
          await settle(300);

          expect(armed.fired()).toBe(true);
          // Nothing the teardown cleared came back…
          expect(REGISTRIES.map((r) => [r, sizeOf(p, r)])).toEqual(REGISTRIES.map((r) => [r, 0]));
          // …no long-poll or catch-up read ran against the cleared token (an in-flight room resolve
          // may still finish — it is bounded, idempotent and hands its result to nobody)…
          expect(armed.since().filter((r) => POST_TEARDOWN_FORBIDDEN.test(r))).toEqual([]);
          expect(armed.since().slice(settled)).toEqual([]);
          // …and the caller's own write is graded the other way, so no row can pass by standing
          // everything down indiscriminately.
          expect(fake.sentBodies.length - sentBefore).toBe(driver.writes ? 1 : 0);
          await p.disconnect();
        }, 30_000);
      }
    }
  }
});

/**
 * CLASS: a plugin wait that watches only the shared stopped flag. Every background park must stand
 * down AT the `disconnect()` — checked BEFORE its next request, not only after it — or it keeps
 * talking to the homeserver with a cleared token, joins rooms post-teardown, and repopulates the
 * registries the next `connect()` just cleared. The `roomExists` axis is what separates the two parks
 * a blocking read can be sitting in: the room-provisioning poll (no room yet) and the `/sync`
 * long-poll (room resolved).
 */
const AFTER: Record<string, (p: MatrixPlugin) => Promise<void>> = {
  disconnect: async (p) => {
    await p.disconnect();
  },
  // `connect()` is the OTHER entry point that ends a generation, so it owes the same stand-down: a
  // teardown only `disconnect()` performs leaves the park holding its timer, its registration and
  // its dedicated `/sync` until its slice expires — 25s of a caller's blockMs at the documented
  // sync_timeout_ms — while the plugin it belongs to is already gone.
  'connect (a bare reconnect, no disconnect)': async (p) => {
    await p.connect(fakeConfig({ syncTimeoutMs: SLOW_SYNC_MS }));
  },
  'disconnect → connect': async (p) => {
    await p.disconnect();
    await p.connect(fakeConfig({ syncTimeoutMs: SLOW_SYNC_MS }));
  },
};

describe('a parked blocking fetchRecent does not outlive the lifecycle call that ended it', () => {
  for (const roomExists of [true, false]) {
    for (const [name, after] of Object.entries(AFTER)) {
      it(`room exists: ${roomExists} / ${name}: settles at once, then issues nothing`, async () => {
        const requests: string[] = [];
        fake.onRequest = (method, path) => void requests.push(`${method} ${path}`);
        const p = await connectFake({ syncTimeoutMs: SLOW_SYNC_MS });
        let since = asCursor('');
        if (roomExists) {
          await p.post(TOPIC, WRITER, 'seed');
          since = (await p.fetchRecent({ topic: TOPIC, limit: 10 })).nextCursor;
        } else {
          fake.aliasExists = false;
        }

        const pending = p.fetchRecent({ topic: TOPIC, since, blockMs: 30_000, limit: 5 });
        await settle(100); // let the wait park

        const torn = Date.now();
        await after(p);
        // The room the wait was polling for appears the instant the teardown lands: a park that
        // ignored it resolves the alias, joins, and reads — all with a cleared token.
        fake.aliasExists = true;
        await settle(50); // let a request already on the wire at the teardown be recorded.
        const atTeardown = requests.length;

        expect((await pending).messages).toEqual([]);
        const settledAfter = Date.now() - torn;

        await settle(500);
        expect(requests.slice(atTeardown)).toEqual([]);
        expect(REGISTRIES.map((r) => [r, sizeOf(p, r)])).toEqual(REGISTRIES.map((r) => [r, 0]));
        expect(settledAfter).toBeLessThan(SLOW_SYNC_MS / 4);
        await p.disconnect();
      }, 30_000);
    }
  }
});

/**
 * CLASS: a lifecycle transition must reset every piece of state it owns — the ACCESS TOKEN included.
 * `connect()` may move the homeserver, so a credential the previous one minted is state that
 * transition owns: left in place it rides the new host's login request, and when that login fails it
 * rides every seam call after it, to a host that never issued it. Parameterized over what the plugin
 * was doing when the reconnect landed, whether the homeserver actually changed, and how the login
 * answered, because the leak and the still-serving halves are reachable from different cells.
 */
const PRIOR_STATE: Record<string, (p: MatrixPlugin) => Promise<void>> = {
  fresh: async () => undefined,
  connected: async (p) => {
    await p.connect(fakeConfig());
  },
  'connected + subscribed': async (p) => {
    await p.connect(fakeConfig());
    await p.subscribe(TOPIC, () => undefined);
  },
};

const TARGETS: Record<string, string> = {
  'the same homeserver': HOMESERVER_URL,
  'a different homeserver': OTHER_HOMESERVER_URL,
};

const LOGIN_OUTCOMES = [200, 401, 403, 'network'] as const;

/** Every `Authorization` a `POST /v3/login` carried — the credential-crossing evidence. */
const loginAuthorizations = (): (string | undefined)[] =>
  fake.requestAuth.filter((_a, i) => fake.requestUrls[i]!.pathname.endsWith('/v3/login'));

describe('connect() resets the credential it is replacing', () => {
  for (const [priorName, prior] of Object.entries(PRIOR_STATE)) {
    for (const [targetName, url] of Object.entries(TARGETS)) {
      for (const outcome of LOGIN_OUTCOMES) {
        const verdict =
          outcome === 200
            ? 'every later request carries only the new token'
            : 'the rejected connect serves nothing';
        it(`prior: ${priorName} / to ${targetName} / login ${outcome}: no login carries a token, and ${verdict}`, async () => {
          const p = new MatrixPlugin();
          await prior(p);

          fake.loginOutcome = outcome;
          const reconnecting = p.connect(fakeConfig({ homeserverUrl: url }));
          if (outcome === 200) await reconnecting;
          else await expect(reconnecting).rejects.toThrow();

          expect(loginAuthorizations().filter((a) => a !== undefined)).toEqual([]);
          expect(loginAuthorizations().length).toBeGreaterThan(0);

          await settle(50); // let a request already on the wire at the reconnect be recorded.
          const mark = fake.requestAuth.length;

          if (outcome === 200) {
            await p.post(TOPIC, WRITER, 'work');
            await p.fetchRecent({ topic: TOPIC, limit: 10 });
            expect([...new Set(fake.requestAuth.slice(mark))]).toEqual([
              bearerFor(new URL(url).host),
            ]);
          } else {
            // A failed login leaves no credential, so every seam call must say so rather than talk
            // to the new homeserver anonymously and serve whatever a permissive one answers.
            await expect(p.post(TOPIC, WRITER, 'secret work')).rejects.toThrow(/parley-matrix/);
            await expect(p.fetchRecent({ topic: TOPIC, limit: 10 })).rejects.toThrow(
              /parley-matrix/,
            );
            await expect(p.subscribe(TOPIC, () => undefined)).rejects.toThrow(/parley-matrix/);
            expect(fake.requestAuth.slice(mark)).toEqual([]);
          }
          await p.disconnect();
        }, 30_000);
      }
    }
  }
});
