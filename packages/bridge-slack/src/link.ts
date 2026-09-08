import { type MessageHandler, safeDeliver, type Topic } from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import { WebSocket, type RawData } from 'ws';
import type { SlackApiCall } from './api.js';
import { requireUsableSocketUrl, type SlackSettings } from './config.js';
import { slackToMessage } from './markup.js';
import { isPlainMessage } from './messages.js';
import {
  closeQuietly,
  DIAL_BACKOFF_MS,
  MAX_DIAL_BACKOFF_MS,
  type SocketEnvelope,
} from './socket.js';

/** The plugin, as the link sees it: the live configuration and which session is still current. */
interface SocketHost {
  settings: () => SlackSettings;
  stopped: () => boolean;
  session: () => number;
}

interface Route {
  topic: Topic;
  handler: MessageHandler;
}

/**
 * ONE shared Socket Mode websocket per plugin instance, opened lazily on the first subscribe: the
 * routes it feeds, and the dial pacer that spaces `apps.connections.open` when it is unavailable.
 *
 * Ascending-`ts` handler invocation is a PLUGIN guarantee and nothing here orders anything: it
 * rests on ONE connection feeding a channel, which a rotation deliberately suspends. Keep
 * {@link DEFAULT_ROTATION_GRACE_MS} bounding that overlap, so that the exposure is the handful of
 * seconds Slack asks for and not the process lifetime.
 */
export class SocketModeLink {
  private ws?: WebSocket;
  /**
   * Every socket this link has open, which during a rotation is MORE than {@link ws}. Keep
   * teardown reading this set rather than that field, so that a `disconnect()` inside the rotation
   * grace cannot leave an established connection nothing will ever close — it goes on acking
   * envelopes to Slack against a bridge that has cleared its routes.
   */
  private readonly sockets = new Set<WebSocket>();
  /** Pending/established socket, resolved once the current connection has seen `hello`. */
  private wsReady?: Promise<void>;
  /** channel id → the topic + handler it feeds (Socket Mode events carry the channel id). */
  readonly routes = new Map<string, Route>();
  /** Earliest wall clock at which a dial may go out — see {@link ensureSocket}. */
  private dialCooldownUntil = 0;
  private dialBackoffMs = DIAL_BACKOFF_MS;
  /** When the current connection saw `hello`, or 0 — the pacer's "has it served yet?" clock. */
  private servingSince = 0;
  /** Whether a {@link reconnect} loop already owns re-establishing the shared socket. */
  private reconnecting = false;
  /** Sockets that have already spent their one pre-refresh rotation — see {@link routeEnvelope}. */
  private readonly rotating = new WeakSet<WebSocket>();

  constructor(
    private readonly api: SlackApiCall,
    private readonly host: SocketHost,
  ) {}

  /** A new session dials on a fresh pacer: the last one's outage was its own. */
  reset(): void {
    this.dialCooldownUntil = 0;
    this.dialBackoffMs = DIAL_BACKOFF_MS;
    this.servingSince = 0;
  }

  /** Callers retire their session FIRST, so that nothing this releases acts on the next one. */
  stop(): void {
    // The reconnect owner is cleared here too, so the next session can own its own loop.
    this.reconnecting = false;
    this.routes.clear();
    this.wsReady = undefined;
    for (const ws of [...this.sockets]) closeQuietly(ws);
    this.sockets.clear();
    this.ws = undefined;
  }

