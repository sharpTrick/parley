import { asTopic, MAX_TIMER_MS } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { MAX_DIALERS } from '../src/config.js';
import {
  dialBudgetFor,
  DiscordPlugin,
  IDENTIFY_QUOTA_PER_DAY,
  IDENTIFY_QUOTA_WINDOW_MS,
  RECONNECT_CAP_MS,
  STABLE_CONNECTION_MS,
} from '../src/index.js';
import { FAKE_TOKEN, FakeWs, instances, resetGateway, state, totalIdentifies } from './fake-gateway.js';
import { HUGE_HB, NO_HANDSHAKE_TIMEOUT, reachReady, stubFetch } from './harness.js';

/**
 * A fleet sharing one bot token never IDENTIFYs more often, in any 24h, than Discord allows that
 * token — whatever pattern the gateway fails in, and whatever lifecycle calls the bridge makes.
 *
 * The precondition: each instance is simulated alone at its configured `gateway_dialers`, and the
 * fleet's total is that instance's busiest window times the fan-out, because instances on one token
 * share nothing but the quota. The hot rows assert they reached the quota's edge, so a ladder slow
 * enough never to get there cannot leave this file grading nothing.
 *
 * Why the shape: a socket that stays up long enough FORGIVES the ladder, so the next dials climb
 * from its first rung again; arithmetic over the ladder's figures cannot see how many IDENTIFYs one
 * forgiveness cycle buys, so the real ladder is driven through a day and a half of gateway failures.
 *
 * Proof it can fail: make the IDENTIFY send skip its quota check, or let `connect()` start a fresh
 * ledger, and the lifecycle rows red; drop the quota wait from the ladder's charge and the simulated
 * rows red on the sockets it bounces; round a share up and the three-dialer rows red.
 */

const DAY_MS = IDENTIFY_QUOTA_WINDOW_MS;
/** Long enough that the busiest window can start anywhere in the first day and still be whole. */
const HORIZON_MS = DAY_MS + DAY_MS / 2;
const TOPIC = asTopic('880001');

/** How a dial that reached IDENTIFY fails — each is a distinct path back onto the ladder. */
const FAILS: Array<{ label: string; fail: (ws: FakeWs) => void }> = [
  { label: 'closed 4000', fail: (ws) => ws.serverClose(4000) },
  { label: 'closed 4008', fail: (ws) => ws.serverClose(4008) },
  { label: 'dropped 1006', fail: (ws) => ws.serverClose(1006) },
  { label: 'answered op 9', fail: (ws) => ws.serverSend({ op: 9, d: false }) },
];

/** How long each READY socket stays up, against the window that forgives the ladder. */
const UPS: Array<{ label: string; upMs: (dialers: number) => number }> = [
  { label: 'exactly the stable window', upMs: (n) => dialBudgetFor(n).stableConnectionMs },
  { label: 'just past the stable window', upMs: (n) => dialBudgetFor(n).stableConnectionMs + 1 },
  { label: 'half the stable window', upMs: (n) => dialBudgetFor(n).stableConnectionMs / 2 },
  { label: 'no time at all', upMs: () => 0 },
];

interface Pattern {
  dialers: number;
  /** IDENTIFYs that fail between consecutive READYs. */
  failures: number;
  up: (typeof UPS)[number];
  fail: (typeof FAILS)[number];
  /** Built to outrun the quota unpaced, so it must reach the quota's edge. */
  hot: boolean;
}

const label = (p: Pattern): string =>
  `${p.dialers} dialer(s), up ${p.up.label}, then ${p.failures} IDENTIFY(s) ${p.fail.label}`;

/** A small deterministic PRNG, so a red row names a pattern that replays. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLEETS = [1, 2, 3, 4];
const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const PATTERNS: Pattern[] = [
  // Forgiven every cycle, then the longest climb of failures: unpaced, every fan-out outruns its share.
  ...FLEETS.map((dialers) => ({ dialers, failures: 8, up: UPS[0]!, fail: FAILS[0]!, hot: true })),
  ...(() => {
    const rand = mulberry32(0x5eed);
    return Array.from({ length: 16 }, () => ({
      dialers: pick(rand, FLEETS),
      failures: Math.floor(rand() * 9),
      up: pick(rand, UPS),
      fail: pick(rand, FAILS),
      hot: false,
    }));
  })(),
];

/** The most entries of a sorted list that fall inside any one quota window. */
function busiestWindow(at: number[]): number {
  let most = 0;
  for (let lo = 0, hi = 0; hi < at.length; hi++) {
    while (at[hi]! - at[lo]! >= DAY_MS) lo++;
    most = Math.max(most, hi - lo + 1);
  }
  return most;
}

