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
import { FAKE_TOKEN, FakeWs, instances, resetGateway, state } from './fake-gateway.js';
import { HUGE_HB, reachReady, stubFetch } from './harness.js';

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
