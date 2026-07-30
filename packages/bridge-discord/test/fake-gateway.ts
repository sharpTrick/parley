/**
 * Scriptable in-process stand-in for the `ws` module, shared by every gateway suite. A test file
 * installs it with
 *
 *   vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));
 *
 * (async factory: `vi.mock` is hoisted above imports, so the class has to be pulled in inside it).
 * Every socket the plugin opens lands in {@link instances}; {@link state.onIdentify} scripts what
 * the "server" does when a socket sends op 2, which is where close codes, stalls and flaps are
 * driven from. Module state is per test FILE — call {@link resetGateway} in `beforeEach`.
 *
 * Like the real gateway, it REFUSES an IDENTIFY that does not carry the expected bot token (4004)
 * or that is missing a required intent bit (4014), a CONNECT url missing Discord's required
 * `v`/`encoding` query params (4012, before any HELLO), and a socket that does not answer a
 * server-initiated op 1 (4009) — keep those checks ahead of {@link state.onIdentify}, so that a
 * plugin change which stops sending one cannot be scripted past them.
 */
import { REQUIRED_INTENTS } from '../src/intents.js';

/** The CONNECT-url query Discord requires; a socket dialed without it never reaches HELLO. */
export const REQUIRED_GATEWAY_QUERY: Record<string, string> = { v: '10', encoding: 'json' };

export const gatewayQueryOk = (url: string): boolean => {
  try {
    const { searchParams } = new URL(url);
    return Object.entries(REQUIRED_GATEWAY_QUERY).every(([k, v]) => searchParams.get(k) === v);
  } catch {
    return false;
  }
};

export class FakeWs {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState: number = FakeWs.OPEN;
  sent: Array<{ op: number; d?: unknown }> = [];
  terminated = false;
  closedCode: number | undefined = undefined;
  ackHeartbeats = true;
  private readonly listeners: Record<string, Array<(arg: unknown) => void>> = {};
  private readonly unversioned: boolean;
  /** The `s` of the last dispatch this "server" sent — what a client heartbeat must echo. */
  private dispatchedSeq: number | null = null;

  constructor(readonly url: string) {
    this.unversioned = !gatewayQueryOk(url);
    instances.push(this);
  }

  on(event: string, cb: (arg: unknown) => void): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }
  private fire(event: string, arg?: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(arg);
  }

  // --- surface the plugin calls ---
  send(data: unknown): void {
    const frame = JSON.parse(String(data)) as { op: number; d?: unknown };
    this.sent.push(frame);
    if (frame.op === 2) {
      const d = (frame.d ?? {}) as { token?: unknown; intents?: unknown };
      if (d.token !== state.expectToken) {
        this.serverClose(4004);
        return;
      }
      const intents = typeof d.intents === 'number' ? d.intents : 0;
      if (state.requiredIntents.some((bit) => (intents & bit) === 0)) {
        this.serverClose(4014);
        return;
      }
      state.onIdentify(this);
      return;
    }
    if (frame.op === 1 && this.ackHeartbeats && this.readyState === FakeWs.OPEN) {
      this.serverSend({ op: 11 }); // heartbeat → ACK (unless the server has gone silent)
    }
  }
  close(code?: number): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.closedCode = code ?? 1000;
    this.emitClose(this.closedCode);
  }
  terminate(): void {
    this.terminated = true;
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.closedCode = 1006;
    this.emitClose(1006);
  }

  /**
   * Real `ws` delivers `close` on a later tick, never inside the call that caused it. Tests that
   * need that race set {@link state.asyncClose}; everything else keeps the inline delivery, which
   * is what makes close-driven suites readable under fake timers.
   */
  private emitClose(code: number): void {
    if (state.asyncClose) setTimeout(() => this.fire('close', code), 0);
    else this.fire('close', code);
  }

  // --- test-side "server" helpers ---
  serverSend(payload: Record<string, unknown>): void {
    if (this.unversioned) {
      this.serverClose(4012); // real Discord answers an unversioned connect, not the protocol
      return;
    }
    if (typeof payload.s === 'number') this.dispatchedSeq = payload.s;
    this.fire('message', Buffer.from(JSON.stringify(payload)));
  }
  /**
   * Discord probes a socket it suspects is dead with a server-initiated op 1 and closes one that
   * does not answer with its own op 1. Model the punishment here rather than in a case, so that a
   * client which stops answering loses every case that probes instead of only an assertion.
   */
  requestHeartbeat(): void {
    const before = this.heartbeatsSent();
    this.serverSend({ op: 1 });
    if (this.heartbeatsSent() === before) this.serverClose(4009);
  }
  /** The `d` of every heartbeat the client sent, oldest first — each must echo {@link seqSent}. */
  heartbeatSeqs(): unknown[] {
    return this.sent.filter((f) => f.op === 1).map((f) => f.d);
  }
  /** The last dispatch `s` this socket sent, or null when it has dispatched nothing. */
  seqSent(): number | null {
    return this.dispatchedSeq;
  }
  hello(interval: number): void {
    this.serverSend({ op: 10, d: { heartbeat_interval: interval } });
  }
  ready(): void {
    this.serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'fake' } });
  }
  /** Server-initiated close with an explicit gateway code (does NOT set `terminated`). */
  serverClose(code: number): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.closedCode = code;
    this.emitClose(code);
  }
  heartbeatsSent(): number {
    return this.sent.filter((f) => f.op === 1).length;
  }
  identified(): boolean {
    return this.sent.some((f) => f.op === 2);
  }
}

/** Every socket the plugin has opened, oldest first. */
export const instances: FakeWs[] = [];

/** The token every `vi.mock('ws')` suite connects with; the fake refuses any other. */
export const FAKE_TOKEN = 't';

/**
 * What the fake server does when a socket sends an ACCEPTED op 2 IDENTIFY (default: ack with
 * READY), the credential and capability bits it demands on that frame, and whether `close` events
 * are delivered inline or a macrotask later (see {@link FakeWs.emitClose}).
 */
export const state = {
  onIdentify: (ws: FakeWs) => ws.ready(),
  asyncClose: false,
  expectToken: FAKE_TOKEN as unknown,
  requiredIntents: Object.values(REQUIRED_INTENTS) as number[],
};

export function resetGateway(): void {
  instances.length = 0;
  state.onIdentify = (ws: FakeWs) => ws.ready();
  state.asyncClose = false;
  state.expectToken = FAKE_TOKEN;
  state.requiredIntents = Object.values(REQUIRED_INTENTS);
}

/** IDENTIFYs sent across ALL sockets — the quantity Discord's 1000/24h quota counts. */
export const totalIdentifies = (): number =>
  instances.reduce((n, ws) => n + ws.sent.filter((f) => f.op === 2).length, 0);

export const openSockets = (): FakeWs[] => instances.filter((ws) => ws.readyState === FakeWs.OPEN);