/** HELLO every socket the plugin has opened and nobody has greeted yet. */
const greetNew = (greeted: Set<FakeWs>): void => {
  for (const ws of instances) {
    if (greeted.has(ws) || ws.readyState !== FakeWs.OPEN) continue;
    greeted.add(ws);
    ws.hello(HUGE_HB);
  }
};

const connectAt = (plugin: DiscordPlugin, dialers: number): Promise<void> =>
  plugin.connect({
    token: FAKE_TOKEN,
    gateway_url: 'ws://fake',
    gateway_dialers: dialers,
    handshake_timeout_ms: NO_HANDSHAKE_TIMEOUT,
  });

/**
 * Drive one instance through {@link HORIZON_MS} of `p`, and return when it IDENTIFYed. Every socket
 * gets its HELLO as soon as it exists, so the only thing that can space dials out is the plugin.
 */
async function simulate(p: Pattern): Promise<{ at: number[]; greeted: Set<FakeWs> }> {
  const at: number[] = [];
  let n = 0;
  state.onIdentify = (ws) => {
    at.push(Date.now());
    if (n++ % (p.failures + 1) !== 0) {
      p.fail.fail(ws);
      return;
    }
    ws.ready();
    setTimeout(() => ws.serverClose(1006), p.up.upMs(p.dialers));
  };
  const plugin = new DiscordPlugin();
  await connectAt(plugin, p.dialers);
  void plugin.subscribe(TOPIC, () => undefined).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);

  const greeted = new Set<FakeWs>();
  const end = Date.now() + HORIZON_MS;
  while (Date.now() < end) {
    greetNew(greeted);
    await vi.advanceTimersByTimeAsync(0);
    if (vi.getTimerCount() === 0) throw new Error('nothing left to fire: the gateway wedged');
    await vi.advanceTimersToNextTimerAsync();
  }
  await plugin.disconnect();
  return { at, greeted };
}

const useFakeGateway = (): void => {
  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter: the ladder at its fastest
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
};

describe('one bot token is never IDENTIFYed past its quota', () => {
  useFakeGateway();

  for (const p of PATTERNS) {
    it(label(p), async () => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const start = Date.now();
      const { at, greeted } = await simulate(p);
      const busiest = busiestWindow(at);

      expect(
        p.dialers * busiest,
        `the fleet IDENTIFYed ${p.dialers} × ${busiest} times inside one quota window`,
      ).toBeLessThanOrEqual(IDENTIFY_QUOTA_PER_DAY);
      if (p.hot) {
        expect(
          p.dialers * (busiest + 1),
          'the row never reached the quota, so it cannot tell a paced ladder from an unbounded one',
        ).toBeGreaterThan(IDENTIFY_QUOTA_PER_DAY);
      }
      expect(
        [...greeted].filter((ws) => !ws.identified()).length,
        'the ladder dialed a socket the quota then refused, instead of waiting for the quota',
      ).toBe(0);
      expect(
        at.some((t) => t >= start + DAY_MS),
        'the instance never IDENTIFYed again once the first window had passed',
      ).toBe(true);
    });
  }
});

