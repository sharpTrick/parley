import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import {
  dropTable,
  isUp,
  PG_URL,
  rand,
  settledBackendCount,
  sleep,
  terminateBackends,
} from './pg-harness.js';

// Every socket this plugin opens is published to a field AFTER an await, and `disconnect()` can
// complete inside that await. Whatever is published then is attached to a stopped plugin: it never
// gets ended, it holds a server backend slot for the life of the process, and it keeps the Node
// event loop referenced so a shutdown that does not process.exit() simply hangs. The property is
// one line — after `await disconnect()` this plugin owns NO connection — and it has to hold at
// every point a connection is opened, against a real server, because a mock's `end()` is a boolean
// and a real one is a socket.
//
// Every connection is tagged with a per-test `application_name`, so the count is this test's own
// and not the shared database's traffic.

// A connection is not the only thing published after an await: so is every entry in the plugin's
// bookkeeping, and an entry that survives teardown is worse than a leaked socket. The NEXT connect()
// finds it and believes it — subscribe()'s fast path hands back a TopicSubscription from the dead
// session and issues no LISTEN, so push is permanently dead for that topic with no error anywhere. So
// the post-condition here is the WHOLE registry set, and every cell then re-connects and proves the
// live path works on the same topic; a state container this plugin grows later is covered by
// construction rather than by someone remembering to add it.
interface Priv {
  listener?: unknown;
  listenerPromise?: unknown;
  pool?: unknown;
  subs: Map<string, unknown>;
  subscribing: Map<string, unknown>;
  listens: Map<string, unknown>;
  waiters: Map<string, unknown>;
  pendingAborts: Set<unknown>;
}

const DRAINED = { subs: 0, subscribing: 0, listens: 0, waiters: 0, pendingAborts: 0 };

function registrySizes(priv: Priv): Record<string, number> {
  return {
    subs: priv.subs.size,
    subscribing: priv.subscribing.size,
    listens: priv.listens.size,
    waiters: priv.waiters.size,
    pendingAborts: priv.pendingAborts.size,
  };
}

type Opener = 'connect' | 'subscribe' | 'blocking-fetch' | 'reconnect';
/** Whether disconnect() lands while the connection is still being established, or after it is. */
type When = 'in-flight' | 'settled';

interface RaceCell {
  opener: Opener;
  when: When;
}

const RACE_CELLS: RaceCell[] = (
  ['connect', 'subscribe', 'blocking-fetch', 'reconnect'] as Opener[]
).flatMap((opener) => (['in-flight', 'settled'] as When[]).map((when) => ({ opener, when })));

/**
 * Spin until the listener connection is being established but has not been adopted — the exact
 * window the race is about — rather than sleeping a guessed number of milliseconds.
 */
async function awaitListenerInFlight(priv: Priv): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (priv.listenerPromise !== undefined && priv.listener === undefined) return;
    await sleep(1);
  }
}

async function awaitListenerAdopted(priv: Priv): Promise<void> {
  const deadline = Date.now() + 5000;
  while (priv.listener === undefined && Date.now() < deadline) await sleep(5);
}

