import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';

// CLASS: a disconnect-quiescence guard whose deletion is invisible. Two of them exist here — the
// `isStopped` predicate net-util polls while it honours a 429, and the post-wake `stopped` check on
// the blocking path — and deleting BOTH left the whole package green. Unguarded, a 429 backoff keeps
// competing for the shared bot token's rate-limit budget for net-util's full deadline after
// teardown, and a long-poll woken by disconnect()'s own wakeWaiters() issues a fresh REST request
// against a plugin that has already been torn down. Every cell below asserts the same two things:
// the parked call settles PROMPTLY once disconnect() lands, and the request count taken at teardown
// never grows afterwards.

/** Discord's stated wait. Short enough to observe a retry, long enough that settling early is proof. */
const RETRY_AFTER_S = 1;
/** A parked call must come back within this of `disconnect()`, not at the stated wait. */
const SETTLE_MS = 600;
/** How long teardown is watched for a request that should never be made. Longer than the wait above. */
const WATCH_MS = 1300;

const SENDER = asHandle('writer');

let seq = 0;
const freshChannelId = (): string =>
  String(760_000 + ++seq) + String(Math.floor(Math.random() * 900) + 100);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ParkedCall {
  entry: string;
  park: string;
  /** Path substring that is made to stall, and whose request count must freeze at teardown. */
  watched: (channelId: string) => string;
  /**
   * Arrange the stall and start the call; resolves once the call is PARKED, handing back its
   * settlement. Keep the promise inside an object, so that `await` cannot adopt it and silently wait
   * out the very stall the cell exists to interrupt — that made all seven cells vacuous.
   */
  start: (
    p: DiscordPlugin,
    topic: Topic,
    channelId: string,
    fake: FakeDiscord,
  ) => Promise<{ settled: Promise<unknown> }>;
}

/** Every entry point reaches the same retry loop, so a 429 parks all five the same way. */
const rateLimited = (
  entry: string,
  watched: (channelId: string) => string,
  run: (p: DiscordPlugin, topic: Topic) => Promise<unknown>,
): ParkedCall => ({
  entry,
  park: 'a 429 backoff',
  watched,
  start: async (p, topic, channelId, fake) => {
    fake.injectFault({
      status: 429,
      body: { retry_after: RETRY_AFTER_S },
      path: watched(channelId),
      times: 6,
    });
    const settled = run(p, topic).then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(fake.requestCount(watched(channelId))).toBeGreaterThan(0), {
      timeout: 3000,
    });
    return { settled };
  },
});

const messagesOf = (channelId: string): string => `/channels/${channelId}/messages`;

const PARKED: ParkedCall[] = [
  rateLimited('post', messagesOf, (p, t) => p.post(t, SENDER, 'hi')),
  rateLimited('fetchRecent (default window)', messagesOf, (p, t) => p.fetchRecent({ topic: t })),
  rateLimited('fetchRecent (since)', messagesOf, (p, t) =>
    p.fetchRecent({ topic: t, since: asCursor('1') }),
  ),
  // A budget wide enough to hold the stated wait, so this cell measures the guard and not the
  // blocking path's own deadline.
  rateLimited('fetchRecent (blockMs)', messagesOf, (p, t) =>
    p.fetchRecent({ topic: t, since: asCursor('1'), blockMs: 60_000 }),
  ),
  rateLimited('resolveIdentity', () => '/users/@me', (p) => p.resolveIdentity(asHandle('someone'))),
  rateLimited(
    'subscribe',
    (channelId) => `/channels/${channelId}`,
    (p, t) => p.subscribe(t, () => undefined),
  ),
  {
    entry: 'fetchRecent (blockMs)',
    park: 'a long-poll wait',
    watched: messagesOf,
    start: async (p, topic, channelId, fake) => {
      await p.subscribe(topic, () => undefined);
      const settled = p.fetchRecent({ topic, since: asCursor('1'), blockMs: 60_000 }).then(
        () => 'resolved',
        () => 'rejected',
      );
      // The waiter is armed only after the first (empty) query has come back.
      await vi.waitFor(() => expect(fake.requestCount(messagesOf(channelId))).toBeGreaterThan(0), {
        timeout: 3000,
      });
      await delay(50);
      return { settled };
    },
  },
];

describe('disconnect() quiesces a call parked in', () => {
  let fake: FakeDiscord;

  beforeEach(async () => {
    fake = await startFakeDiscord();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => {
    await fake.close();
    vi.restoreAllMocks();
  });

  for (const parked of PARKED) {
    it(`${parked.park}: ${parked.entry}`, async () => {
      const channelId = freshChannelId();
      fake.createChannel(channelId);
      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 'fake-token',
        api_url: fake.apiUrl,
        gateway_url: fake.gatewayUrl,
      });

      const { settled } = await parked.start(plugin, asTopic(channelId), channelId, fake);
      const atTeardown = fake.requestCount(parked.watched(channelId));

      const started = Date.now();
      await plugin.disconnect();
      await settled;
      expect(Date.now() - started, 'the parked call outlived disconnect()').toBeLessThan(SETTLE_MS);

      await delay(WATCH_MS);
      expect(
        fake.requestCount(parked.watched(channelId)),
        'the plugin queried the API after teardown',
      ).toBe(atTeardown);
    });
  }
});
