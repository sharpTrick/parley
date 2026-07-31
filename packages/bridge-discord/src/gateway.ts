import WebSocket from 'ws';
import type { DiscordBackendConfig } from './config.js';
import { reasonOf, shapeOf, warn } from './diagnostics.js';
import { INTENTS } from './intents.js';
import type { DiscordRest } from './rest.js';
import {
  dispatchedMessage,
  heartbeatIntervalOf,
  OP,
  type DiscordMessage,
  type GatewayPayload,
} from './wire.js';

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Reconnect backoff ceiling FOR ONE DIALER. Keep it above 86.4s (= 86400s / 1000) and multiplied by
 * the real `gateway_dialers` fan-out, so that a chronically flapping fleet stays under Discord's
 * 1000-IDENTIFY-per-24h PER-TOKEN quota — the penalty is a bot-token RESET that breaks every
 * Parley instance sharing that bot until a human re-provisions it.
 */
export const RECONNECT_CAP_MS = 120_000;

/**
 * How long a socket must stay up AFTER READY before its reconnect budget is forgiven. Keep it well
 * above zero, so that a gateway dropping straight after READY cannot re-IDENTIFY once a second.
 */
export const STABLE_CONNECTION_MS = 60_000;

/** First rung of the reconnect ladder, doubled per attempt up to {@link RECONNECT_CAP_MS}. */
export const BACKOFF_BASE_MS = 1000;
/** Random spread added to every ladder delay, so a fleet of bridges does not re-dial in lockstep. */
export const BACKOFF_JITTER_MS = 1000;
/** Discord's mandated re-IDENTIFY wait after op 9 INVALID SESSION: a random 1–5 s. */
export const INVALID_SESSION_MIN_WAIT_MS = 1000;
export const INVALID_SESSION_SPREAD_MS = 4000;

/**
 * Terminal close codes — auth (4004), intents (4013/4014), API version (4012), sharding
 * (4010/4011). Keep them OFF the ladder, so that a failure only a human can fix does not re-send
 * IDENTIFY per attempt and burn the 1000/24h budget whose penalty is a bot-token RESET.
 */
const TERMINAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Rejects openSocket with this to tell the reconnect loop the close was terminal — do NOT retry. */
export class TerminalGatewayCloseError extends Error {}

/**
 * The ONE shared gateway websocket per plugin instance, its heartbeat, and the reconnect ladder.
 * Protocol subset: HELLO (op 10) → heartbeat interval (op 1 echoing the last dispatch seq) and
 * IDENTIFY (op 2); READY (op 0) resolves the dial; op 11 acks are liveness only. RESUME is
 * deliberately SKIPPED — the push gap is harmless because cursor catch-up reconciles it (DESIGN §6).
 */
export class DiscordGateway {
  private token?: string;
  private urlOverride?: string;
  private handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS;
  /** {@link RECONNECT_CAP_MS} scaled by `gateway_dialers` — the fleet's share of ONE token's quota. */
  private reconnectCapMs = RECONNECT_CAP_MS;
  /** Sticky from a TERMINAL close, so every later call fails fast instead of re-opening a socket. */
  private fatal?: Error;
  private ws?: WebSocket;
  /** Resolves once the gateway is IDENTIFYed and READY; first subscribe awaits it. */
  ready?: Promise<void>;
  private live = false;
  /** One entry PER SOCKET, so a late HELLO on a superseded one cannot clear the live socket's beat. */
  readonly heartbeats = new Set<NodeJS.Timeout>();
  /** Last dispatch sequence number, echoed in heartbeats. */
  private seq: number | null = null;
  /** Grows the delay 1s→2s→…→cap; RESET only by a socket up for {@link STABLE_CONNECTION_MS}. */
  reconnectAttempts = 0;
  /** Keep every dial behind this ONE budget, so no fast-retrying caller sets its own IDENTIFY rate. */
  private nextDialAt = 0;
  /** Pending reconnect, cleared by {@link stop} so it cannot fire against the NEXT session. */
  private reconnectTimer?: NodeJS.Timeout;
  /**
   * Bumped by every `connect()` and captured by each socket at open time. Keep every deferred
   * callback behind that capture, so that a close from a retired session cannot dial, re-IDENTIFY,
   * or clear state belonging to the NEXT one.
   */
  private epoch = 0;
  /** Minimum delay the NEXT dial must honor; set by op 9 to Discord's mandated random 1–5 s. */
  private invalidSessionWaitMs = 0;

