import { plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import type { WebSocket } from 'ws';
import { SlackShapeError } from './api.js';
import type { SlackMessage } from './messages.js';

/**
 * First and maximum rung of the degraded-Socket-Mode ladder: the cooldown between poll-driven
 * `apps.connections.open` dials, and the interval at which a blocked `fetchRecent` re-reads
 * `conversations.history` for as long as the live stream has delivered it nothing.
 */
export const DIAL_BACKOFF_MS = 500;
export const MAX_DIAL_BACKOFF_MS = 5_000;

/**
 * How long a Socket Mode connection may stay silent after opening before we give up on `hello`.
 * Keep a bound here, so that a degraded edge that accepts the TCP connection and then says nothing
 * cannot park `subscribe` and every blocking `fetchRecent` for the process lifetime.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How long a socket handed a `disconnect: warning` may stay open once its replacement is being
 * dialled. Slack states the notice as ~10 s; keep a bound of our own here, so that an edge which
 * never closes leaves neither a connection per rotation nor a second event source on one channel.
 */
export const DEFAULT_ROTATION_GRACE_MS = 10_000;

/** A Socket Mode envelope (the subset we route on). */
export interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  /** Only on a `disconnect` envelope: `warning` (a pre-refresh notice) / `refresh_requested` / …. */
  reason?: string;
  payload?: { event?: SlackMessage };
}

/**
 * A pending native long-poll (`fetchRecent` with `blockMs`) parked on the shared Socket Mode
 * stream. `since` is the exclusive floor (`ts`) it is waiting past; `wake` fires exactly once and
 * tears down its own timer + registration (no leaked listeners/timers).
 */
export interface Waiter {
  since: string;
  wake: () => void;
}

export const closeQuietly = (ws: WebSocket): void => {
  try {
    ws.close();
  } catch {
    /* already closing/closed */
  }
};

/**
 * Time until the next rung of the degradation ladder, given how long a blocked call has been parked:
 * rungs start at 0, {@link DIAL_BACKOFF_MS}, and each subsequent doubling capped at
 * {@link MAX_DIAL_BACKOFF_MS}. Keep the position derived from WALL CLOCK rather than counted per
 * iteration, so that an early wake (a socket loss draining the waiters) cannot advance the ladder and
 * push the next history re-read further out than the rung it was due on.
 */
export function nextRungIn(elapsedMs: number): number {
  let at = 0;
  let width = DIAL_BACKOFF_MS;
  while (at + width <= elapsedMs) {
    at += width;
    width = Math.min(width * 2, MAX_DIAL_BACKOFF_MS);
  }
  return at + width - elapsedMs;
}

/**
 * Reject once `ms` has passed, so a caller with its own budget can bound a wait it does not own.
 * `p` stays subscribed by the race, so a later rejection of it is never unhandled.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The websocket URL `apps.connections.open` handed us, or a named refusal. A vendor response is
 * untrusted input, not an authorization: this URL carries the single-use Socket Mode ticket, every
 * workspace message and every ack, so it is held to no weaker a transport guarantee than the one
 * the operator configured for the Web API. `ws:` therefore passes only where a plaintext `api_url`
 * would, and never silently downgrades an `https:` workspace toward a host nobody configured.
 */
export function requireUsableSocketUrl(apiUrl: string, url: unknown): string {
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
    throw new SlackShapeError('apps.connections.open', 'returned no usable websocket url');
  }
  const insecure = plaintextRemoteOrigin(url);
  if (insecure !== undefined && plaintextRemoteOrigin(apiUrl) === undefined) {
    throw new SlackShapeError(
      'apps.connections.open',
      `returned ${insecure}, a plaintext websocket to a non-loopback host, while ` +
        `backend_config.api_url ${apiUrl} is not — refusing to downgrade the live stream`,
    );
  }
  return url;
}
