import { createClient } from 'redis';
import { endpointOf, errorText, fromServer, pluginError } from './diagnostics.js';

export type RedisClient = ReturnType<typeof createClient>;

/**
 * RESP error codes the server returns when it UNDERSTOOD a command and refused it — a bad argument,
 * a revoked ACL, a repurposed key. No retry clears one without an operator; everything else (socket
 * faults, `LOADING`, failover redirects) heals on its own and is retried.
 */
const PERMANENT_SERVER_ERROR = /^(ERR|NOAUTH|WRONGPASS|NOPERM|WRONGTYPE|NOPROTO|EXECABORT)\b/;

/**
 * The most recent `error` event per client. A handshake the SERVER rejected (`WRONGPASS`, a
 * TLS-only listener) reaches the caller as the reconnect strategy's generic unreachable message, so
 * the emitted `ErrorReply` is the only place the real cause survives.
 */
const lastEmittedError = new WeakMap<object, Error>();

/**
 * The connection every parley-redis socket is built from — the command client, the readers, and any
 * test probe. Exported so a harness cannot be configured more defensively than the code under test.
 *
 * Keep the pre-`ready` `Error` return, so that `connect()` REJECTS against an unreachable or wrong
 * endpoint; node-redis' default strategy retries forever and leaves `connect()` pending for the
 * life of the process. After the first handshake it switches to bounded backoff, so a live
 * connection still rides out an outage. Keep `disableOfflineQueue`, so that commands issued while
 * disconnected REJECT instead of being queued for the outage — a `parley_post` must fail, not hang
 * unbounded.
 */
export function createRedisClient(url: string, connectTimeoutMs: number): RedisClient {
  let handshakeComplete = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: (retries: number) =>
        handshakeComplete
          ? Math.min(50 * 2 ** retries, 2000)
          : pluginError(unreachable(url, connectTimeoutMs)),
    },
  });
  client.on('ready', () => {
    handshakeComplete = true;
  });
  client.on('error', (err: unknown) => {
    // The offline queue is disabled, so faults surface as command rejections; don't crash.
    if (err instanceof Error) lastEmittedError.set(client, err);
  });
  return client;
}

/** The RESP error the server answered with, if the failure was a refusal rather than a socket fault. */
export function serverRefusal(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : '';
  return PERMANENT_SERVER_ERROR.test(message) ? message : undefined;
}

/**
 * The one message every failed-to-come-up path reports, so which watchdog fired first — the
 * socket's `connectTimeout`, the reconnect strategy or the whole-handshake deadline — is not
 * observable to a caller who only needs to know the endpoint is unusable.
 */
export function unreachable(url: string, connectTimeoutMs: number): string {
  return `parley-redis: cannot reach ${endpointOf(url)} (connect_timeout_ms=${connectTimeoutMs})`;
}

/**
 * Bound a handshake END TO END, so that an endpoint which completes the TCP connection and then
 * never speaks Redis (a hung server, a load balancer in front of a dead backend, a non-Redis port)
 * cannot leave the bridge pending forever: node-redis' `connectTimeout` covers socket establishment
 * only, leaving the protocol handshake after it with no watchdog of its own.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(pluginError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The command client, connected and proven to answer. Verify one COMMAND, not just the handshake:
 * node-redis reports a password-protected server reached without credentials as a successful
 * connect, so without the `PING` the bridge comes up "connected" and every seam call fails
 * afterwards — invisibly when catchup.on_start is off. A refusal is reported apart from an
 * unreachable endpoint, so that a `WRONGPASS` does not send an operator to look at the network.
 */
export async function openCommandClient(
  url: string,
  connectTimeoutMs: number,
): Promise<RedisClient> {
  const client = createRedisClient(url, connectTimeoutMs);
  try {
    await withDeadline(client.connect(), connectTimeoutMs, unreachable(url, connectTimeoutMs));
    await withDeadline(
      client.ping(),
      connectTimeoutMs,
      `parley-redis: connected to ${endpointOf(url)} but it did not answer PING within ` +
        `connect_timeout_ms=${connectTimeoutMs}`,
    );
  } catch (err) {
    const respError = serverRefusal(err) ?? serverRefusal(lastEmittedError.get(client));
    await client.disconnect().catch(() => undefined);
    throw pluginError(
      respError !== undefined
        ? `parley-redis: connected to ${endpointOf(url)} but the server refused a command: ` +
          fromServer(url, respError)
        : fromServer(url, errorText(err)),
    );
  }
  return client;
}
