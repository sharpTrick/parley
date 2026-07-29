import { asCursor, asTopic, fetchRecentBlocking } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A `block_ms` fetch may only WAIT on the gateway while the gateway can actually wake it. In every
// other transport state the plugin has to hand back its immediate page so core's poll fallback
// owns the wait — otherwise one tool call sleeps its whole budget on a socket that cannot deliver,
// on a backend whose REST half is perfectly healthy. The table below is over that transport state.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import { FakeWs, instances, resetGateway, state } from './fake-gateway.js';

const TOPIC = asTopic('770001');
const SINCE = asCursor('1');
const BLOCK_MS = 60_000;
const POLL_MS = 250;
const HANDSHAKE_MS = 500;
const ARRIVES_AT_MS = 1000;
/** The message must surface within a poll cycle or two of becoming visible — never at `blockMs`. */
const SLACK_MS = 2000;
const HUGE_HB = 1_000_000;

const MESSAGE = {
  id: '900000000000000009',
  channel_id: TOPIC as string,
  content: 'fresh',
  timestamp: '2026-01-01T00:00:00.000Z',
  author: { id: '5', username: 'human' },
};

describe('Discord long-poll while the live transport is…', () => {
  let visible = false;

  /** REST is healthy throughout: it simply starts returning the message once it has landed. */
  const stubFetch = (): void => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify(visible ? [MESSAGE] : []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  };

  const reachReady = async (plugin: DiscordPlugin): Promise<FakeWs> => {
    const pending = plugin.subscribe(TOPIC, () => undefined);
    const ws = instances.at(-1)!;
    ws.hello(HUGE_HB);
    await pending;
    return ws;
  };

  const TRANSPORTS: Array<{
    label: string;
    setup: (plugin: DiscordPlugin) => Promise<void>;
    /** Applied to every socket opened AFTER setup — a gateway that is not coming back stays mute. */
    driveNew: (ws: FakeWs) => void;
  }> = [
    {
      label: 'healthy',
      setup: async (plugin) => {
        await reachReady(plugin);
      },
      driveNew: (ws) => ws.hello(HUGE_HB),
    },
    {
      label: 'closed and reconnecting',
      setup: async (plugin) => {
        const ws = await reachReady(plugin);
        state.onIdentify = () => undefined;
        ws.serverClose(1006);
      },
      driveNew: () => undefined,
    },
    {
      label: 'handshake stalled',
      setup: async () => {
        state.onIdentify = () => undefined;
      },
      driveNew: (ws) => ws.hello(HUGE_HB),
    },
    {
      label: 'terminally closed',
      setup: async (plugin) => {
        const ws = await reachReady(plugin);
        ws.serverClose(4014);
      },
      driveNew: () => undefined,
    },
    {
      label: 'never opened',
      setup: async () => {
        state.onIdentify = (ws: FakeWs) => ws.serverClose(1006);
      },
      driveNew: (ws) => ws.hello(HUGE_HB),
    },
  ];

  beforeEach(() => {
    resetGateway();
    visible = false;
    stubFetch();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const transport of TRANSPORTS) {
    it(`${transport.label}: a message visible at ${ARRIVES_AT_MS}ms is returned promptly`, async () => {
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 't',
        gateway_url: 'ws://fake',
        handshake_timeout_ms: HANDSHAKE_MS,
      });
      await transport.setup(plugin);

      const driven = new Set(instances);
      const started = Date.now();
      let settledAt: number | undefined;
      const pending = fetchRecentBlocking(
        plugin,
        { topic: TOPIC, since: SINCE },
        { blockMs: BLOCK_MS, pollIntervalMs: POLL_MS },
      ).then((r) => {
        settledAt = Date.now();
        return r;
      });

      for (let t = 0; t < BLOCK_MS && settledAt === undefined; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
        if (!visible && Date.now() - started >= ARRIVES_AT_MS) {
          visible = true;
          // A real arrival is BOTH: durable over REST and, when a socket is live, a dispatch.
          const live = instances.find((ws) => ws.readyState === FakeWs.OPEN && ws.identified());
          live?.serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: MESSAGE });
        }
        for (const ws of [...instances]) {
          if (driven.has(ws)) continue;
          driven.add(ws);
          transport.driveNew(ws);
        }
      }

      const result = await pending;
      expect(result.messages.map((m) => m.content)).toEqual(['fresh']);
      expect(settledAt! - started).toBeLessThanOrEqual(ARRIVES_AT_MS + SLACK_MS);

      await plugin.disconnect();
    });
  }
});
