import { asTopic, type MessageHandler, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-07 (reconnect storm resets the bot token) + BUG-20 (half-dead socket goes undetected) are
// both in the gateway-socket machinery. They're driven here against an in-process FAKE gateway
// (the `ws` module is mocked to a scriptable FakeWs, mirroring the XMPP suite's transport mock) so
// close codes, backoff timers, op 9, and heartbeat-ACK timing are all deterministic under fake
// timers — no real Discord, no real sockets.

const gw = vi.hoisted(() => {
  const instances: FakeWs[] = [];
  // What the fake server does when a socket sends op 2 IDENTIFY (default: ack with READY).
  const state = { onIdentify: (ws: FakeWs) => ws.ready() };

  class FakeWs {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = FakeWs.OPEN;
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
      this.fire('close', this.closedCode);
    }
    terminate(): void {
      this.terminated = true;
      if (this.readyState === FakeWs.CLOSED) return;
      this.readyState = FakeWs.CLOSED;
      this.closedCode = 1006;
      this.fire('close', 1006);
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
      this.fire('close', code);
    }
    heartbeatsSent(): number {
      return this.sent.filter((f) => f.op === 1).length;
    }
  }

  return { instances, state, FakeWs };
});

vi.mock('ws', () => ({ default: gw.FakeWs }));

// Imported after the mock is declared; vitest hoists vi.mock above all imports regardless.
import { DiscordPlugin } from '../src/index.js';

type FakeWs = InstanceType<typeof gw.FakeWs>;

const HUGE_HB = 1_000_000; // large enough that the heartbeat interval never fires during a test

const totalIdentifies = (): number =>
  gw.instances.reduce((n, ws) => n + ws.sent.filter((f) => f.op === 2).length, 0);

/** Open the shared socket and drive HELLO→IDENTIFY→READY on the freshly created FakeWs. */
async function reachReady(
  plugin: DiscordPlugin,
  topic: Topic,
  opts?: { hb?: number; handler?: MessageHandler },
): Promise<FakeWs> {
  const pending = plugin.subscribe(topic, opts?.handler ?? (() => undefined));
  const ws = gw.instances.at(-1)!; // created synchronously inside subscribe()→openSocket
  ws.hello(opts?.hb ?? HUGE_HB);
  await pending;
  return ws;
}

const setTimeoutDelays = (spy: ReturnType<typeof vi.spyOn>): number[] =>
  spy.mock.calls.map((c) => c[1] as number);

