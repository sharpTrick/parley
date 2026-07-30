import { asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CLASS: a credential or capability bit that only the PROVIDER would miss. Nothing about the plugin
// breaks locally when the bot token is blanked out of IDENTIFY or the MESSAGE_CONTENT intent is
// dropped — real Discord answers 4004, or silently delivers every message with empty `content`. So
// the bits are pinned by VALUE on the decoded frame here, and the fakes refuse a frame without them
// (fake-gateway's op-2 branch, fake-discord's `Authorization` check) so no future call site can skip
// one and stay green.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import { REQUIRED_INTENTS } from '../src/intents.js';
import {
  FAKE_TOKEN,
  FakeWs,
  instances,
  REQUIRED_GATEWAY_QUERY,
  resetGateway,
  state,
} from './fake-gateway.js';
import { HUGE_HB, reachReady, stubFetch, type FetchStub } from './harness.js';

const TOPIC = asTopic('920001');

interface IdentifyPayload {
  token?: unknown;
  intents?: unknown;
}

describe('Discord IDENTIFY carries the credential and capability bits', () => {
  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const identify = async (): Promise<IdentifyPayload> => {
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: FAKE_TOKEN, gateway_url: 'ws://fake' });
    const ws = await reachReady(plugin, TOPIC);
    const frame = ws.sent.find((f) => f.op === 2);
    expect(frame, 'the plugin never sent an IDENTIFY').toBeDefined();
    await plugin.disconnect();
    return (frame!.d ?? {}) as IdentifyPayload;
  };

  it('sends the configured bot token verbatim', async () => {
    expect((await identify()).token).toBe(FAKE_TOKEN);
  });

  // The table below is generated FROM the list, so it cannot notice a bit deleted from it. Pin the
  // one whose absence is silent in production: without MESSAGE_CONTENT every MESSAGE_CREATE arrives
  // with empty `content` and the bridge pushes blank bodies into the session.
  it('declares MESSAGE_CONTENT as a required intent', () => {
    expect(REQUIRED_INTENTS.MESSAGE_CONTENT).toBe(1 << 15);
  });

  // Parameterized from the exported list, so an intent added later joins this table by construction.
  for (const [name, bit] of Object.entries(REQUIRED_INTENTS)) {
    it(`sets the ${name} intent bit (${bit})`, async () => {
      const { intents } = await identify();
      expect(typeof intents).toBe('number');
      expect((intents as number) & bit).toBe(bit);
    });
  }
});

describe('the fake gateway refuses an IDENTIFY the real one would refuse', () => {
  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Each row makes the fake demand something the plugin does not send, and asserts the vendor's own
  // rejection reaches the caller — that is what makes the enforcement above load-bearing rather than
  // decorative. A fake that merely logged the frame would pass every row here by doing nothing.
  const REFUSALS: Array<{ label: string; demand: () => void; code: number }> = [
    {
      label: 'a token that is not the configured one',
      demand: () => {
        state.expectToken = 'a-different-token';
      },
      code: 4004,
    },
    {
      label: 'an intent bit the plugin does not request',
      demand: () => {
        state.requiredIntents = [...Object.values(REQUIRED_INTENTS), 1 << 20];
      },
      code: 4014,
    },
  ];

  for (const refusal of REFUSALS) {
    it(`closes ${refusal.code} on ${refusal.label}`, async () => {
      refusal.demand();
      const plugin = new DiscordPlugin();
      await plugin.connect({ token: FAKE_TOKEN, gateway_url: 'ws://fake' });

      let err: unknown;
      void plugin.subscribe(TOPIC, () => undefined).catch((e: unknown) => {
        err = e;
      });
      const ws = instances.at(-1)!;
      ws.hello(HUGE_HB);
      await vi.advanceTimersByTimeAsync(0);

      expect(ws.closedCode).toBe(refusal.code);
      expect(String(err)).toContain(String(refusal.code));

      await plugin.disconnect();
    });
  }

  it('accepts the frame the plugin actually sends', async () => {
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: FAKE_TOKEN, gateway_url: 'ws://fake' });
    const ws = await reachReady(plugin, TOPIC);
    expect(ws.readyState).toBe(FakeWs.OPEN);
    expect(ws.closedCode).toBeUndefined();

    await plugin.disconnect();
  });
});

