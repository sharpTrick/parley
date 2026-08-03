import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';
import { settleOf, type Settlement } from './harness.js';

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

/**
 * What teardown owes this entry point. A WRITE or a lookup cannot answer a value it never got, so it
 * must REJECT; a bounded read holding a replayable position may answer the empty page core resumes
 * from. Keep it per cell, so that a call quietly swapping one for the other is a failure and not
 * just a different green.
 */
type Owed = 'a rejection' | 'the empty replayable page' | 'a quiet return';

interface ParkedCall {
  entry: string;
  park: string;
  owed: Owed;
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
  ) => Promise<{ settled: Promise<Settlement> }>;
}

const PARKED_SINCE = asCursor('1');

function expectOwed(outcome: Settlement, owed: Owed): void {
  if (owed === 'a rejection') {
    if (outcome.status === 'resolved') {
      return expect.fail(
        `teardown answered ${JSON.stringify(outcome.value)} for a call that never completed`,
      );
    }
    expect(outcome.error).toBeInstanceOf(Error);
    return;
  }
  if (outcome.status === 'rejected') {
    return expect.fail(`teardown rejected where the seam owes ${owed}: ${String(outcome.error)}`);
  }
  if (owed === 'a quiet return') {
    expect(outcome.value).toBeUndefined();
    return;
  }
  const { messages, nextCursor } = outcome.value as { messages: unknown[]; nextCursor: string };
  expect(messages, 'a torn-down read invented messages').toEqual([]);
  expect(nextCursor, 'the cursor moved off the position the caller must replay').toBe(PARKED_SINCE);
}

/** Every entry point reaches the same retry loop, so a 429 parks all five the same way. */
const rateLimited = (
  entry: string,
  owed: Owed,
  watched: (channelId: string) => string,
  run: (p: DiscordPlugin, topic: Topic) => Promise<unknown>,
): ParkedCall => ({
  entry,
  park: 'a 429 backoff',
  owed,
  watched,
  start: async (p, topic, channelId, fake) => {
    fake.injectFault({
      status: 429,
      body: { retry_after: RETRY_AFTER_S },
      path: watched(channelId),
      times: 6,
    });
    const settled = settleOf(run(p, topic));
    await vi.waitFor(() => expect(fake.requestCount(watched(channelId))).toBeGreaterThan(0), {
      timeout: 3000,
    });
    return { settled };
  },
});

const messagesOf = (channelId: string): string => `/channels/${channelId}/messages`;

const PARKED: ParkedCall[] = [
  rateLimited('post', 'a rejection', messagesOf, (p, t) => p.post(t, SENDER, 'hi')),
  // A since-less read has no replayable position — cursor '0' would rewind the topic to the start
  // of history — so it is the one read that must fail loudly rather than answer an empty page.
  rateLimited('fetchRecent (default window)', 'a rejection', messagesOf, (p, t) =>
    p.fetchRecent({ topic: t }),
  ),
  rateLimited('fetchRecent (since)', 'a rejection', messagesOf, (p, t) =>
    p.fetchRecent({ topic: t, since: PARKED_SINCE }),
  ),
  // A budget wide enough to hold the stated wait, so this cell measures the guard and not the
  // blocking path's own deadline.
  rateLimited('fetchRecent (blockMs)', 'the empty replayable page', messagesOf, (p, t) =>
    p.fetchRecent({ topic: t, since: PARKED_SINCE, blockMs: 60_000 }),
  ),
  rateLimited('resolveIdentity', 'a rejection', () => '/users/@me', (p) =>
    p.resolveIdentity(asHandle('someone')),
  ),
  rateLimited(
    'subscribe',
    'a quiet return',
    (channelId) => `/channels/${channelId}`,
    (p, t) => p.subscribe(t, () => undefined),
  ),
  {
    entry: 'fetchRecent (blockMs)',
    park: 'a long-poll wait',
    owed: 'the empty replayable page',
    watched: messagesOf,
    start: async (p, topic, channelId, fake) => {
      await p.subscribe(topic, () => undefined);
      const settled = settleOf(p.fetchRecent({ topic, since: PARKED_SINCE, blockMs: 60_000 }));
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
      expectOwed(await settled, parked.owed);
      expect(Date.now() - started, 'the parked call outlived disconnect()').toBeLessThan(SETTLE_MS);

      await delay(WATCH_MS);
      expect(
        fake.requestCount(parked.watched(channelId)),
        'the plugin queried the API after teardown',
      ).toBe(atTeardown);
    });
  }
});
