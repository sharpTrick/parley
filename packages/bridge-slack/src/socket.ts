import { plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import type { WebSocket } from 'ws';
import { SlackShapeError } from './api.js';
import type { SlackMessage } from './messages.js';

/** First and maximum rung of the cooldown between `apps.connections.open` dials. */
export const DIAL_BACKOFF_MS = 500;
export const MAX_DIAL_BACKOFF_MS = 5_000;

/**
 * How long a Socket Mode connection may stay silent after opening before we give up on `hello`.
 * Keep a bound here, so that a degraded edge that accepts the TCP connection and then says nothing
 * cannot park `subscribe` for the process lifetime.
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

export const closeQuietly = (ws: WebSocket): void => {
  try {
    ws.close();
  } catch {
    /* already closing/closed */
  }
};

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