  constructor(
    private readonly rest: DiscordRest,
    private readonly host: {
      isStopped: () => boolean;
      onMessage: (m: DiscordMessage) => void;
      onSocketGone: () => void;
    },
  ) {}

  restart(cfg: DiscordBackendConfig, reconnectCapMs: number): void {
    this.epoch++;
    this.stop();
    this.token = cfg.token;
    this.urlOverride = cfg.gateway_url;
    this.handshakeTimeoutMs = cfg.handshake_timeout_ms ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.reconnectCapMs = reconnectCapMs;
    this.reconnectAttempts = 0;
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = 0;
    this.seq = null;
  }

  /** Callers set their stopped flag FIRST, so a close this releases cannot dial on a dead session. */
  stop(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const beat of this.heartbeats) clearInterval(beat);
    this.heartbeats.clear();
    this.ws?.close();
    this.ws = undefined;
    this.live = false;
    this.ready = undefined;
    this.fatal = undefined;
  }

  get reconnectPending(): boolean {
    return this.reconnectTimer !== undefined;
  }

  /**
   * Open the socket if it isn't up yet, and await READY — one memo for the live path and the
   * blocking long-poll alike, so the wait hooks the SAME connection. Keep a failed dial CLEARING
   * that memo, so that it cannot wedge every later caller on a rejected promise; the ladder it
   * joins is what paces the retry.
   */
  async ensureUp(): Promise<void> {
    if (this.fatal !== undefined) throw this.fatal;
    if (this.ready === undefined) {
      const wait = this.nextDialAt - Date.now();
      if (wait > 0) {
        throw new Error(`Discord gateway dial refused: backing off for another ${wait}ms`);
      }
      const epoch = this.epoch;
      this.ready = this.dial(epoch).catch((err: unknown) => {
        if (epoch === this.epoch) this.ready = undefined;
        if (err instanceof TerminalGatewayCloseError) this.chargeDialAttempt();
        else this.scheduleReconnect(epoch);
        throw err;
      });
    }
    await this.ready;
  }

  /**
   * A MESSAGE_CREATE-carrying socket exists RIGHT NOW — deliberately not the readiness memo, which
   * survives the reconnect cycle and would let a long-poll sleep its budget on a dead socket.
   */
  isLive(): boolean {
    return this.live && this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * One dial attempt, end to end: resolve the wss url (override for tests/fakes, else
   * `GET /gateway/bot` re-resolved per attempt) and open the socket. Keep URL RESOLUTION INSIDE the
   * attempt, so that the outage most likely at process start — a 5xx or 429 on `GET /gateway/bot` —
   * is not the one case with no in-plugin recovery.
   */
  private async dial(epoch: number): Promise<void> {
    const base = this.urlOverride ?? (await this.resolveUrl());
    await this.openSocket(gatewayDialUrl(base), epoch);
  }

  private async resolveUrl(): Promise<string> {
    const res = await this.rest.request('GET', '/gateway/bot');
    return ((await res.json()) as { url: string }).url;
  }

  /**
   * Charge one attempt against the shared IDENTIFY budget and return the delay it earned. Keep
   * EVERY path that opens a socket going through this, so the sustained dial rate is the ladder's
   * regardless of who initiated it.
   */
  private chargeDialAttempt(): number {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempts++, this.reconnectCapMs);
    const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
    const wait = Math.max(this.invalidSessionWaitMs, backoff + jitter);
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = Date.now() + wait;
    return wait;
  }

  private openSocket(url: string, epoch: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Keep this immediately before the socket exists, so that an await the dial path already ran
      // — the `GET /gateway/bot` lookup — cannot land a socket in a session that is already gone:
      // teardown could not reach a socket that did not exist yet, so it would spend an IDENTIFY,
      // install itself as `this.ws`, and arm a heartbeat no teardown will ever clear. `disconnect()`
      // leaves the epoch alone and `connect()` leaves `stopped` false, so both halves are needed.
      if (this.host.isStopped() || epoch !== this.epoch) {
        throw new Error('Discord gateway dial abandoned: its session was retired mid-dial');
      }
      const ws = new WebSocket(url);
      this.ws = ws;
      let ready = false;
      let readyAt = 0;
      let heartbeat: NodeJS.Timeout | undefined;
      let awaitedAck = false;
      let identified = false;
      // A socket Discord (or a proxy) accepts but never carries to READY would otherwise park
      // this promise forever — and with it subscribe(), bridge startup, and every blocking
      // fetchRecent that awaits the same gateway.
      const handshake = setTimeout(() => {
        if (ready) return;
        reject(
          new Error(
            `Discord gateway handshake timed out after ${this.handshakeTimeoutMs}ms (no READY)`,
          ),
        );
        ws.terminate();
      }, this.handshakeTimeoutMs);

      ws.on('message', (data) => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
          // Superseded, post-disconnect, or already closed by a branch below: such a socket owns
          // none of the shared state, and IDENTIFYing from here would spend budget on a connection
          // nothing reads. Keep the readyState half, so that a peer which keeps sending after we
          // closed cannot drive one diagnostic per frame while the close handshake finishes.
          ws.close();
          return;
        }
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(String(data)) as GatewayPayload;
        } catch {
          return; // not JSON — not ours to crash on
        }
        // Keep EVERY branch below inside this boundary, so that a frame no opcode branch expected
        // ends one socket instead of the process: a throw in a `ws` listener is an
        // uncaughtException, which takes the REST half and every other topic down with it.
        try {
          switch (payload.op) {
            case OP.HELLO: {
              // Discord sends exactly ONE HELLO per connection. Keep the IDENTIFY behind this flag,
              // so that a peer repeating HELLO on an open socket cannot spend the 1000/24h quota at
              // its own frame rate — the penalty is a bot-token RESET.
              if (identified) {
                warn(
                  'gateway sent a second HELLO on a socket that has already IDENTIFYed; ' +
                    'closing it so the ladder paces the next attempt',
                );
                ws.close();
                break;
              }
              const interval = heartbeatIntervalOf(payload.d);
              if (interval === undefined) {
                warn(
                  'gateway sent a HELLO with no usable heartbeat_interval ' +
                    `(${shapeOf(payload.d)}); closing the socket so the ladder retries`,
                );
                ws.close();
                break;
              }
              heartbeat = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (awaitedAck) {
                  // The previous beat was never ACKed (op 11) → the connection is half-dead. Keep
                  // terminate() and NOT close(), so that the `close` event fires immediately and the
                  // ladder takes over within ONE interval instead of buffering beats into a dead
                  // socket for the ~15–25 min kernel TCP timeout.
                  ws.terminate();
                  return;
                }
                // Arm BEFORE sending, so that an ACK arriving in the same tick clears the flag it
                // was meant to clear instead of being overwritten into a false "missed ack".
                awaitedAck = true;
                ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
              }, interval);
              this.heartbeats.add(heartbeat);
              identified = true;
              ws.send(
                JSON.stringify({
                  op: OP.IDENTIFY,
                  d: {
                    token: this.token ?? '',
                    intents: INTENTS,
                    properties: { os: 'linux', browser: 'parley', device: 'parley' },
                  },
                }),
              );
              break;
            }
            case OP.DISPATCH: {
              if (typeof payload.s === 'number') this.seq = payload.s;
              if (payload.t === 'READY' && !ready) {
                ready = true;
                readyAt = Date.now();
                this.live = true;
                clearTimeout(handshake);
                resolve();
              } else if (payload.t === 'MESSAGE_CREATE') {
                const d = dispatchedMessage(payload.d);
                if (d === undefined) {
                  warn(
                    `gateway sent a MESSAGE_CREATE with no usable id or channel_id (${shapeOf(
                      payload.d,
                    )}); dropping it`,
                  );
                  break;
                }
                this.host.onMessage(d);
              }
              break;
            }
            case OP.HEARTBEAT: {
              ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
              break;
            }
            case OP.RECONNECT: {
              ws.close();
              break;
            }
            case OP.INVALID_SESSION: {
              this.invalidSessionWaitMs =
                INVALID_SESSION_MIN_WAIT_MS + Math.floor(Math.random() * INVALID_SESSION_SPREAD_MS);
              ws.close();
              break;
            }
            case OP.HEARTBEAT_ACK: {
              awaitedAck = false;
              break;
            }
            default:
              break;
          }
        } catch (err) {
          warn(
            `gateway frame op ${String(payload.op)} could not be handled ` +
              `(${reasonOf(err)}); closing the socket so the ladder retries`,
          );
          ws.close();
        }
      });

      ws.on('error', () => {
        /* the paired close event drives teardown/reconnect; don't crash the process */
      });

      ws.on('close', (code: number) => {
        clearTimeout(handshake);
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          this.heartbeats.delete(heartbeat);
          heartbeat = undefined;
        }
        const terminal = TERMINAL_CLOSE.has(code);
        const err = terminal
          ? new TerminalGatewayCloseError(
              `Discord gateway closed with terminal code ${code} — check the bot token and the ` +
                'MESSAGE CONTENT privileged intent; live push is down until this bridge restarts',
            )
          : new Error(`Discord gateway closed before READY (code ${code})`);
        if (!ready) reject(err);
        // Keep every mutation below behind this check, so that a close delivered after the plugin
        // moved on — real `ws` emits it a tick late — cannot mark the NEXT session fatal.
        if (this.ws !== ws) return;
        this.ws = undefined;
        this.live = false;
        if (!this.host.isStopped()) {
          if (terminal) {
            this.ready = undefined;
            this.fatal = err;
            process.stderr.write(`parley-discord: ${err.message}\n`);
          } else if (ready) {
            if (Date.now() - readyAt >= STABLE_CONNECTION_MS) this.reconnectAttempts = 0;
            this.scheduleReconnect(epoch);
          }
        }
        // The socket that would have woken them is gone: release every blocked long-poll so it
        // re-queries REST now and hands the rest of its budget back to core's poll fallback.
        this.host.onSocketGone();
      });
    });
  }

  /**
   * Backoff-and-reopen loop (re-IDENTIFY, no RESUME) until disconnect(), spending the same dial
   * budget every other path spends ({@link chargeDialAttempt}). A terminal close short-circuits it
   * (openSocket rejects with TerminalGatewayCloseError).
   */
  private scheduleReconnect(epoch: number): void {
    if (this.host.isStopped() || epoch !== this.epoch) return;
    const wait = this.chargeDialAttempt();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.host.isStopped() || epoch !== this.epoch) return;
      // Dial through the memo every other caller awaits, so that a re-entrant caller (core's 250 ms
      // long-poll fallback) cannot open a second socket alongside this one and double the IDENTIFY
      // rate the ladder is pacing.
      const attempt = this.dial(epoch).catch((err: unknown) => {
        if (epoch === this.epoch) this.ready = undefined;
        if (!(err instanceof TerminalGatewayCloseError)) this.scheduleReconnect(epoch);
        throw err;
      });
      this.ready = attempt;
      void attempt.catch(() => undefined);
    }, wait);
  }
}

/**
 * The url actually dialed. Discord documents both params as REQUIRED on the CONNECT url and the one
 * `GET /gateway/bot` hands back carries NEITHER; keep them SET rather than defaulted, so that a
 * base carrying a stale `v` or an `encoding` this plugin cannot parse never decides the wire
 * format — an unversioned connect closes 4012, which is terminal, so the ladder stops and a
 * correctly provisioned bot never starts.
 */
function gatewayDialUrl(base: string): string {
  const url = new URL(base);
  url.searchParams.set('v', '10');
  url.searchParams.set('encoding', 'json');
  return url.toString();
}
