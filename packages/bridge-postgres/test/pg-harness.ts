/**
 * The one real-server harness for this package's gated suites: the DSN, the reachability gate, the
 * admin connection, table cleanup and the backend-leak count.
 *
 * These were copied into eight files before, and copies drift — a second `isUp` with a longer
 * timeout, or a `dropTable` that forgets the trigger function, changes what a whole file is
 * actually asserting without a reviewer seeing it. `test/suite-hygiene.test.ts` keeps them here.
 */

import { Client } from 'pg';

export const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';

export const rand = (): string => Math.random().toString(36).slice(2, 8);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is a server reachable at `url`? Gates every real-server describe in this package. */
export async function isUp(url: string = PG_URL): Promise<boolean> {
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

/** Run `fn` on a throwaway direct connection, closed however `fn` ends. */
export async function withAdmin<T>(fn: (admin: Client) => Promise<T>, url = PG_URL): Promise<T> {
  const admin = new Client({ connectionString: url });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/**
 * Drop every relation the plugin derives from `table`. Keep the trigger function in here, so that a
 * later case reusing the same table name does not inherit a doorbell from the previous one.
 */
export async function dropTable(table: string, url = PG_URL): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    await admin.query(`DROP TABLE IF EXISTS "${table}_senders" CASCADE`);
    await admin.query(`DROP FUNCTION IF EXISTS "${table}_notify"() CASCADE`);
  }, url);
}

/** How many server backends carry `application_name` — this plugin's own, not the database's. */
export async function backendCount(appName: string): Promise<number> {
  return withAdmin(async (admin) => {
    const res = await admin.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
      [appName],
    );
    return (res.rows[0] as { n: number }).n;
  });
}

export async function terminateBackends(appName: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [appName],
    );
  });
}

/** Poll until this plugin's backends are gone, so a slow FIN is not reported as a leak. */
export async function settledBackendCount(appName: string, budgetMs = 3000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let n = await backendCount(appName);
  while (n > 0 && Date.now() < deadline) {
    await sleep(100);
    n = await backendCount(appName);
  }
  return n;
}
