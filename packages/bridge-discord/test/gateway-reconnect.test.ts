import { asCursor, asTopic, type MessageHandler, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reconnect storm that resets the bot token and the undetected half-dead socket both live in
// the gateway-socket machinery. They're driven here against an in-process FAKE gateway
// (the `ws` module is mocked to a scriptable FakeWs, mirroring the XMPP suite's transport mock) so
// close codes, backoff timers, op 9, and heartbeat-ACK timing are all deterministic under fake
// timers — no real Discord, no real sockets.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

// Imported after the mock is declared; vitest hoists vi.mock above all imports regardless.
import { DiscordPlugin, RECONNECT_CAP_MS, STABLE_CONNECTION_MS } from '../src/index.js';
import { FakeWs, instances, resetGateway, state, totalIdentifies } from './fake-gateway.js';

const gw = { instances, state, FakeWs };

const HUGE_HB = 1_000_000; // large enough that the heartbeat interval never fires during a test
/**
 * These cases drive close codes and backoff, not handshakes: park the handshake watchdog far out
 * so a socket the test has not driven yet is never terminated underneath it.
 */
const NO_HANDSHAKE_TIMEOUT = 10_000_000;

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

/** Backoff delays only: the per-socket handshake watchdog is not a reconnect step. */
const setTimeoutDelays = (spy: ReturnType<typeof vi.spyOn>): number[] =>
  spy.mock.calls.map((c) => c[1] as number).filter((d) => d !== NO_HANDSHAKE_TIMEOUT);

describe('Discord gateway reconnect & liveness', () => {
  beforeEach(() => {
    resetGateway();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a terminal close (4014) stops the reconnect storm — gatewayReady cleared, no re-IDENTIFY flood', async () => {
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
    });

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

  it('transient closes back off (growing, capped, not fixed 500 ms) and reset on READY', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic: zero jitter
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
    });

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
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!); // strictly growing, up to the cap
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(120_000);

    // Now let a socket reach READY *and stay up* → backoff must RESET to base on the next close.
    // (READY alone must NOT reset it: a gateway that drops a second after READY would then
    // re-IDENTIFY once a second forever — see the IDENTIFY-budget suite.)
    gw.state.onIdentify = (ws: FakeWs) => ws.ready();
    await vi.advanceTimersByTimeAsync(100_000); // fire the pending reconnect
    const wsReady = gw.instances.at(-1)!;
    wsReady.hello(HUGE_HB); // → IDENTIFY → READY
    await vi.advanceTimersByTimeAsync(61_000); // the connection proves itself stable

    const before = setTimeoutDelays(setTimeoutSpy).length;
    wsReady.serverClose(1006);
    const afterReset = setTimeoutDelays(setTimeoutSpy).slice(before);
    expect(afterReset.at(-1)).toBe(1000); // back to the base delay

    await plugin.disconnect();
  });

  it('op 9 INVALID SESSION waits a randomized 1–5 s before re-identifying', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // op9 min-wait = 3000 ms (dominates the backoff)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
    });

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

  it('a missed heartbeat-ACK terminates the half-dead socket → reconnect → push resumes', async () => {
    const HB = 10_000;
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
    });

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

/** Observe a promise's settlement without awaiting it (fake timers drive the clock). */
function track<T>(p: Promise<T>): { settled: boolean; error?: unknown } {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    (e: unknown) => {
      state.settled = true;
      state.error = e;
    },
  );
  return state;
}

/** REST is irrelevant to these cases; every call answers an empty page immediately. */
const stubFetch = (): void => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
};

