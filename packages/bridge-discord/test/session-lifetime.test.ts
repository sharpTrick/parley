import { asCursor, asTopic, type FetchRecentResult } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CLASS: a seam call that resumes into the session that REPLACED the one it was made in. `stopped`
// cannot see this — `connect()` retires the old session and sets it back to false before any parked
// continuation runs — so a `fetchRecent` parked anywhere across a re-`connect()` re-resolved its
// topic through the NEW `channel_map` and answered with another channel's messages, and another
// channel's cursor, under the topic the caller asked about. Discord snowflakes are globally
// time-ordered, so that cursor sits ahead of the original channel's history and core persists it.
//
// The table crosses WHERE the call is parked with WHAT retired the session, because those are
// independent: the waiter is released by the retirement itself, a page walk is released by the
// provider, and `disconnect()` alone leaves the map in place while `connect()` replaces it. Every
// cell ends with the successor session serving a read, so that refusing every later query — which
// satisfies each negative assertion below — is a failure and not a pass.

vi.mock('ws', async () => ({ default: (await import('./fake-gateway.js')).FakeWs }));

import { DiscordPlugin } from '../src/index.js';
import { resetGateway } from './fake-gateway.js';
import { probe, reachReady, stubFetch, type FetchStub } from './harness.js';

const TOPIC = asTopic('chat');
const OLD_CHANNEL = '111';
const NEW_CHANNEL = '222';
const SINCE = asCursor('900000000000000001');
const BLOCK_MS = 60_000;
/** Past Discord's 100-per-page cap, so a walk has a SECOND page to send after the retirement. */
const TWO_PAGE_LIMIT = 150;
const SUCCESSOR_ID = '900000000000009999';

const record = (id: string, channel: string, content: string): unknown => ({
  id,
  channel_id: channel,
  content,
  timestamp: '2026-01-01T00:00:00.000Z',
  author: { id: '5', username: 'human' },
});

/** A full first page from the channel the caller's session was mapped to. */
const OLD_PAGE = Array.from({ length: 100 }, (_, i) =>
  record(String(900000000000001000 + (100 - i)), OLD_CHANNEL, `old-${i}`),
);
const OLD_IDS = new Set(
  OLD_PAGE.map((m) => (m as { id: string }).id),
);
/** What the successor's channel serves; no part of it may reach a call made in the old session. */
const SUCCESSOR_PAGE = [record(SUCCESSOR_ID, NEW_CHANNEL, 'successor-secret')];

const openTo = (plugin: DiscordPlugin, channel: string): Promise<void> =>
  plugin.connect({
    token: 't',
    gateway_url: 'ws://fake',
    channel_map: { [TOPIC as string]: channel },
  });

interface Parked {
  label: string;
  /**
   * Arrange the stall and start the call; resolves once it is demonstrably parked. Keep the call
   * INSIDE an object, so that `await` cannot adopt it and wait out the very stall the cell is about.
   */
  start: (plugin: DiscordPlugin, rest: FetchStub) => Promise<{ call: Promise<FetchRecentResult> }>;
  /** Let the parked leg run on, AFTER the retirement has landed. */
  release: (rest: FetchStub) => void;
  /** Resume points this call may legitimately answer with when it returns nothing. */
  echoes: string;
}

const PARKS: Parked[] = [
  {
    label: 'on the native long-poll waiter',
    start: async (plugin, rest) => {
      rest.pages[OLD_CHANNEL] = [];
      await reachReady(plugin, TOPIC);
      const call = plugin.fetchRecent({ topic: TOPIC, since: SINCE, blockMs: BLOCK_MS });
      await vi.advanceTimersByTimeAsync(50);
      expect(probe<Map<string, unknown>>(plugin, 'waiters').size, 'no waiter is armed').toBe(1);
      return { call };
    },
    release: () => undefined,
    echoes: SINCE as string,
  },
  {
    label: 'between the pages of a since walk',
    start: async (plugin, rest) => {
      rest.pages[OLD_CHANNEL] = OLD_PAGE;
      rest.holdNextPage();
      const call = plugin.fetchRecent({ topic: TOPIC, since: SINCE, limit: TWO_PAGE_LIMIT });
      await vi.advanceTimersByTimeAsync(5);
      expect(rest.parked(), 'no page query is parked').toBe(1);
      return { call };
    },
    release: (rest) => rest.release(),
    echoes: SINCE as string,
  },
  {
    label: 'between the pages of a since-less window',
    start: async (plugin, rest) => {
      rest.pages[OLD_CHANNEL] = OLD_PAGE;
      rest.holdNextPage();
      const call = plugin.fetchRecent({ topic: TOPIC, limit: TWO_PAGE_LIMIT });
      await vi.advanceTimersByTimeAsync(5);
      expect(rest.parked(), 'no page query is parked').toBe(1);
      return { call };
    },
    release: (rest) => rest.release(),
    echoes: '0',
  },
];

const RETIREMENTS: Array<{ label: string; retire: (p: DiscordPlugin) => Promise<void> }> = [
  { label: 'connect() alone', retire: (p) => openTo(p, NEW_CHANNEL) },
  {
    label: 'disconnect() then connect()',
    retire: async (p) => {
      await p.disconnect();
      await openTo(p, NEW_CHANNEL);
    },
  },
];

describe('a seam call cannot resume into the session that replaced it', () => {
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

  for (const park of PARKS) {
    for (const retirement of RETIREMENTS) {
      it(`parked ${park.label}, it does not read the successor of ${retirement.label}`, async () => {
        const plugin = new DiscordPlugin();
        await openTo(plugin, OLD_CHANNEL);
        const { call } = await park.start(plugin, rest);

        rest.pages[NEW_CHANNEL] = SUCCESSOR_PAGE;
        const queriesAtRetire = rest.count(`/channels/${NEW_CHANNEL}/messages`);
        await retirement.retire(plugin);
        park.release(rest);
        await vi.advanceTimersByTimeAsync(BLOCK_MS);
        const out = await call;

        expect(
          rest.count(`/channels/${NEW_CHANNEL}/messages`) - queriesAtRetire,
          'the retired call queried the successor session channel',
        ).toBe(0);
        expect(
          out.messages.filter((m) => !OLD_IDS.has(m.backendMsgId as string)),
          'a message the retired call never asked for crossed the seam under its topic',
        ).toEqual([]);
        expect(
          [...OLD_IDS, park.echoes],
          'the retired call published a cursor from outside its own session',
        ).toContain(out.nextCursor as string);

        // Refusing every later query satisfies all three assertions above, and leaves the topic
        // with no catch-up at all: the successor session must still read its own channel.
        const successor = plugin.fetchRecent({ topic: TOPIC, since: SINCE, limit: 10 });
        await vi.advanceTimersByTimeAsync(50);
        const served = await successor;
        expect(served.messages.map((m) => m.backendMsgId)).toEqual([SUCCESSOR_ID]);
        expect(served.nextCursor as string).toBe(SUCCESSOR_ID);
      });
    }
  }
});