describe('Discord gateway reconnect & liveness (BUG-07, BUG-20)', () => {
  beforeEach(() => {
    gw.instances.length = 0;
    gw.state.onIdentify = (ws: FakeWs) => ws.ready();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('BUG-07: a terminal close (4014) stops the reconnect storm — gatewayReady cleared, no re-IDENTIFY flood', async () => {
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

    const ws0 = await reachReady(plugin, asTopic('123'));
    expect(totalIdentifies()).toBe(1);

    // From now on, every attempt is rejected with a TERMINAL 4014 right after IDENTIFY.
    gw.state.onIdentify = (ws: FakeWs) => ws.serverClose(4014);

    // A transient drop kicks off the reconnect loop; the very next attempt hits 4014.
    ws0.serverClose(1006);

    // Let plenty of "time" pass, driving each freshly opened socket. Under the OLD code this
    // re-IDENTIFYs every ~500 ms forever; under the fix it stops after a single terminal attempt.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(70_000); // > the 60 s cap → fires any pending reconnect
      const ws = gw.instances.at(-1)!;
      if (ws.readyState === gw.FakeWs.OPEN) ws.hello(HUGE_HB);
    }

    // At most ONE post-READY IDENTIFY (the single reconnect that hit 4014), then the loop halts.
    expect(totalIdentifies()).toBeLessThanOrEqual(2);
    // Readiness is cleared so a DELIBERATE later subscribe can retry.
    expect((plugin as unknown as { gatewayReady?: unknown }).gatewayReady).toBeUndefined();

    await plugin.disconnect();
  });

  it('BUG-07: transient closes back off (growing, capped, not fixed 500 ms) and reset on READY', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic: zero jitter
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

    const ws0 = await reachReady(plugin, asTopic('c2'));

    // Every reconnect attempt now fails with a TRANSIENT code (1006) right before READY.
    gw.state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);

    ws0.serverClose(1006); // start the loop (attempt 0 → base delay)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(100_000);
      gw.instances.at(-1)!.hello(HUGE_HB); // prompt IDENTIFY → 1006 → next (bigger) backoff
    }

    const delays = setTimeoutDelays(setTimeoutSpy);
    expect(delays.length).toBeGreaterThanOrEqual(4);
    expect(delays[0]).toBe(1000); // base — NOT the old fixed 500 ms
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!); // strictly growing (capped at 60 s)
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);

    // Now let a socket actually reach READY → backoff must RESET to base on the next close.
    gw.state.onIdentify = (ws: FakeWs) => ws.ready();
    await vi.advanceTimersByTimeAsync(100_000); // fire the pending reconnect
    const wsReady = gw.instances.at(-1)!;
    wsReady.hello(HUGE_HB); // → IDENTIFY → READY → reconnectAttempts reset to 0

    const before = setTimeoutSpy.mock.calls.length;
    wsReady.serverClose(1006);
    const afterReset = setTimeoutDelays(setTimeoutSpy).slice(before);
    expect(afterReset.at(-1)).toBe(1000); // back to the base delay

    await plugin.disconnect();
  });

  it('BUG-07: op 9 INVALID SESSION waits a randomized 1–5 s before re-identifying', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // op9 min-wait = 3000 ms (dominates the backoff)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

    const ws0 = await reachReady(plugin, asTopic('c3'));
    const identifiesBefore = totalIdentifies();

    ws0.serverSend({ op: 9, d: false }); // INVALID SESSION on the live socket

    const delay = setTimeoutDelays(setTimeoutSpy).at(-1)!;
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(5000);

    // It must NOT re-identify before ~1 s.
    await vi.advanceTimersByTimeAsync(900);
    expect(gw.instances.length).toBe(1);
    expect(totalIdentifies()).toBe(identifiesBefore);

    // …but does reconnect within the window.
    await vi.advanceTimersByTimeAsync(5000);
    expect(gw.instances.length).toBe(2);
    gw.instances.at(-1)!.hello(HUGE_HB);
    expect(totalIdentifies()).toBe(identifiesBefore + 1);

    await plugin.disconnect();
  });

  it('BUG-20: a missed heartbeat-ACK terminates the half-dead socket → reconnect → push resumes', async () => {
    const HB = 10_000;
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

    const topic = asTopic('555111');
    const got: string[] = [];
    const ws0 = await reachReady(plugin, topic, { hb: HB, handler: (m) => got.push(m.content) });

    // The server goes silent: it STOPS acking heartbeats but keeps the socket nominally OPEN.
    ws0.ackHeartbeats = false;

    // Interval #1: a beat is sent (ack now pending); socket still OPEN, no terminate yet.
    await vi.advanceTimersByTimeAsync(HB);
    expect(ws0.terminated).toBe(false);
    expect(ws0.heartbeatsSent()).toBe(1);

    // Interval #2: the previous beat was never acked → terminate() (NOT another buffered beat).
    await vi.advanceTimersByTimeAsync(HB);
    expect(ws0.terminated).toBe(true);
    expect(ws0.heartbeatsSent()).toBe(1); // no second beat buffered into the dead socket
    expect(ws0.closedCode).toBe(1006); // terminate() forced a non-1000 close

    // terminate() fired `close` → the existing close→scheduleReconnect path took over.
    await vi.advanceTimersByTimeAsync(70_000); // fire the backoff timer
    expect(gw.instances.length).toBe(2);
    const ws1 = gw.instances.at(-1)!;
    ws1.hello(HB); // reconnect handshake; acks healthy again on the new socket

    // Push resumes on the reconnected socket.
    ws1.serverSend({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 5,
      d: {
        id: '900',
        channel_id: '555111',
        content: 'back-online',
        timestamp: '',
        author: { id: '1', username: 'u' },
      },
    });
    expect(got).toContain('back-online');

    await plugin.disconnect();
  });
});