describe('Discord gateway handshake never completes', () => {
  const HANDSHAKE = 3000;
  const BLOCK = 200;

  // A socket that connects but never finishes HELLO → IDENTIFY → READY must not park an entry
  // point forever: every seam call has to settle within a bounded multiple of ITS OWN budget,
  // or `block_ms` (and core's catchup.block_max_ms cap) is silently unbounded.
  const STALLS: Array<{ label: string; identifyReplies: boolean; sendHello: boolean }> = [
    { label: 'no HELLO ever arrives', identifyReplies: false, sendHello: false },
    { label: 'HELLO arrives but IDENTIFY is ignored', identifyReplies: false, sendHello: true },
    { label: 'READY arrives normally', identifyReplies: true, sendHello: true },
  ];

  const ENTRIES: Array<{
    label: string;
    budget: number;
    run: (p: DiscordPlugin) => Promise<unknown>;
    stallOutcome: 'reject' | 'resolve';
  }> = [
    {
      label: 'subscribe',
      budget: HANDSHAKE,
      run: (p) => p.subscribe(asTopic('900001'), () => undefined),
      stallOutcome: 'reject',
    },
    {
      label: 'fetchRecent(blockMs)',
      budget: BLOCK,
      run: (p) =>
        p.fetchRecent({ topic: asTopic('900001'), since: asCursor('1'), blockMs: BLOCK }),
      stallOutcome: 'resolve',
    },
  ];

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const stall of STALLS) {
    for (const entry of ENTRIES) {
      it(`${entry.label} settles when ${stall.label}`, async () => {
        gw.state.onIdentify = stall.identifyReplies
          ? (ws: FakeWs) => ws.ready()
          : () => undefined;
        const plugin = new DiscordPlugin();
        await plugin.connect({
          token: 't',
          gateway_url: 'ws://fake',
          handshake_timeout_ms: HANDSHAKE,
        });

        const state = track(entry.run(plugin));
        const ws = gw.instances.at(-1);
        if (stall.sendHello) ws?.hello(HUGE_HB);

        await vi.advanceTimersByTimeAsync(entry.budget * 2 + 500);
        expect(state.settled).toBe(true);

        const stalled = !stall.identifyReplies;
        if (stalled && entry.stallOutcome === 'reject') {
          expect(state.error).toBeInstanceOf(Error);
          expect(String(state.error)).toMatch(/handshake|READY/i);
          expect(ws?.terminated).toBe(true); // the dead socket is not left dangling
        } else {
          expect(state.error).toBeUndefined();
        }

        await plugin.disconnect();
      });
    }
  }

  it('a stalled first open uses the default handshake timeout when none is configured', async () => {
    gw.state.onIdentify = () => undefined;
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

    const state = track(plugin.subscribe(asTopic('900002'), () => undefined));
    gw.instances.at(-1)!.hello(HUGE_HB);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(Error);

    await plugin.disconnect();
  });

  it('a handshake that stalls mid-reconnect retries instead of wedging the socket', async () => {
    /** Advance time, HELLOing each freshly opened socket so the handshake actually starts. */
    const pump = async (steps: number): Promise<void> => {
      for (let i = 0; i < steps; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        const ws = gw.instances.at(-1)!;
        if (ws.readyState === gw.FakeWs.OPEN && ws.sent.length === 0) ws.hello(HUGE_HB);
      }
    };

    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake', handshake_timeout_ms: HANDSHAKE });
    const ws0 = await reachReady(plugin, asTopic('900003'));

    gw.state.onIdentify = () => undefined; // every attempt now stalls after IDENTIFY
    ws0.serverClose(1006);
    await pump(30);
    const attemptsWhileStalled = gw.instances.length;
    expect(attemptsWhileStalled).toBeGreaterThanOrEqual(3); // a timed-out handshake keeps retrying

    gw.state.onIdentify = (ws: FakeWs) => ws.ready(); // the gateway recovers
    await pump(30);
    const healthy = gw.instances.at(-1)!;
    expect(healthy.readyState).toBe(gw.FakeWs.OPEN);
    expect(healthy.terminated).toBe(false);
    expect(healthy.sent.some((f) => f.op === 2)).toBe(true);

    await plugin.disconnect();
  });
});

describe('Discord gateway terminal failures are never invisible', () => {
  const TERMINAL_CLOSE = [4004, 4010, 4011, 4012, 4013, 4014];

  beforeEach(() => {
    resetGateway();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const code of TERMINAL_CLOSE) {
    for (const phase of ['before READY', 'after READY'] as const) {
      it(`a ${code} close ${phase} is surfaced and starts no storm`, async () => {
        const diag = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const plugin = new DiscordPlugin();
        await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

        let firstOpen: { settled: boolean; error?: unknown } | undefined;
        if (phase === 'before READY') {
          gw.state.onIdentify = (ws: FakeWs) => ws.serverClose(code);
          firstOpen = track(plugin.subscribe(asTopic('42'), () => undefined));
          gw.instances.at(-1)!.hello(HUGE_HB);
          await vi.advanceTimersByTimeAsync(0);
        } else {
          const ws0 = await reachReady(plugin, asTopic('42'));
          ws0.serverClose(code);
        }

        const identifiesAtFailure = totalIdentifies();
        for (let i = 0; i < 5; i++) {
          await vi.advanceTimersByTimeAsync(150_000);
          const ws = gw.instances.at(-1)!;
          if (ws.readyState === gw.FakeWs.OPEN) ws.hello(HUGE_HB);
        }
        expect(totalIdentifies()).toBe(identifiesAtFailure); // no re-IDENTIFY storm

        // Observable in BOTH phases: pre-READY as a rejection, post-READY as a diagnostic —
        // "live push is dead" must never be something the operator can only infer from silence.
        const diagnostics = diag.mock.calls.map((c) => String(c[0])).join('');
        expect(diagnostics).toContain(String(code));
        if (phase === 'before READY') {
          expect(firstOpen!.settled).toBe(true);
          expect(String(firstOpen!.error)).toContain(String(code));
        }

        await plugin.disconnect();
      });
    }
  }

  it('a terminal close makes the next gateway-backed call fail fast with the reason', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });
    const ws0 = await reachReady(plugin, asTopic('43'));

    ws0.serverClose(4014);
    const before = gw.instances.length;
    const err = await plugin.subscribe(asTopic('43'), () => undefined).catch((e: unknown) => e);

    expect(String(err)).toContain('4014');
    expect(gw.instances.length).toBe(before); // no fresh socket that the gateway would close again

    await plugin.disconnect();
  });
});

