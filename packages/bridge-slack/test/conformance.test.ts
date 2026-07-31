import { runConformanceSuite } from '@sharptrick/parley-conformance';
import {
  asCursor,
  asHandle,
  asTopic,
  type BackendMsgId,
  type Message,
  type Topic,
} from '@sharptrick/parley-core';
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
    // Slack honors blockMs natively (parks on the shared Socket Mode stream), so the shared
    // blocking-fetch conformance case runs directly against the plugin.
    supportsBlockingFetch: true,
    fake, // introspection for the ack-discipline test below (ignored by the shared suite)
    // A fresh "channel id" per test — unmapped topics are used as channel-id literals. The channel
    // is CREATED in the fake: an id that was never created is `channel_not_found`, not an empty
    // channel, so a test that means "empty topic" must say so explicitly.
    freshTopic: (): Topic => {
      const t = asTopic(`C${++seq}${rand().toUpperCase()}`);
      fake.createChannel(t);
      return t;
    },
    carriesSenderIdentity: false,
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

/**
 * CLASS: a successful write must be readable back through the seam, or be refused. `post` is the
 * seam's ONE durable write path, and the `backendMsgId` it returns is what core hands the model as
 * proof — so an optional write flag that files the message outside this backend's own read window
 * turns a reported success into silent loss. Slack's `thread_ts` was exactly that costume: a plain
 * thread reply is invisible to `conversations.history` AND deliberately dropped on the live path, so
 * both read paths agreed the message did not exist while `post` reported an id for it.
 *
 * Every write shape is crossed with every read path, because a shape that is reachable through one
 * of them is not lost — and a shape reachable through NONE is the defect, whatever the flag is
 * called next time.
 */
type Ctx = Awaited<ReturnType<typeof makeContext>>;

const READ_PATHS: Array<{
  name: string;
  observe: (
    ctx: Ctx,
    topic: Topic,
    write: () => Promise<BackendMsgId>,
  ) => Promise<{ id: BackendMsgId; seen: BackendMsgId[] }>;
}> = [
  {
    name: 'fetchRecent with no since',
    observe: async (ctx, topic, write) => {
      const id = await write();
      const { messages } = await ctx.plugin.fetchRecent({ topic });
      return { id, seen: messages.map((m) => m.backendMsgId) };
    },
  },
  {
    name: 'fetchRecent from the tail cursor',
    observe: async (ctx, topic, write) => {
      const { nextCursor } = await ctx.plugin.fetchRecent({ topic });
      const id = await write();
      const { messages } = await ctx.plugin.fetchRecent({ topic, since: nextCursor });
      return { id, seen: messages.map((m) => m.backendMsgId) };
    },
  },
  {
    name: 'subscribe',
    observe: async (ctx, topic, write) => {
      const live: Message[] = [];
      await ctx.plugin.subscribe(topic, (m) => live.push(m));
      const id = await write();
      await vi
        .waitFor(() => expect(live.map((m) => m.backendMsgId)).toContain(id), {
          timeout: 3000,
          interval: 10,
        })
        .catch(() => undefined);
      return { id, seen: live.map((m) => m.backendMsgId) };
    },
  },
];

const WRITES: Array<{ name: string; write: (ctx: Ctx, topic: Topic) => Promise<BackendMsgId> }> = [
  { name: 'a plain post', write: (ctx, topic) => ctx.plugin.post(topic, asHandle('writer'), 'body') },
  {
    name: 'a post({inReplyTo})',
    write: async (ctx, topic) => {
      const parent = await ctx.plugin.post(topic, asHandle('writer'), 'question');
      return ctx.plugin.post(topic, asHandle('writer'), 'answer', { inReplyTo: parent });
    },
  },
];

describe('slack durable writes are reachable through the seam that made them', () => {
  for (const write of WRITES) {
    for (const path of READ_PATHS) {
      it(`${write.name} is observable via ${path.name}`, async () => {
        const ctx = await makeContext();
        try {
          const topic = ctx.freshTopic();
          const { id, seen } = await path.observe(ctx, topic, () => write.write(ctx, topic));
          expect(seen).toContain(id);
        } finally {
          await ctx.cleanup();
        }
      });
    }
  }
});

describe('slack identity fidelity', () => {
  // Slack stamps the posting BOT as the sender and `post` cannot override it, so two sessions
  // sharing one bot token are indistinguishable on read-back — the fact the README's
  // "give every session its own bot" warning rests on. Pinned here so a future change that
  // starts carrying `identity` (or stops) has to move the README with it.
  it('does NOT carry the logical identity: distinct handles read back as one sender', async () => {
    const ctx = await makeContext();
    try {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, asHandle('ctx-payments'), 'from payments');
      await ctx.plugin.post(t, asHandle('ctx-reviews'), 'from reviews');

      const { messages } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages.map((m) => m.content)).toEqual(['from payments', 'from reviews']);
      expect(new Set(messages.map((m) => m.senderHandle)).size).toBe(1);
      expect(messages[0]!.senderHandle).not.toBe('ctx-payments');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('slack pagination regressions', () => {
  // With `since` set, a backlog larger than the old MAX_HISTORY_PAGES × PAGE_SIZE cap must still
  // return the TRUE oldest window and a `nextCursor` that never sits above unfetched history.
  it('`since` catch-up over a >cap backlog returns the true-oldest window, not a skipping cursor', async () => {
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

  // The no-`since` default window must count PLAIN (surfaced) messages toward `limit`, not raw
  // entries, so a system-subtype-heavy recent page can't cut the window short.
  it('default window pages past system-subtype-heavy pages to return a full plain window', async () => {
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
});
