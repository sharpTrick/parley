import { asCursor, asTopic, type MessageHandler, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reconnect storm that resets the bot token and the undetected half-dead socket both live in
// the gateway-socket machinery. They're driven here against an in-process FAKE gateway
// (the `ws` module is mocked to a scriptable FakeWs, mirroring the XMPP suite's transport mock) so
// close codes, backoff timers, op 9, and heartbeat-ACK timing are all deterministic under fake
// timers — no real Discord, no real sockets.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

// Imported after the mock is declared; vitest hoists vi.mock above all imports regardless.
import {
  BACKOFF_BASE_MS,
  BACKOFF_JITTER_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DiscordPlugin,
  INVALID_SESSION_MIN_WAIT_MS,
  INVALID_SESSION_SPREAD_MS,
  RECONNECT_CAP_MS,
  STABLE_CONNECTION_MS,
} from '../src/index.js';
import { FakeWs, instances, resetGateway, state, totalIdentifies } from './fake-gateway.js';
import {
  HUGE_HB,
  NO_HANDSHAKE_TIMEOUT,
  openedSocket,
  reachReady,
  stubFetch,
  type FetchStub,
} from './harness.js';
import { dialCeiling, dialPump } from './ladder.js';

const gw = { instances, state, FakeWs };

/** Backoff delays only: the per-socket handshake watchdog is not a reconnect step. */
const setTimeoutDelays = (spy: ReturnType<typeof vi.spyOn>): number[] =>
  spy.mock.calls.map((c) => c[1] as number).filter((d) => d !== NO_HANDSHAKE_TIMEOUT);

describe('Discord gateway reconnect & liveness', () => {
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

  // Discord's op 9 wait and the ordinary ladder are two independent floors on the SAME dial, so a
  // range assertion is satisfied by whichever happens to be larger — delete the op 9 term and a
  // fresh ladder still lands inside 1–5 s. Each cell computes the delay it expects from the
  // exported constants, so dropping either term changes an asserted number.
  const invalidSessionWait = (r: number): number =>
    INVALID_SESSION_MIN_WAIT_MS + Math.floor(r * INVALID_SESSION_SPREAD_MS);
  const ladderWait = (attempts: number, r: number): number =>
    Math.min(BACKOFF_BASE_MS * 2 ** attempts, RECONNECT_CAP_MS) + Math.floor(r * BACKOFF_JITTER_MS);

  /** Drive `cycles` transient close→reconnect→READY rounds, leaving the ladder at `cycles`. */
  const climbLadder = async (ws: FakeWs, cycles: number): Promise<FakeWs> => {
    let current = ws;
    for (let i = 0; i < cycles; i++) {
      current.serverClose(1006);
      await vi.advanceTimersByTimeAsync(2 * RECONNECT_CAP_MS);
      current = gw.instances.at(-1)!;
      current.hello(HUGE_HB);
    }
    return current;
  };

  const OP9_CELLS: Array<{ random: number; climbs: number }> = [
    { random: 0, climbs: 0 },
    { random: 0.999, climbs: 0 },
    { random: 0, climbs: 8 },
    { random: 0.999, climbs: 8 },
  ];

  for (const cell of OP9_CELLS) {
    const expected = Math.max(invalidSessionWait(cell.random), ladderWait(cell.climbs, cell.random));
    it(`op 9 re-identifies after exactly ${expected}ms (random ${cell.random}, ladder at ${cell.climbs})`, async () => {
      vi.spyOn(Math, 'random').mockReturnValue(cell.random);
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
      });

      const ws0 = await reachReady(plugin, asTopic('c3'));
      const live = await climbLadder(ws0, cell.climbs);
      const socketsBefore = gw.instances.length;
      const identifiesBefore = totalIdentifies();

      live.serverSend({ op: 9, d: false }); // INVALID SESSION on the live socket

      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(gw.instances.length, 're-dialed before the wait elapsed').toBe(socketsBefore);
      expect(totalIdentifies()).toBe(identifiesBefore);

      await vi.advanceTimersByTimeAsync(2);
      expect(gw.instances.length, 'never re-dialed after the wait elapsed').toBe(socketsBefore + 1);
      gw.instances.at(-1)!.hello(HUGE_HB);
      expect(totalIdentifies()).toBe(identifiesBefore + 1);

      await plugin.disconnect();
    });
  }

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

// CLASS: a per-socket resource released only by teardown. `disconnect()` clears the whole
// `heartbeats` set, so every assertion made AFTER it passes whether or not the socket that ended
// released its own interval — and a gateway that flaps leaks one live `setInterval` per reconnect,
// each of which keeps the event loop alive so the process cannot exit on stdin EOF. The axis is
// therefore the WAY one socket ends, and every cell asserts at the boundary, before any teardown.
describe('a socket that ends releases its own heartbeat, before any disconnect()', () => {
  const HB = 10_000;
  const TOPIC = asTopic('c11');

  const heartbeatsOf = (plugin: DiscordPlugin): Set<unknown> =>
    (plugin as unknown as { heartbeats: Set<unknown> }).heartbeats;

  /** How one socket ends, and whether the ladder is expected to bring another one back. */
  const ENDINGS: Array<{ label: string; end: (ws: FakeWs) => Promise<void>; retries: boolean }> = [
    {
      label: 'a transient server close (1006)',
      end: async (ws) => ws.serverClose(1006),
      retries: true,
    },
    {
      label: 'a terminal close (4014)',
      end: async (ws) => ws.serverClose(4014),
      retries: false,
    },
    {
      label: 'op 7 RECONNECT',
      end: async (ws) => ws.serverSend({ op: 7 }),
      retries: true,
    },
    {
      label: 'op 9 INVALID SESSION',
      end: async (ws) => ws.serverSend({ op: 9, d: false }),
      retries: true,
    },
    {
      label: 'a zombie socket (no HEARTBEAT_ACK)',
      end: async (ws) => {
        ws.ackHeartbeats = false;
        await vi.advanceTimersByTimeAsync(2 * HB); // beat, then terminate on the missed ack
      },
      retries: true,
    },
  ];

  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const ending of ENDINGS) {
    // Repeated, because ONE cycle passes under a leak that merely fails to clean up: only the
    // second and third show the set growing with the cycle count.
    const cycles = ending.retries ? 3 : 1;
    it(`${ending.label}, over ${cycles} cycle(s)`, async () => {
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
      });

      let ws = await reachReady(plugin, TOPIC, { hb: HB });
      for (let cycle = 1; cycle <= cycles; cycle++) {
        expect(heartbeatsOf(plugin).size, `cycle ${cycle}: no interval to release`).toBe(1);
        await ending.end(ws);

        expect(
          heartbeatsOf(plugin).size,
          `cycle ${cycle}: the closed socket kept its heartbeat interval`,
        ).toBe(0);
        // The only timer a closed socket may leave behind is the ladder's own pending re-dial.
        expect(vi.getTimerCount(), `cycle ${cycle}: a timer outlived the socket`).toBeLessThanOrEqual(
          ending.retries ? 1 : 0,
        );
        if (!ending.retries) break;

        await vi.advanceTimersByTimeAsync(2 * RECONNECT_CAP_MS);
        ws = gw.instances.at(-1)!;
        ws.hello(HB);
        await vi.advanceTimersByTimeAsync(0);
      }

      await plugin.disconnect();
    });
  }
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

  // Both entry points RESOLVE on a stall: a stalled handshake is transient, the failed dial is
  // already on the reconnect ladder, and the gateway carries only new messages — so neither call
  // has anything to report but the diagnostic. Only a TERMINAL close rejects (its own suite below).
  const ENTRIES: Array<{ label: string; budget: number; run: (p: DiscordPlugin) => Promise<unknown> }> =
    [
      {
        label: 'subscribe',
        budget: HANDSHAKE,
        run: (p) => p.subscribe(asTopic('900001'), () => undefined),
      },
      {
        label: 'fetchRecent(blockMs)',
        budget: BLOCK,
        run: (p) =>
          p.fetchRecent({ topic: asTopic('900001'), since: asCursor('1'), blockMs: BLOCK }),
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

        const diag = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const state = track(entry.run(plugin));
        const ws = gw.instances.at(-1);
        if (stall.sendHello) ws?.hello(HUGE_HB);

        await vi.advanceTimersByTimeAsync(entry.budget * 2 + 500);
        expect(state.settled).toBe(true);
        expect(state.error).toBeUndefined();

        // Only the subscribe row's budget IS the handshake budget; the blocking fetch hands its own
        // (shorter) budget back long before the watchdog fires, which is the point of its row.
        if (!stall.identifyReplies && entry.label === 'subscribe') {
          expect(ws?.terminated).toBe(true); // the dead socket is not left dangling
          // A stall that resolves silently is the idle-bridge failure: subscribe owes the operator
          // a line naming the topic it could not bring up.
          const written = diag.mock.calls.map((c) => String(c[0])).join('');
          expect(written).toContain('900001');
          expect(written).toMatch(/handshake|READY/i);
        }

        await plugin.disconnect();
      });
    }
  }

  it(`a stalled first open uses the default handshake timeout (${DEFAULT_HANDSHAKE_TIMEOUT_MS}ms) when none is configured`, async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    gw.state.onIdentify = () => undefined;
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', gateway_url: 'ws://fake' });

    const state = track(plugin.subscribe(asTopic('900002'), () => undefined));
    const ws = gw.instances.at(-1)!;
    ws.hello(HUGE_HB);

    // Pinned to the exported default on BOTH sides: a shorter watchdog would fire early, a longer
    // one (or none) would leave the call parked.
    await vi.advanceTimersByTimeAsync(DEFAULT_HANDSHAKE_TIMEOUT_MS - 1);
    expect(state.settled, 'the default watchdog fired early').toBe(false);
    expect(ws.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(ws.terminated).toBe(true);
    expect(state.settled).toBe(true);

    await plugin.disconnect();
  });

});