describe('Discord IDENTIFY budget under sustained flapping', () => {
  // Discord allows 1000 IDENTIFYs per 24h and PENALIZES an overrun by RESETTING the bot token, so
  // the steady-state reconnect rate — not just the first few delays — has to sit under the quota.
  const DAY_MS = 86_400_000;
  const QUOTA_PER_DAY = 1000;

  beforeEach(() => {
    resetGateway();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const FLAPS: Array<[string, (ws: FakeWs) => void]> = [
    ['closes right after IDENTIFY', (ws) => ws.serverClose(1006)],
    ['closes right after READY', (ws) => {
      ws.ready();
      ws.serverClose(4000);
    }],
  ];

  for (const [label, flap] of FLAPS) {
    it(`a gateway that ${label} stays under ${QUOTA_PER_DAY} IDENTIFYs/day`, async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter: measure the raw steady-state rate
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
      });

      const ws0 = await reachReady(plugin, asTopic('c9'));
      gw.state.onIdentify = flap;
      ws0.serverClose(1006);

      // Saturate the backoff: after enough attempts the delay stops growing, and THAT delay is
      // what sets the sustained IDENTIFY rate.
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(200_000);
        const ws = gw.instances.at(-1)!;
        if (ws.readyState === gw.FakeWs.OPEN) ws.hello(HUGE_HB);
      }

      const delays = setTimeoutDelays(setTimeoutSpy).filter((d) => d >= 1000);
      const steadyState = Math.max(...delays);
      expect(DAY_MS / steadyState).toBeLessThan(QUOTA_PER_DAY);

      await plugin.disconnect();
    });
  }
});

describe('Discord backoff constants are the ones the code applies', () => {
  // The quota argument only holds if the ladder's ceiling and its reset rule are what a reader
  // computes with. Assert both against the exported constants, so neither can drift into prose.
  beforeEach(() => {
    resetGateway();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it(`the ladder tops out at exactly RECONNECT_CAP_MS (${RECONNECT_CAP_MS}ms)`, async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const plugin = new DiscordPlugin();
    await plugin.connect({
      token: 't',
      gateway_url: 'ws://fake',
      handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
    });

    const ws0 = await reachReady(plugin, asTopic('cap'));
    gw.state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
    ws0.serverClose(1006);
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(2 * RECONNECT_CAP_MS);
      const ws = gw.instances.at(-1)!;
      if (ws.readyState === gw.FakeWs.OPEN) ws.hello(HUGE_HB);
    }

    const delays = setTimeoutDelays(setTimeoutSpy).filter((d) => d >= 1000);
    expect(Math.max(...delays)).toBe(RECONNECT_CAP_MS);

    await plugin.disconnect();
  });

  const STABILITY: Array<[string, number, boolean]> = [
    ['one tick short of STABLE_CONNECTION_MS', STABLE_CONNECTION_MS - 1, false],
    ['exactly STABLE_CONNECTION_MS', STABLE_CONNECTION_MS, true],
  ];

  for (const [label, upMs, resets] of STABILITY) {
    it(`a connection that stayed up ${label} ${resets ? 'resets' : 'does not reset'} the ladder`, async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
      });

      const ws0 = await reachReady(plugin, asTopic('stable'));
      gw.state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
      ws0.serverClose(1006);
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(2 * RECONNECT_CAP_MS);
        gw.instances.at(-1)!.hello(HUGE_HB); // climb: 1s → 2s → 4s → …
      }

      gw.state.onIdentify = (ws: FakeWs) => ws.ready();
      await vi.advanceTimersByTimeAsync(2 * RECONNECT_CAP_MS);
      const wsUp = gw.instances.at(-1)!;
      wsUp.hello(HUGE_HB); // → READY
      await vi.advanceTimersByTimeAsync(upMs);

      const before = setTimeoutDelays(setTimeoutSpy).length;
      wsUp.serverClose(1006);
      const next = setTimeoutDelays(setTimeoutSpy).slice(before).at(-1)!;
      expect(next === 1000).toBe(resets);

      await plugin.disconnect();
    });
  }
});