// CLASS: a vendor wire obligation carried on the CONNECT URL rather than in a frame — invisible to
// a fake that accepts any url. Discord documents `v` and `encoding` as REQUIRED, and the url
// `GET /gateway/bot` hands back carries neither, so an unversioned dial lands on a decommissioned
// API version and is closed 4012 — TERMINAL, which stops the ladder and fails the first subscribe,
// i.e. a correctly provisioned bot never starts. Both url SOURCES run every base shape, because the
// override is the one the tests use and the resolved one is the only one production uses.
describe('the gateway CONNECT url carries the params Discord requires', () => {
  let rest: FetchStub;

  beforeEach(() => {
    resetGateway();
    rest = stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const BASES: Array<{ label: string; base: string; keeps?: [string, string] }> = [
    { label: 'no query at all', base: 'ws://edge.test' },
    { label: 'a trailing slash', base: 'ws://edge.test/' },
    { label: 'a path', base: 'ws://edge.test/gateway' },
    { label: 'the required params already set', base: 'ws://edge.test/?v=10&encoding=json' },
    {
      label: 'an unrelated param',
      base: 'ws://edge.test/?compress=zlib-stream',
      keeps: ['compress', 'zlib-stream'],
    },
    { label: 'a stale v', base: 'ws://edge.test/?v=6' },
    { label: 'an encoding this plugin cannot parse', base: 'ws://edge.test/?encoding=etf' },
  ];

  const SOURCES: Array<[string, (base: string) => Promise<DiscordPlugin>]> = [
    [
      'a gateway_url override',
      async (base) => {
        const plugin = new DiscordPlugin();
        await plugin.connect({ token: FAKE_TOKEN, gateway_url: base });
        return plugin;
      },
    ],
    [
      'a url resolved via GET /gateway/bot',
      async (base) => {
        rest.gatewayUrl = base;
        const plugin = new DiscordPlugin();
        await plugin.connect({ token: FAKE_TOKEN });
        return plugin;
      },
    ],
  ];

  for (const { label, base, keeps } of BASES) {
    for (const [sourceLabel, arrange] of SOURCES) {
      it(`dials a base with ${label} versioned and JSON-encoded (via ${sourceLabel})`, async () => {
        const plugin = await arrange(base);
        const ws = await reachReady(plugin, TOPIC);

        const dialed = new URL(ws.url);
        for (const [key, value] of Object.entries(REQUIRED_GATEWAY_QUERY)) {
          expect(dialed.searchParams.getAll(key), `${key} on ${ws.url}`).toEqual([value]);
        }
        expect(dialed.origin).toBe(new URL(base).origin);
        expect(dialed.pathname).toBe(new URL(base).pathname);
        if (keeps !== undefined) expect(dialed.searchParams.get(keeps[0])).toBe(keeps[1]);
        // The socket the fake accepted, not merely a string: a refused dial closes 4012.
        expect(ws.closedCode).toBeUndefined();

        await plugin.disconnect();
      });
    }
  }

  // The negative control for the enforcement above: without it every row would pass on a plugin
  // that dials the bare url, because nothing else in the suite reads the connect url.
  it('the fake refuses a socket dialed without them, before any HELLO', () => {
    const ws = new FakeWs('ws://edge.test');
    ws.hello(HUGE_HB);
    expect(ws.closedCode).toBe(4012);
  });
});

// CLASS: a gateway obligation only the real provider punishes. op 1 is how Discord probes a socket
// it suspects is dead: a client that does not answer with its own op 1 is closed, and every
// subscription and every parked long-poll on that socket dies with it — on a schedule only the
// provider controls, so nothing local reproduces it. The fake closes 4009 on an unanswered probe,
// so the branch cannot be deleted without losing rows. (op 7, op 9 and a withheld op 11 are driven
// by gateway-reconnect.test.ts.)
describe('the client answers a server-initiated heartbeat request', () => {
  beforeEach(() => {
    resetGateway();
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const connected = async (): Promise<DiscordPlugin> => {
    const plugin = new DiscordPlugin();
    await plugin.connect({ token: FAKE_TOKEN, gateway_url: 'ws://fake' });
    return plugin;
  };

  // The `d` axis: a heartbeat carries the last dispatch `s` the socket saw, which is what lets
  // Discord tell a live session from a stalled one — `null` until it has dispatched anything.
  const PHASES: Array<{
    label: string;
    drive: (plugin: DiscordPlugin) => Promise<FakeWs>;
    answers: boolean;
    seq?: number | null;
  }> = [
    {
      label: 'before READY, with nothing dispatched yet',
      drive: async (plugin) => {
        state.onIdentify = () => undefined; // accepted, but READY withheld
        void plugin.subscribe(TOPIC, () => undefined).catch(() => undefined);
        const ws = instances.at(-1)!;
        ws.hello(HUGE_HB);
        await vi.advanceTimersByTimeAsync(0);
        return ws;
      },
      answers: true,
      seq: null,
    },
    {
      label: 'after READY',
      drive: async (plugin) => reachReady(plugin, TOPIC),
      answers: true,
      seq: 1,
    },
    {
      label: 'after a run of dispatches',
      drive: async (plugin) => {
        const ws = await reachReady(plugin, TOPIC);
        for (const s of [2, 3, 4]) {
          ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', s, d: dispatched(String(900 + s)) });
        }
        return ws;
      },
      answers: true,
      seq: 4,
    },
    {
      label: 'on a socket the plugin has superseded',
      drive: async (plugin) => {
        const ws = await reachReady(plugin, TOPIC);
        await plugin.connect({ token: FAKE_TOKEN, gateway_url: 'ws://fake' });
        return ws;
      },
      answers: false,
    },
  ];

  for (const phase of PHASES) {
    it(`${phase.label}: ${phase.answers ? 'echoes the last dispatch seq' : 'stays silent'}`, async () => {
      const plugin = await connected();
      const ws = await phase.drive(plugin);
      const before = ws.heartbeatsSent();

      ws.requestHeartbeat();

      expect(ws.heartbeatsSent()).toBe(before + (phase.answers ? 1 : 0));
      if (phase.answers) {
        expect(ws.heartbeatSeqs().at(-1)).toBe(phase.seq);
        expect(ws.seqSent()).toBe(phase.seq); // the assertion above compares to what WAS dispatched
        expect(ws.closedCode).toBeUndefined();
      }

      await plugin.disconnect();
    });
  }
});

const dispatched = (id: string): Record<string, unknown> => ({
  id,
  channel_id: TOPIC as string,
  content: 'hi',
  timestamp: '',
  author: { id: '1', username: 'u' },
});
