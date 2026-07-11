import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

/** Each context gets its OWN in-process fake workspace — total isolation, no shared state. */
async function makeContext() {
  const fake = await FakeSlack.start();
  const plugin = new SlackPlugin();
  await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
  return {
    plugin,
    fake, // introspection for the ack-discipline test below (ignored by the shared suite)
    // A fresh "channel id" per test — unmapped topics are used as channel-id literals.
    freshTopic: (): Topic => asTopic(`C${++seq}${rand().toUpperCase()}`),
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
    },
    // N independent plugin instances against the same workspace = N concurrent API writers.
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      const plugins = await Promise.all(
        Array.from({ length: writers }, async () => {
          const p = new SlackPlugin();
          await p.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
          return p;
        }),
      );
      try {
        await Promise.all(
          plugins.map(async (p, w) => {
            for (let i = 0; i < perWriter; i++) {
              await p.post(topic, asHandle(`w${w}`), `w${w}-${i}`);
            }
          }),
        );
      } finally {
        await Promise.all(plugins.map((p) => p.disconnect()));
      }
    },
  };
}

// The fake is in-process — the suite always runs; no external server to probe for.
runConformanceSuite('slack', makeContext);

describe('slack socket mode discipline', () => {
  it('acks every pushed envelope, even while handlers are consuming events', async () => {
    const ctx = await makeContext();
    try {
      const t = ctx.freshTopic();
      const live: string[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m.content));
      for (const c of ['a', 'b', 'c']) await ctx.plugin.post(t, asHandle('writer'), c);
      await vi.waitFor(() => expect(live).toEqual(['a', 'b', 'c']), { timeout: 3000, interval: 10 });

      const fake = ctx.fake;
      // Every events_api envelope the fake pushed must have been acked back over the socket
      // (ack-first: acks precede handler processing, so none can be starved by a slow handler).
      await vi.waitFor(
        () => {
          expect(fake.pushed.size).toBeGreaterThan(0);
          for (const id of fake.pushed) expect(fake.acked).toContain(id);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('slack pagination & reconnect regressions', () => {
  // BUG-18 — with `since` set, a backlog larger than the old MAX_HISTORY_PAGES × PAGE_SIZE cap must
  // still return the TRUE oldest window and a `nextCursor` that never sits above unfetched history.
  it('BUG-18: `since` catch-up over a >cap backlog returns the true-oldest window, not a skipping cursor', async () => {
    const ctx = await makeContext();
    try {
      const t = ctx.freshTopic();
      // Fake pages at PAGE_SIZE=50; the removed cap was MAX_HISTORY_PAGES=100 → 5000. 5001 plain
      // messages force > 100 pages, which the pre-fix code truncated to the NEWEST ~5000.
      const seeded = ctx.fake.seed(
        t,
        Array.from({ length: 5001 }, (_, i) => ({ text: `m${i}` })),
      );

      const result = await ctx.plugin.fetchRecent({ topic: t, since: asCursor('0'), limit: 100 });

      // The oldest 100 of `(since, now]` (ascending positions 1..100) — NOT the newest 100 of a
      // truncated set. Pre-fix this returned positions ~4901..5000 and a cursor above ~4900 holes.
      const oldest100 = seeded.slice(0, 100);
      expect(result.messages).toHaveLength(100);
      expect(result.messages.map((m) => m.content)).toEqual(oldest100.map((m) => m.text));
      // `nextCursor` = ts of the 100th-oldest message: at/below every unfetched older message.
      expect(result.nextCursor).toBe(oldest100.at(-1)?.ts);
    } finally {
      await ctx.cleanup();
    }
  });

  // BUG-31 — the no-`since` default window must count PLAIN (surfaced) messages toward `limit`, not
  // raw entries, so a system-subtype-heavy recent page can't cut the window short.
  it('BUG-31: default window pages past system-subtype-heavy pages to return a full plain window', async () => {
    const ctx = await makeContext();
    try {
      const t = ctx.freshTopic();
      // Newest ~200 events = 90 channel_join + 10 plain; 100 plain older beyond them. Pre-fix stops
      // after ~limit RAW entries (all system) and returns ≈10; the fix keeps paging to 100 plain.
      const olderPlain = Array.from({ length: 100 }, (_, i) => ({ text: `plain-old-${i}` }));
      const joins = Array.from({ length: 90 }, (_, i) => ({
        text: `sys-join-${i}`,
        subtype: 'channel_join',
      }));
      const newPlain = Array.from({ length: 10 }, (_, i) => ({ text: `plain-new-${i}` }));
      ctx.fake.seed(t, [...olderPlain, ...joins, ...newPlain]);

      const result = await ctx.plugin.fetchRecent({ topic: t, limit: 100 });

      // A FULL window of 100 plain messages, every one surfaced (no channel_join system record leaked).
      expect(result.messages).toHaveLength(100);
      expect(result.messages.every((m) => m.content.startsWith('plain'))).toBe(true);
      // The newest plain message is included (the window reaches the tail of the channel).
      expect(result.messages.map((m) => m.content)).toContain('plain-new-9');
    } finally {
      await ctx.cleanup();
    }
  });

  // BUG-30 — a pre-`hello` socket close must start exactly ONE reconnect owner; repeated pre-`hello`
  // closes during an outage must not accumulate parallel reconnect() loops.
  it('BUG-30: repeated pre-`hello` closes keep exactly one reconnect owner, then settle cleanly', async () => {
    const ctx = await makeContext();
    try {
      const t = ctx.freshTopic();
      const received: string[] = [];
      // Establish a live socket (greet=true → hello) so subscribe() resolves normally.
      await ctx.plugin.subscribe(t, (m) => received.push(m.content));

      // Count reconnect() OWNERS: the fix calls reconnect() once (on the live-socket drop) and the
      // single loop retries internally; the bug calls reconnect() again per pre-`hello` close.
      const reconnectSpy = vi.spyOn(
        ctx.plugin as unknown as { reconnect: () => Promise<void> },
        'reconnect',
      );

      // Every new connection now closes pre-`hello`; then drop the established (post-`hello`) socket.
      ctx.fake.setGreet(false);
      const opensBefore = ctx.fake.connectionsOpened;
      ctx.fake.dropSockets();

      // Let several reconnect ATTEMPTS elapse (one apps.connections.open each, on the backoff
      // cadence). Under the bug this count balloons as loops stack; under the fix a single owner
      // advances one attempt at a time.
      await vi.waitFor(
        () => expect(ctx.fake.connectionsOpened).toBeGreaterThanOrEqual(opensBefore + 3),
        { timeout: 4000, interval: 10 },
      );
      expect(reconnectSpy).toHaveBeenCalledTimes(1);

      // Finally greet again: a single clean reconnect settles and live delivery resumes.
      const helloBefore = ctx.fake.helloSent;
      ctx.fake.setGreet(true);
      await vi.waitFor(() => expect(ctx.fake.helloSent).toBeGreaterThan(helloBefore), {
        timeout: 4000,
        interval: 10,
      });
      await ctx.plugin.post(t, asHandle('writer'), 'after-recovery');
      await vi.waitFor(() => expect(received).toContain('after-recovery'), {
        timeout: 4000,
        interval: 10,
      });
      // Recovery spawned no extra reconnect owners — still exactly one across the whole outage.
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.cleanup();
    }
  });
});
