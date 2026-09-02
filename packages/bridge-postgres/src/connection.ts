import { Pool, type PoolClient } from 'pg';
import { LOCK_WAIT_MS } from './errors.js';

/**
 * Ceiling on a pg `connect()`. On a Pool this bounds the whole acquire — the dial AND the wait for
 * a free connection — so keep it well above {@link LOCK_WAIT_MS}, so that a `post()` sitting out
 * its documented lock wait with a connection checked out cannot turn a reader queued behind it into
 * an acquire failure.
 */
export const CONNECT_WAIT_MS = 3 * LOCK_WAIT_MS;

/**
 * Ceiling on a DIAL that cannot be queueing behind anything: the bootstrap checkout, taken out of
 * a pool nobody else holds a connection in. Kept far under {@link CONNECT_WAIT_MS} because none of
 * the reasons that one has to be generous apply — nothing is holding a connection yet, so a wait
 * here is a peer that is not answering. (The listener socket has its own, `LISTENER_WAIT_MS`, which
 * is the same wait a seam call already gives it.)
 */
export const DIAL_WAIT_MS = 5000;

/**
 * Client-side ceiling on one statement. `statement_timeout` cannot stand in for it: what this
 * bounds is the server's ANSWER never arriving — a half-open socket, a black-holing pooler — which
 * the server has no way to notice. Above {@link LOCK_WAIT_MS} for the same reason as
 * {@link CONNECT_WAIT_MS}: every lock this plugin takes is already bounded server-side, and a
 * shorter client bound would pre-empt that with a message naming neither the lock nor the topic.
 */
export const QUERY_WAIT_MS = 3 * LOCK_WAIT_MS;

/** TCP keepalive idle time, so a peer that vanished without a FIN becomes an error, not silence. */
export const KEEPALIVE_DELAY_MS = 10_000;

/** Ceiling on the whole of `disconnect()` — see {@link endWithin}. */
export const TEARDOWN_WAIT_MS = 5000;

/** How long a destroyed socket gets to finish unwinding before teardown stops waiting on it. */
const DESTROY_GRACE_MS = 250;

/**
 * The bounds every socket this plugin opens carries — the pool's and the listener's alike. Keep
 * them together, so that a connection added later cannot be the one with no ceiling on it.
 */
export const SOCKET_BOUNDS = Object.freeze({
  connectionTimeoutMillis: CONNECT_WAIT_MS,
  query_timeout: QUERY_WAIT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
});

export interface Closeable {
  end: () => Promise<unknown>;
}

/**
 * A driver's socket, reached through as many optional hops as it puts in the way. Keep every hop
 * optional, so that a driver that renames one leaves {@link endWithin} bounded by its deadline
 * instead of throwing inside `disconnect()`.
 */
interface Stream {
  destroyed?: boolean;
  destroy?: () => void;
  once?: (event: string, listener: () => void) => void;
}

/**
 * Every client a pool has dialled and not finished closing. pg-pool empties its own client array
 * SYNCHRONOUSLY when `end()` starts and only afterwards calls `end()` on each client, so a pool
 * whose peer stopped answering RESOLVES its `end()` with every socket it opened still live and
 * nothing left on the pool to reach them through. Keep this fed from the pool's own documented
 * events, so that a teardown can.
 */
const poolClients = new WeakMap<object, Set<PoolClient>>();

/**
 * The one place this plugin opens a pool. Keep it here with {@link SOCKET_BOUNDS}, so that a pool
 * added by a later path cannot be the one whose sockets a teardown has no way to close.
 */
export function openPool(url: string, max: number): Pool {
  const pool = new Pool({ connectionString: url, max, ...SOCKET_BOUNDS });
  const live = new Set<PoolClient>();
  poolClients.set(pool, live);
  pool.on('connect', (client) => live.add(client));
  pool.on('remove', (client) => live.delete(client));
  return pool;
}

/** The sockets `resource` is still holding: a pool's, through the clients it owns, or its own. */
function streamsOf(resource: Closeable): Stream[] {
  const clients = poolClients.get(resource);
  const holders: unknown[] = clients === undefined ? [resource] : [...clients];
  return holders
    .map((holder) => (holder as { connection?: { stream?: Stream } }).connection?.stream)
    .filter((stream): stream is Stream => stream !== undefined && stream !== null);
}

/**
 * Resolves once every socket `resource` holds right now is gone. A driver `end()` that has resolved
 * is not that: pg-pool's resolves as soon as it has let go of its clients, whether or not their
 * sockets ever closed.
 */
function socketsClosed(resource: Closeable): Promise<void> {
  const gone = streamsOf(resource).map(
    (stream) =>
      new Promise<void>((resolve) => {
        if (stream.destroyed === true || stream.once === undefined) resolve();
        else stream.once('close', resolve);
      }),
  );
  return Promise.all(gone).then(() => undefined);
}

async function settledWithin(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * pg offers no supported force-close, and these are the sockets `pg-pool` destroys itself when its
 * own connection timeout fires.
 */
function destroySocket(resource: Closeable): void {
  for (const stream of streamsOf(resource)) stream.destroy?.();
}

/**
 * Close `resource`, abandoning the graceful close after `budgetMs`. A peer that stops answering
 * without closing the socket never completes a pg `end()`: it writes Terminate and waits for a FIN
 * that is not coming, and `disconnect()` awaits that. Keep the give-up path DESTROYING the socket
 * rather than merely walking away, so that a bounded teardown does not trade a hung shutdown for a
 * live connection holding a server backend for the life of the process.
 */
export async function endWithin(resource: Closeable, budgetMs: number): Promise<void> {
  const ended = resource.end().then(
    () => undefined,
    () => undefined,
  );
  const closed = Promise.all([ended, socketsClosed(resource)]).then(() => undefined);
  if (await settledWithin(closed, budgetMs)) return;
  destroySocket(resource);
  await settledWithin(closed, DESTROY_GRACE_MS);
}
