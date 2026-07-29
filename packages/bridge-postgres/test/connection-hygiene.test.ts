import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

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

const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';
const rand = (): string => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function isUp(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 800 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
    return true;
  } catch {
    await c.end().catch(() => undefined);
    return false;
  }
}

async function withAdmin<T>(fn: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: PG_URL });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function backendCount(appName: string): Promise<number> {
  return withAdmin(async (admin) => {
    const res = await admin.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
      [appName],
    );
    return (res.rows[0] as { n: number }).n;
  });
}

async function terminateBackends(appName: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [appName],
    );
  });
}

async function dropTable(table: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    await admin.query(`DROP TABLE IF EXISTS "${table}_senders" CASCADE`);
    await admin.query(`DROP FUNCTION IF EXISTS "${table}_notify"() CASCADE`);
  });
}

/** Poll until this plugin's backends are gone, so a slow FIN is not reported as a leak. */
async function settledBackendCount(appName: string, budgetMs = 3000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let n = await backendCount(appName);
  while (n > 0 && Date.now() < deadline) {
    await sleep(100);
    n = await backendCount(appName);
  }
  return n;
}

interface Priv {
  listener?: unknown;
  listenerPromise?: unknown;
  pool?: unknown;
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
        expect(await settledBackendCount(appName), 'orphaned server backends').toBe(0);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        await dropTable(table);
      }
    }, 60000);
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