if (await isUp(PG_URL)) {
  describe('disconnect() racing connection-establishment leaves no connection behind', () => {
    it.each(
      RACE_CELLS.map((c) => [`${c.opener}, disconnect ${c.when}`, c] as const),
    )('%s', async (_label, cell) => {
      const appName = `parley_hyg_${rand()}`;
      const table = `parley_hyg_${rand()}`;
      const url = `${PG_URL}?application_name=${appName}`;
      const plugin = new PostgresPlugin();
      const topic = asTopic(`hyg-${rand()}`);
      const settle = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);

      const priv = plugin as unknown as Priv;
      try {
        const pending: Promise<unknown>[] = [];
        if (cell.opener === 'connect') {
          const connecting = settle(plugin.connect({ url, table_name: table }));
          pending.push(connecting);
          if (cell.when === 'settled') await connecting;
        } else {
          await plugin.connect({ url, table_name: table });
          if (cell.opener === 'reconnect') {
            await plugin.subscribe(topic, () => undefined);
            await terminateBackends(appName);
            // Land inside the reconnect backoff so the replacement connect() is in flight.
            await sleep(cell.when === 'in-flight' ? 505 : 1200);
          } else {
            const started =
              cell.opener === 'subscribe'
                ? settle(plugin.subscribe(topic, () => undefined))
                : settle(plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 5000 }));
            pending.push(started);
            if (cell.when === 'in-flight') await awaitListenerInFlight(priv);
            else await awaitListenerAdopted(priv);
          }
        }

        await plugin.disconnect();
        await Promise.all(pending);
        // A candidate whose connect() resolves after disconnect must end itself, not publish.
        await sleep(800);

        expect(priv.listener, 'listener resurrected after disconnect').toBeUndefined();
        expect(priv.listenerPromise, 'listener promise resurrected after disconnect').toBeUndefined();
        expect(priv.pool, 'pool resurrected after disconnect').toBeUndefined();
        expect(registrySizes(priv), 'registry state survived teardown').toEqual(DRAINED);
        expect(await settledBackendCount(appName), 'orphaned server backends').toBe(0);

        // Then reuse: the next lifecycle must get a WORKING live path on the same topic. A stale
        // registration from the session just torn down makes subscribe() resolve successfully and
        // never LISTEN, so only a delivered message can tell the two apart.
        await plugin.connect({ url, table_name: table });
        const got: string[] = [];
        await plugin.subscribe(topic, (m) => got.push(m.content));
        await plugin.post(topic, asHandle('u'), 'after-reuse');
        const deadline = Date.now() + 10000;
        while (got.length === 0 && Date.now() < deadline) await sleep(25);
        expect(got, 'push is dead on a topic the previous lifecycle subscribed to').toEqual([
          'after-reuse',
        ]);

        await plugin.disconnect();
        expect(registrySizes(priv), 'registry state survived the second teardown').toEqual(DRAINED);
        expect(await settledBackendCount(appName), 'orphaned server backends after reuse').toBe(0);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        await dropTable(table);
      }
    }, 90000);
  });

  // The seam says nothing about calling its lifecycle methods out of order, so an operator's
  // supervisor eventually will. Every sequence must either fail with an error that names this
  // plugin or leave nothing running — silently stranding a pool is neither.
  const SEQUENCES = [
    'connect;connect',
    'connect;disconnect;connect',
    'disconnect;disconnect',
    'subscribe-before-connect',
    'post-after-disconnect',
  ] as const;

  describe('out-of-order lifecycle calls fail loudly or leave nothing behind', () => {
    it.each(SEQUENCES)('%s', async (sequence) => {
      const appName = `parley_seq_${rand()}`;
      const table = `parley_seq_${rand()}`;
      const url = `${PG_URL}?application_name=${appName}`;
      const plugin = new PostgresPlugin();
      const topic = asTopic(`seq-${rand()}`);

      try {
        if (sequence === 'connect;connect') {
          await plugin.connect({ url, table_name: table });
          await expect(plugin.connect({ url, table_name: table })).rejects.toThrow(
            /parley-postgres: already connected/,
          );
          // The first connection must still be usable — the rejection may not have torn it down.
          await plugin.post(topic, asHandle('u'), 'still works');
          await plugin.disconnect();
        } else if (sequence === 'connect;disconnect;connect') {
          await plugin.connect({ url, table_name: table });
          await plugin.disconnect();
          await plugin.connect({ url, table_name: table });
          await plugin.post(topic, asHandle('u'), 'reconnected');
          expect((await plugin.fetchRecent({ topic })).messages.length).toBe(1);
          await plugin.disconnect();
        } else if (sequence === 'disconnect;disconnect') {
          await plugin.connect({ url, table_name: table });
          await plugin.disconnect();
          await plugin.disconnect();
        } else if (sequence === 'subscribe-before-connect') {
          await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow(/not connected/);
        } else {
          await plugin.connect({ url, table_name: table });
          await plugin.disconnect();
          await expect(plugin.post(topic, asHandle('u'), 'too late')).rejects.toThrow(
            /not connected/,
          );
        }

        expect(await settledBackendCount(appName), 'orphaned server backends').toBe(0);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        await dropTable(table);
      }
    }, 60000);
  });
} else {
  describe.skip(`connection hygiene (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
