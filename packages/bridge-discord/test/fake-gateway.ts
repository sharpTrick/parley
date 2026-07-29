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
 */

export class FakeWs {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState: number = FakeWs.OPEN;
  sent: Array<{ op: number; d?: unknown }> = [];
  terminated = false;
  closedCode: number | undefined = undefined;
  ackHeartbeats = true;
  private readonly listeners: Record<string, Array<(arg: unknown) => void>> = {};

  constructor(readonly url: string) {
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
      state.onIdentify(this); // IDENTIFY
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
    this.fire('message', Buffer.from(JSON.stringify(payload)));
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

/**
 * What the fake server does when a socket sends op 2 IDENTIFY (default: ack with READY), and
 * whether `close` events are delivered inline or a macrotask later (see {@link FakeWs.emitClose}).
 */
export const state = { onIdentify: (ws: FakeWs) => ws.ready(), asyncClose: false };

export function resetGateway(): void {
  instances.length = 0;
  state.onIdentify = (ws: FakeWs) => ws.ready();
  state.asyncClose = false;
}

/** IDENTIFYs sent across ALL sockets — the quantity Discord's 1000/24h quota counts. */
export const totalIdentifies = (): number =>
  instances.reduce((n, ws) => n + ws.sent.filter((f) => f.op === 2).length, 0);

export const openSockets = (): FakeWs[] => instances.filter((ws) => ws.readyState === FakeWs.OPEN);