describe('no lifecycle call refills the share', () => {
  useFakeGateway();

  /** One IDENTIFY per window: the smallest share, so a single extra one is an overrun. */
  const SMALLEST_SHARE = MAX_DIALERS;

  const stderrLines = (spy: { mock: { calls: unknown[][] } }): string[] =>
    spy.mock.calls.map(([line]) => String(line));

  /** Pump minute steps until the `want`th IDENTIFY, or two windows pass. */
  async function untilIdentifies(want: number, greeted: Set<FakeWs>): Promise<void> {
    for (let t = 0; t <= 2 * DAY_MS && totalIdentifies() < want; t += 60_000) {
      greetNew(greeted);
      await vi.advanceTimersByTimeAsync(60_000);
    }
  }

  /** Subscribe on a re-entered session and HELLO the socket it opens. */
  async function redial(plugin: DiscordPlugin, greeted: Set<FakeWs>): Promise<void> {
    void plugin.subscribe(TOPIC, () => undefined).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    greetNew(greeted);
    await vi.advanceTimersByTimeAsync(0);
  }

  const REENTRIES: Array<{ label: string; reenter: (p: DiscordPlugin) => Promise<void> }> = [
    { label: 'connect() again', reenter: (p) => connectAt(p, SMALLEST_SHARE) },
    {
      label: 'disconnect() then connect()',
      reenter: async (p) => {
        await p.disconnect();
        await connectAt(p, SMALLEST_SHARE);
      },
    },
  ];

  for (const row of REENTRIES) {
    it(`${row.label} does not buy another IDENTIFY inside the window`, async () => {
      const diag = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const plugin = new DiscordPlugin();
      await connectAt(plugin, SMALLEST_SHARE);
      await reachReady(plugin, TOPIC);
      const spentAt = Date.now();
      expect(totalIdentifies(), 'the share was not spent, so nothing here is over it').toBe(1);

      await row.reenter(plugin);
      const greeted = new Set<FakeWs>(instances);
      await redial(plugin, greeted);
      expect(greeted.size, 'the re-entered session was never HELLOed, so nothing was refused').toBe(2);
      expect(totalIdentifies(), 'a re-entered session IDENTIFYed on a spent share').toBe(1);
      expect(
        stderrLines(diag).some((l) => l.includes('not up yet') && l.includes('IDENTIFY quota')),
        'subscribe reported the refusal as something other than the quota',
      ).toBe(true);
      expect(
        stderrLines(diag).some((l) => l.includes('live push waits')),
        'the operator was not told how long push stays down',
      ).toBe(true);

      await untilIdentifies(2, greeted);
      expect(totalIdentifies(), 'the share never came back once the window slid past it').toBe(2);
      expect(instances.at(-1)!.identified()).toBe(true);
      expect(Date.now()).toBeGreaterThanOrEqual(spentAt + DAY_MS);
      expect(instances.length, 'the ladder dialed a socket the quota then refused').toBe(3);

      await plugin.disconnect();
    });
  }

  it('a re-connect() onto a larger fleet holds to the smaller share', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const spends: number[] = [];
    state.onIdentify = (ws) => {
      spends.push(Date.now());
      ws.ready();
    };
    const plugin = new DiscordPlugin();
    await connectAt(plugin, MAX_DIALERS / 2);
    expect(dialBudgetFor(MAX_DIALERS / 2).identifiesPerWindow, 'the first share holds two').toBe(2);
    const first = await reachReady(plugin, TOPIC);
    const greeted = new Set<FakeWs>(instances);
    first.serverClose(1006);
    await untilIdentifies(2, greeted);
    expect(spends, 'the first share was not spent').toHaveLength(2);

    await connectAt(plugin, SMALLEST_SHARE);
    await redial(plugin, greeted);
    expect(totalIdentifies(), 'the smaller share was over-spent on re-entry').toBe(2);

    await untilIdentifies(3, greeted);
    expect(spends).toHaveLength(3);
    expect(spends[1]! - spends[0]!, 'both spends landed together, so either could be the one waited on')
      .toBeGreaterThan(0);
    expect(spends[2], 'the next IDENTIFY did not wait out the LATER spend').toBeGreaterThanOrEqual(
      spends[1]! + DAY_MS,
    );
    expect(instances.length, 'the ladder dialed a socket the quota then refused').toBe(4);

    await plugin.disconnect();
  });

  it('a wall clock stepped back cannot strand a spend in the future', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plugin = new DiscordPlugin();
    await connectAt(plugin, SMALLEST_SHARE);
    const ws = await reachReady(plugin, TOPIC);
    vi.setSystemTime(Date.now() - 30 * DAY_MS);
    ws.serverClose(1006);

    const greeted = new Set<FakeWs>([ws]);
    for (let t = 0; t < 60_000; t += 1000) {
      greetNew(greeted);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(instances.length, 'the ladder re-dialed a spent share as fast as it was refused').toBe(1);

    await untilIdentifies(2, greeted);
    expect(totalIdentifies(), 'the stepped-back spend never aged out').toBe(2);

    await plugin.disconnect();
  });
});

describe('the fan-out domain is the one the quota can serve', () => {
  it('every accepted fan-out has a share of at least one IDENTIFY, and the next would have none', () => {
    expect(dialBudgetFor(MAX_DIALERS).identifiesPerWindow).toBeGreaterThanOrEqual(1);
    expect(dialBudgetFor(MAX_DIALERS + 1).identifiesPerWindow).toBe(0);
    expect(
      Math.max(dialBudgetFor(MAX_DIALERS).reconnectCapMs, dialBudgetFor(MAX_DIALERS).stableConnectionMs),
      'an accepted fan-out arms a delay setTimeout cannot hold, so it fires at 1 ms',
    ).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  it('the figures are the ones the ladder scales, and an omitted fan-out is one dialer', () => {
    expect(dialBudgetFor(1)).toEqual({
      reconnectCapMs: RECONNECT_CAP_MS,
      stableConnectionMs: STABLE_CONNECTION_MS,
      identifiesPerWindow: IDENTIFY_QUOTA_PER_DAY,
    });
    expect(dialBudgetFor(undefined)).toEqual(dialBudgetFor(1));
  });
});