// A recovery loop that only covers the STEADY state is the defect this table exists for: the outage
// most likely at process start is the first dial, and a ladder wired only into the post-READY close
// path leaves that one case with no in-plugin retry at all. So the cells are over WHEN the failure
// lands and over HOW the dial fails — including the bootstrap step OUTSIDE the socket, `GET
// /gateway/bot`, which on the production configuration (no `gateway_url`) is the whole live path's
// single point of no return. Each transient cell asserts recovery both ways: the plugin re-dialed on
// its own within the ladder's own bound, and live push works once the gateway heals.
describe('Discord gateway recovery, whenever the failure lands', () => {
  const HANDSHAKE = 3000;
  const TOPIC = asTopic('910001');
  /**
   * Keep the pump step BELOW `handshake_timeout_ms`, so that a freshly dialed socket is driven before
   * the watchdog terminates it — a coarser step turns every scripted failure into a handshake
   * timeout and the cells stop testing what they name.
   */
  const STEP_MS = 1000;
  /** Enough steps for several rungs of the 1s→2s→4s… ladder while the gateway stays broken. */
  const BROKEN_STEPS = 16;
  /** Once healed the ladder already sits several rungs up, so the wait has to clear a whole rung. */
  const HEAL_STEPS = 160;

  const PHASES = ['the first dial', 'after READY', 'mid-reconnect'] as const;

  /**
   * How the dial fails. A `socket` failure needs a url to dial, so it runs under BOTH url sources; a
   * `resolve` failure breaks the url lookup itself, which only exists when the url is not configured.
   * `dials` is the count of ATTEMPTS the plugin has made — sockets, or url lookups when no socket is
   * ever created — so a cell can prove the ladder ran rather than only that it stayed under a bound.
   */
  interface Failure {
    label: string;
    terminal: boolean;
    onlyResolvedUrl: boolean;
    fail: (rest: FetchStub) => void;
    heal: (rest: FetchStub) => void;
    dials: (rest: FetchStub) => number;
  }

  const socketFailure = (
    label: string,
    terminal: boolean,
    onIdentify: (ws: FakeWs) => void,
  ): Failure => ({
    label,
    terminal,
    onlyResolvedUrl: false,
    fail: () => {
      gw.state.onIdentify = onIdentify;
    },
    heal: () => {
      gw.state.onIdentify = (ws: FakeWs) => ws.ready();
    },
    dials: () => gw.instances.length,
  });

  const resolveFailure = (label: string, fault: FetchStub['gatewayFault']): Failure => ({
    label,
    terminal: false,
    onlyResolvedUrl: true,
    fail: (rest) => {
      rest.gatewayFault = fault;
    },
    heal: (rest) => {
      rest.gatewayFault = undefined;
    },
    dials: (rest) => rest.count('/gateway/bot'),
  });

  const FAILURES: Failure[] = [
    socketFailure('a close before READY', false, (ws) => ws.serverClose(1006)),
    socketFailure('a handshake stall', false, () => undefined),
    socketFailure('a terminal close', true, (ws) => ws.serverClose(4014)),
    resolveFailure('a 500 on GET /gateway/bot', { status: 500 }),
    resolveFailure('a 429 on GET /gateway/bot', {
      status: 429,
      headers: { 'retry-after': '60' },
    }),
    resolveFailure('a transport error on GET /gateway/bot', { transport: true }),
  ];

  const URL_SOURCES = [
    { label: 'a configured gateway_url', configured: true },
    { label: 'a url resolved per attempt', configured: false },
  ];

  let rest: FetchStub;
  let diag: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetGateway();
    rest = stubFetch();
    diag = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const phase of PHASES) {
    for (const failure of FAILURES) {
      for (const source of URL_SOURCES) {
        if (failure.onlyResolvedUrl && source.configured) continue;
        it(`${failure.label} on ${phase}, with ${source.label}`, async () => {
          const pump = dialPump((ms) => vi.advanceTimersByTimeAsync(ms), HUGE_HB);
          const plugin = new DiscordPlugin();
          await plugin.connect({
            token: 't',
            ...(source.configured ? { gateway_url: 'ws://fake' } : {}),
            handshake_timeout_ms: HANDSHAKE,
          });
          const got: string[] = [];
          const handler = (m: { content: string }): void => got.push(m.content);

          if (phase === 'the first dial') {
            failure.fail(rest);
            void plugin.subscribe(TOPIC, handler).catch(() => undefined);
            await pump(2, STEP_MS);
          } else {
            const ws0 = await reachReady(plugin, TOPIC, { handler });
            failure.fail(rest);
            ws0.serverClose(1006);
            await pump(phase === 'mid-reconnect' ? BROKEN_STEPS : 2, STEP_MS);
          }
          const dialsWhileBroken = failure.dials(rest);

          if (failure.terminal) {
            // Fatal by design: it needs a human, so the loop must STOP rather than keep dialing.
            await pump(BROKEN_STEPS + HEAL_STEPS, STEP_MS);
            expect(failure.dials(rest)).toBe(dialsWhileBroken);
            await plugin.disconnect();
            return;
          }

          await pump(BROKEN_STEPS, STEP_MS);
          expect(failure.dials(rest), 'the plugin never re-dialed on its own').toBeGreaterThan(
            dialsWhileBroken,
          );
          const brokenWindowMs = 2 * BROKEN_STEPS * STEP_MS;
          expect(failure.dials(rest)).toBeLessThanOrEqual(dialCeiling(brokenWindowMs) + 1);

          // The diagnostic subscribe wrote may only claim a retry while one is actually pending.
          if (phase === 'the first dial') {
            const written = diag.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toContain(TOPIC as string);
            expect(written).toContain('the reconnect ladder is retrying');
          }

          failure.heal(rest); // the gateway comes back
          const healedFrom = gw.instances.length;
          await pump(HEAL_STEPS, STEP_MS);
          const live = gw.instances
            .slice(healedFrom)
            .find((ws) => ws.readyState === gw.FakeWs.OPEN && ws.identified());
          expect(live, 'no socket reached IDENTIFY after the gateway healed').toBeDefined();

          live!.serverSend({
            op: 0,
            t: 'MESSAGE_CREATE',
            s: 11,
            d: {
              id: '910500',
              channel_id: TOPIC as string,
              content: 'back-online',
              timestamp: '',
              author: { id: '1', username: 'u' },
            },
          });
          expect(got, 'live push did not resume after the gateway healed').toEqual(['back-online']);

          await plugin.disconnect();
        });
      }
    }
  }

  // A url the plugin resolved ONCE and cached would keep dialing an address the outage may have
  // retired. Nothing above can see that: the fake answers the same url every time.
  it('re-resolves the gateway url on every attempt', async () => {
    rest.gatewayUrl = 'ws://first';
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: 't', handshake_timeout_ms: HANDSHAKE });
    gw.state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
    const before = gw.instances.length;
    void plugin.subscribe(TOPIC, () => undefined).catch(() => undefined);
    const first = await openedSocket(before);
    expect(first.url).toBe('ws://first');

    rest.gatewayUrl = 'ws://second'; // Discord hands out a different edge after the outage
    const pump = dialPump((ms) => vi.advanceTimersByTimeAsync(ms), HUGE_HB);
    await pump(8, 1000);

    expect(gw.instances.at(-1)!.url).toBe('ws://second');
    await plugin.disconnect();
  });
});

describe('Discord gateway terminal failures are never invisible', () => {
  const TERMINAL_CLOSE = [4004, 4010, 4011, 4012, 4013, 4014];

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
    stubFetch();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
