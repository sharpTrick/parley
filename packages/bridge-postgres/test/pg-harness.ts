/**
 * The one real-server harness for this package's gated suites: the DSN, the reachability gate, the
 * admin connection, table cleanup and the backend-leak count.
 *
 * These were copied into eight files before, and copies drift — a second `isUp` with a longer
 * timeout, or a `dropTable` that forgets the trigger function, changes what a whole file is
 * actually asserting without a reviewer seeing it. `test/suite-hygiene.test.ts` keeps them here.
 */

import { createServer, connect as tcpConnect, type Server, type Socket } from 'node:net';
import { Client } from 'pg';

export const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';

export const rand = (): string => Math.random().toString(36).slice(2, 8);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Report how `p` settled — or `'hung'` — within `budgetMs`, so a call that never comes back is
 * read as the hang it is instead of blowing the whole file's timeout with no diagnosis.
 */
export async function settleWithin(p: Promise<unknown>, budgetMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    p.then(
      () => 'resolved',
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    ),
    new Promise<string>((r) => {
      timer = setTimeout(() => r('hung'), budgetMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

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

/**
 * The failures a mocked driver cannot express, because they are properties of a SOCKET and not of
 * a call: a peer that completes the TCP handshake and then never speaks, and a peer that stops
 * answering mid-session without ever sending a FIN or an RST. Nothing in the pg API distinguishes
 * either from a server that is merely slow, which is exactly why a fake makes them disappear.
 *
 * Both listen on an OS-chosen port, so that concurrent runs against the same database cannot
 * collide on a hard-coded one.
 */
interface Fault {
  /** DSN that reaches the real database THROUGH this fault. */
  url: string;
  close: () => Promise<void>;
}

function listening(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function reroute(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.host = `127.0.0.1:${port}`;
  return parsed.toString();
}

function shutdown(server: Server, sockets: Socket[]): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
}

/** Accepts the connection and then says nothing, ever — a firewalled port or a stalled pooler. */
export async function silentPeer(url = PG_URL): Promise<Fault> {
  const held: Socket[] = [];
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    held.push(socket);
  });
  const port = await listening(server);
  return { url: reroute(url, port), close: shutdown(server, held) };
}

export interface FaultyProxy extends Fault {
  /**
   * Stop forwarding in BOTH directions on every connection — data AND the FIN. Swallowing the FIN
   * is what makes this a black hole rather than a slow link: forward it and the peer's kernel
   * answers with one of its own, `Client.end()` completes, and a teardown that would hang forever
   * against a real black hole finishes here and grades nothing.
   */
  blackhole: () => void;
  /** Forward again. Connections that lost bytes to the black hole stay protocol-desynced. */
  heal: () => void;
  /** Accept new connections and never dial upstream; established pairs keep working. */
  refuseNew: () => void;
  /** Undo {@link refuseNew}. Connections stranded while it was on stay stranded. */
  admitNew: () => void;
}

/** A TCP proxy in front of `url` whose behaviour can be changed under a live connection. */
export async function faultyProxy(url = PG_URL): Promise<FaultyProxy> {
  const upstream = new URL(url);
  const held: Socket[] = [];
  let blackholed = false;
  let admitting = true;
  // `allowHalfOpen` on both ends, so that closing one direction is this proxy's decision to
  // forward rather than Node's to mirror automatically.
  const server = createServer({ allowHalfOpen: true }, (down) => {
    held.push(down);
    down.on('error', () => undefined);
    if (!admitting) return;
    const up = tcpConnect({
      host: upstream.hostname,
      port: Number(upstream.port || 5432),
      allowHalfOpen: true,
    });
    held.push(up);
    up.on('error', () => undefined);
    down.on('data', (chunk) => {
      if (!blackholed) up.write(chunk);
    });
    up.on('data', (chunk) => {
      if (!blackholed) down.write(chunk);
    });
    down.on('end', () => {
      if (!blackholed) up.end();
    });
    up.on('end', () => {
      if (!blackholed) down.end();
    });
  });
  const port = await listening(server);
  return {
    url: reroute(url, port),
    blackhole: () => {
      blackholed = true;
    },
    heal: () => {
      blackholed = false;
    },
    refuseNew: () => {
      admitting = false;
    },
    admitNew: () => {
      admitting = true;
    },
    close: shutdown(server, held),
  };
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