  /**
   * The shared socket, opened lazily on the first subscribe; resolves once `hello` is in. A
   * reactive-only deployment configures no `app_token`; keep that named rejection HERE rather than
   * in one caller, so that no caller dials `apps.connections.open` to be answered `not_authed`
   * every time, under an error naming neither `app_token` nor Socket Mode.
   *
   * The dial pacer is read HERE for the same reason: every route to a dial goes through this
   * method, so a caller that retries — its own loop, or a second entry point added later — cannot
   * turn an unavailable Socket Mode into a dial per attempt against Slack's tightest-limit
   * endpoint.
   *
   * A caller inside the cooldown WAITS it out rather than being turned away. Refusing it reports
   * the pacer where the outage belongs: core rethrows a failed `subscribe`, so a bridge whose
   * socket had dropped once failed to come up naming a backoff instead of Slack. Waiting also joins
   * whatever reconnect is already in flight — it publishes into `wsReady`, which is what the loop
   * below re-reads — so a live socket that comes back during the wait is the one this caller gets.
   */
  async ensureSocket(): Promise<void> {
    if (this.host.settings().appToken === undefined) {
      throw new Error('Slack Socket Mode needs an app_token; this deployment has no live push');
    }
    while (this.wsReady === undefined && Date.now() < this.dialCooldownUntil) {
      if (this.host.stopped()) {
        throw new Error('Slack Socket Mode dialling abandoned; the plugin was disconnected');
      }
      await delay(this.dialCooldownUntil - Date.now());
    }
    if (this.wsReady === undefined) {
      const session = this.host.session();
      const attempt = this.openSocket();
      this.wsReady = attempt;
      // Memoize the connection, never the FAILURE: a cached rejection is replayed by every later
      // caller without touching the network, so one transient dial error would disable live push
      // for the process lifetime. Keep this scoped to the session that dialled, so that a dial
      // outliving a `disconnect()` cannot hand the NEXT session a cooldown it never earned.
      attempt.catch(() => {
        if (this.host.session() !== session) return;
        if (this.wsReady === attempt) this.wsReady = undefined;
        this.backOffDialling();
      });
    }
    return this.wsReady;
  }

  private backOffDialling(): void {
    this.dialCooldownUntil = Date.now() + this.dialBackoffMs;
    this.dialBackoffMs = Math.min(this.dialBackoffMs * 2, MAX_DIAL_BACKOFF_MS);
  }

  /**
   * Account for the current connection ending: a rung back if it SERVED for at least one, another
   * rung of backoff if it did not. Keep the ladder keyed on time served rather than on a completed
   * handshake, so that an edge which accepts, greets and drops cannot redial at its own round-trip
   * rate: every one of its dials SUCCEEDS, so a ladder only failures advance is one it never climbs.
   */
  private noteConnectionEnded(): void {
    const servedFor = this.servingSince === 0 ? 0 : Date.now() - this.servingSince;
    this.servingSince = 0;
    if (servedFor < DIAL_BACKOFF_MS) {
      this.backOffDialling();
      return;
    }
    this.dialCooldownUntil = 0;
    this.dialBackoffMs = DIAL_BACKOFF_MS;
  }

