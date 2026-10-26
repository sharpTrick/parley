import { warn } from './diagnostics.js';
import type { DiscordMessage } from './wire.js';

/**
 * Discord's IDENTIFY allowance per BOT TOKEN, and the window it is measured over. The vendor's
 * numbers, not ours: nothing here can measure them, and the penalty for an overrun is a bot-token
 * RESET that breaks every Parley instance sharing that bot until a human re-provisions it. Every
 * pacing figure below is chosen against these two.
 */
export const IDENTIFY_QUOTA_PER_DAY = 1000;
export const IDENTIFY_QUOTA_WINDOW_MS = 86_400_000;

/** Reconnect backoff ceiling FOR ONE DIALER: what a gateway that never comes up costs. */
export const RECONNECT_CAP_MS = 120_000;

/**
 * How long a socket must stay up AFTER READY before its reconnect budget is forgiven, FOR ONE
 * DIALER.
 */
export const STABLE_CONNECTION_MS = 120_000;

/** How the two pacing figures above are shared out across the instances holding one bot token. */
export interface DialBudget {
  reconnectCapMs: number;
  stableConnectionMs: number;
}

/** One token's IDENTIFY budget, divided among the instances that share it. */
export function dialBudgetFor(dialers: number | undefined): DialBudget {
  const fanOut = dialers ?? 1;
  return {
    reconnectCapMs: RECONNECT_CAP_MS * fanOut,
    stableConnectionMs: STABLE_CONNECTION_MS * fanOut,
  };
}

/** IDENTIFYs one of `dialers` instances may send in any {@link IDENTIFY_QUOTA_WINDOW_MS}. */
export function identifyAllowanceFor(dialers: number | undefined): number {
  return Math.floor(IDENTIFY_QUOTA_PER_DAY / (dialers ?? 1));
}

/**
 * Every IDENTIFY this instance sent inside the trailing quota window, oldest first — the ONE thing
 * that decides whether another may be sent. The ladder's figures only pace dials, and a socket that
 * stays up long enough forgives them; this forgives nothing but time.
 */
export class IdentifyLedger {
  private spent: number[] = [];

  /** The earliest time one more IDENTIFY fits inside `allowance`. */
  admitsAt(now: number, allowance: number): number {
    // A spend stamped after `now` was made by a wall clock since stepped back; it happened no later
    // than now, and leaving it in the future would hold the next IDENTIFY past any timer's range.
    this.spent = this.spent.map((t) => Math.min(t, now)).filter((t) => t > now - IDENTIFY_QUOTA_WINDOW_MS);
    const over = this.spent.length - allowance;
    return over < 0 ? now : this.spent[over]! + IDENTIFY_QUOTA_WINDOW_MS;
  }

  /** Record one IDENTIFY if `allowance` has room for it, and say whether it did. */
  spend(now: number, allowance: number): boolean {
    if (this.admitsAt(now, allowance) > now) return false;
    this.spent.push(now);
    return true;
  }
}

/** First rung of the reconnect ladder, doubled per attempt up to {@link RECONNECT_CAP_MS}. */
export const BACKOFF_BASE_MS = 1000;
/** Random spread added to every ladder delay, so a fleet of bridges does not re-dial in lockstep. */
export const BACKOFF_JITTER_MS = 1000;
/** Discord's mandated re-IDENTIFY wait after op 9 INVALID SESSION: a random 1–5 s. */
export const INVALID_SESSION_MIN_WAIT_MS = 1000;
export const INVALID_SESSION_SPREAD_MS = 4000;

/** Rejects openSocket with this to tell the reconnect loop the close was terminal — do NOT retry. */
export class TerminalGatewayCloseError extends Error {}

/** What the gateway calls back into: the plugin's stopped flag and its dispatch sink. */
export interface GatewayHost {
  isStopped: () => boolean;
  onMessage: (m: DiscordMessage) => void;
}

/**
 * The IDENTIFY budget every dial is paced by: one backoff ladder, one "not before" clock, and the
 * readiness memo the live path awaits.
 */
export abstract class GatewayLadder {
  /** Resolves once the gateway is IDENTIFYed and READY; first subscribe awaits it. */
  ready?: Promise<void>;
  /** Grows the delay 1s→2s→…→cap; RESET only by a socket up for {@link STABLE_CONNECTION_MS}. */
  reconnectAttempts = 0;
  /** This instance's share of ONE token's quota: {@link dialBudgetFor} of `gateway_dialers`. */
  protected budget: DialBudget = dialBudgetFor(1);
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
  /** Outlives every `connect()`, so that no lifecycle call can hand the quota back. */
  protected readonly identifies = new IdentifyLedger();
  /** This instance's share of the ledger: {@link identifyAllowanceFor} of `gateway_dialers`. */
  protected identifyAllowance = identifyAllowanceFor(1);

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

  protected resetLadder(budget: DialBudget, identifyAllowance: number): void {
    this.budget = budget;
    this.identifyAllowance = identifyAllowance;
    this.reconnectAttempts = 0;
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = 0;
  }

  /**
   * Open the socket if it isn't up yet, and await READY — one memo, so every caller hooks the SAME
   * connection. Keep a failed dial CLEARING that memo, so that it cannot wedge every later caller on
   * a rejected promise; the ladder it joins is what paces the retry.
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
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempts++, this.budget.reconnectCapMs);
    const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
    const now = Date.now();
    const allowance = this.identifyAllowance;
    const quotaWait = this.identifies.admitsAt(now, allowance) - now;
    if (quotaWait > 0) {
      warn(
        `this instance's share of the bot token's IDENTIFY quota (${allowance} per ` +
          `${IDENTIFY_QUOTA_WINDOW_MS}ms) is spent; live push waits ${quotaWait}ms for the next dial`,
      );
    }
    const wait = Math.max(this.invalidSessionWaitMs, backoff + jitter, quotaWait);
    this.invalidSessionWaitMs = 0;
    this.nextDialAt = now + wait;
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
      // Keep the memo assigned on the SAME tick as the dial, so that a re-entrant caller landing
      // after this fired joins this socket instead of opening a second one; one landing before it
      // is refused by ensureUp against `reconnectTimer`.
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
