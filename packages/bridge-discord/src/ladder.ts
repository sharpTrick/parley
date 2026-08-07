import type { DiscordMessage } from './wire.js';

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

/** Rejects openSocket with this to tell the reconnect loop the close was terminal — do NOT retry. */
export class TerminalGatewayCloseError extends Error {}

/** What the gateway calls back into: the plugin's stopped flag and its two dispatch sinks. */
export interface GatewayHost {
  isStopped: () => boolean;
  onMessage: (m: DiscordMessage) => void;
  onSocketGone: () => void;
}

/**
 * The IDENTIFY budget every dial is paced by: one backoff ladder, one "not before" clock, and the
 * readiness memo both the live path and the blocking long-poll await.
 */
export abstract class GatewayLadder {
  /** Resolves once the gateway is IDENTIFYed and READY; first subscribe awaits it. */
  ready?: Promise<void>;
  /** Grows the delay 1s→2s→…→cap; RESET only by a socket up for {@link STABLE_CONNECTION_MS}. */
  reconnectAttempts = 0;
  /** {@link RECONNECT_CAP_MS} scaled by `gateway_dialers` — the fleet's share of ONE token's quota. */
  protected reconnectCapMs = RECONNECT_CAP_MS;
  /** Sticky from a TERMINAL close, so every later call fails fast instead of re-opening a socket. */
  protected fatal?: Error;
  /** Keep every dial behind this ONE budget, so no fast-retrying caller sets its own IDENTIFY rate. */
  protected nextDialAt = 0;
  /** Pending reconnect, cleared by {@link stop} so it cannot fire against the NEXT session. */
  protected reconnectTimer?: NodeJS.Timeout;
  /**
   * Bumped by every `connect()` and captured by each socket at open time. Keep every deferred
   * callback behind that capture, so that a close from a retired session cannot dial, re-IDENTIFY,
   * or clear state belonging to the NEXT one.
   */
  protected epoch = 0;
  /** Minimum delay the NEXT dial must honor; set by op 9 to Discord's mandated random 1–5 s. */
  protected invalidSessionWaitMs = 0;

  constructor(protected readonly host: GatewayHost) {}

  protected abstract dial(epoch: number): Promise<void>;
  protected abstract stopSocket(): void;

  /** Callers set their stopped flag FIRST, so a close this releases cannot dial on a dead session. */
  stop(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopSocket();
    this.ready = undefined;
    this.fatal = undefined;
  }

  get reconnectPending(): boolean {
    return this.reconnectTimer !== undefined;
  }

  protected resetLadder(reconnectCapMs: number): void {
    this.reconnectCapMs = reconnectCapMs;
    this.reconnectAttempts = 0;
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = 0;
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
      // Keep the OWNERSHIP check as well as the clock, so that the lateness every event loop hands
      // a timer — `nextDialAt` passes, the ladder's `setTimeout` has not run yet — cannot let a
      // re-entrant caller spend a rung the ladder has already charged for and then have the ladder
      // spend it again, doubling the IDENTIFY rate its whole point is to ration.
      if (this.reconnectTimer !== undefined) {
        throw new Error('Discord gateway dial refused: the reconnect ladder owns the next dial');
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
   * Charge one attempt against the shared IDENTIFY budget and return the delay it earned. Keep
   * EVERY path that opens a socket going through this, so the sustained dial rate is the ladder's
   * regardless of who initiated it.
   */
  protected chargeDialAttempt(): number {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempts++, this.reconnectCapMs);
    const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
    const wait = Math.max(this.invalidSessionWaitMs, backoff + jitter);
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = Date.now() + wait;
    return wait;
  }

  /**
   * Backoff-and-reopen loop (re-IDENTIFY, no RESUME) until disconnect(), spending the same dial
   * budget every other path spends ({@link chargeDialAttempt}). A terminal close short-circuits it
   * (openSocket rejects with TerminalGatewayCloseError).
   */
  protected scheduleReconnect(epoch: number): void {
    if (this.host.isStopped() || epoch !== this.epoch) return;
    const wait = this.chargeDialAttempt();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.host.isStopped() || epoch !== this.epoch) return;
      // Keep the memo assigned on the SAME tick as the dial, so that a re-entrant caller (core's
      // 250 ms long-poll fallback) landing after this fired joins this socket instead of opening a
      // second one; one landing before it is refused by ensureUp against `reconnectTimer`.
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