  private async openSocket(): Promise<void> {
    const session = this.host.session();
    // Socket Mode handshake uses the APP token; everything else uses the bot token.
    const open = await this.api<{ ok: boolean; url?: unknown }>('apps.connections.open', {}, 'app');
    // Keep this abort scoped to the SESSION as well as to `stopped` — which the next `connect()`
    // clears — so that a dial in flight across `disconnect()` + `connect()` cannot open a socket on
    // the retired app_token for a session that subscribed to nothing: it would burn one of the ~10
    // connections per app token and feed a second event source into one channel for the session's
    // life, which is what the ascending-`ts` handler guarantee rests on not happening.
    if (this.host.stopped() || this.host.session() !== session) {
      throw new Error('Slack Socket Mode connect aborted — plugin disconnected');
    }
    const { apiUrl, handshakeTimeoutMs } = this.host.settings();
    const url = requireUsableSocketUrl(apiUrl, open.url);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      this.sockets.add(ws);
      let settled = false;
      let helloSeen = false;
      let handshake: ReturnType<typeof setTimeout>;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        if (err === undefined) resolve();
        else reject(err);
      };
      // The only other exit from this promise is a message the peer may never send.
      handshake = setTimeout(() => {
        settle(new Error(`Slack Socket Mode sent no hello within ${handshakeTimeoutMs}ms`));
        closeQuietly(ws);
      }, handshakeTimeoutMs);
      ws.on('message', (data: RawData) => {
        this.onEnvelope(ws, data, () => {
          helloSeen = true;
          if (this.ws === ws) this.servingSince = Date.now();
          settle();
        });
      });
      ws.on('error', (err: Error) => {
        settle(err);
      });
      ws.on('close', () => {
        this.sockets.delete(ws);
        // Keep this settle AHEAD of the stopped/superseded return, so that a teardown closing the
        // socket always releases the callers awaiting the handshake instead of parking them for the
        // process lifetime. Keep it a bare reject — the owning caller retries.
        settle(new Error('Slack Socket Mode connection closed before hello'));
        if (this.host.stopped() || this.ws !== ws) return;
        // Socket Mode URLs are SINGLE-USE: never redial the old URL.
        this.wsReady = undefined;
        // Keep this gated on `helloSeen` rather than on which call settled the handshake, so that a
        // handshake timeout or a websocket `error` — both of which settle it BEFORE the close they
        // cause — cannot be read as a live connection dropping and be handed a reconnect owner.
        if (!helloSeen) return;
        this.noteConnectionEnded();
        void this.reconnect();
      });
    });
  }

  /**
   * Re-establish the shared socket on the shared dial pacer until stopped. Keep this single-owner,
   * so that a close arriving while a loop is already retrying cannot start a second loop: every
   * loop dials `apps.connections.open` and their failures compound instead of backing off. The
   * pacer it waits on is advanced by {@link noteConnectionEnded} as well as by a failed dial, so
   * that an edge whose dials all SUCCEED is spaced by the same ladder as one that refuses them.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const session = this.host.session();
    try {
      while (!this.host.stopped() && this.host.session() === session) {
        const cooling = this.dialCooldownUntil - Date.now();
        if (cooling > 0) {
          await delay(cooling);
          continue;
        }
        try {
          await this.ensureSocket();
          return;
        } catch {
          // Keep a floor of our own here, so that a rejection which never reaches the failure arm
          // above — a token withdrawn under a running session — cannot spin this loop hot.
          if (this.dialCooldownUntil <= Date.now()) this.backOffDialling();
        }
      }
    } finally {
      // Only while this loop is still the session's owner: a later session has its own.
      if (this.host.session() === session) this.reconnecting = false;
    }
  }

  /**
   * One Socket Mode envelope. Keep the ack FIRST, before any processing, so that neither a
   * dropped subtype, an unrouted channel, nor a throwing handler can starve it — Slack redelivers
   * an unacked envelope and eventually drops the connection.
   */
  private onEnvelope(ws: WebSocket, data: RawData, onHello: () => void): void {
    let env: SocketEnvelope;
    try {
      env = JSON.parse(String(data)) as SocketEnvelope;
    } catch {
      return; // not JSON — nothing to ack, nothing to route
    }
    if (typeof env !== 'object' || env === null) return;
    if (typeof env.envelope_id === 'string') {
      try {
        ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch {
        /* socket already closing; redelivery on the next connection covers it */
      }
    }
    // Keep the whole post-ack body inside this catch, so that a malformed envelope throwing into a
    // socket callback — where there is no caller to propagate to and node exits — cannot happen.
    try {
      this.routeEnvelope(ws, env, onHello);
    } catch {
      /* an inbound envelope is untrusted input; drop it, keep the socket serving */
    }
  }

  private routeEnvelope(ws: WebSocket, env: SocketEnvelope, onHello: () => void): void {
    if (env.type === 'hello') {
      onHello();
      return;
    }
    if (env.type === 'disconnect') {
      // `reason: 'warning'` is Slack's ~10 s notice ahead of a routine refresh, sent precisely so a
      // client can establish the replacement FIRST and drain this socket. Closing on it converts a
      // zero-gap rotation into a dial-round-trip gap, and `subscribe` restarts at the tail, so
      // every event in that gap is lost to the live path for good.
      if (env.reason === 'warning') {
        // An envelope is untrusted input: one rotation per socket, and never while a reconnect owner
        // is already dialling, so that a flood of warnings cannot become a flood of handshakes.
        if (this.ws !== ws || this.reconnecting || this.rotating.has(ws)) return;
        this.rotating.add(ws);
        this.wsReady = undefined;
        // The grace is Slack's to open and OURS to close: an edge that never closes its half would
        // otherwise leave one established connection behind per rotation — against the ~10 per app
        // token, and against a channel's ordering, which holds only while one connection feeds it.
        const grace = setTimeout(() => closeQuietly(ws), this.host.settings().rotationGraceMs);
        ws.once('close', () => clearTimeout(grace));
        void this.reconnect();
        return;
      }
      // Keep this a close rather than a direct redial, so that the `close` handler stays the ONE
      // place a fresh single-use URL is minted and a rotation cannot race a reconnect owner.
      closeQuietly(ws);
      return;
    }
    if (env.type !== 'events_api') return;
    const event = env.payload?.event;
    if (!isPlainMessage(event) || typeof event.channel !== 'string') return;

    const route = this.routes.get(event.channel);
    if (route === undefined) return;
    safeDeliver(route.handler, () =>
      slackToMessage(route.topic, event, this.host.settings().mentionMap),
    );
  }
}
