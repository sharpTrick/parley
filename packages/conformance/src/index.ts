import { asHandle, type BackendPlugin, type Message, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendFactory, ConformanceContext } from './factory.js';

export type { BackendFactory, ConformanceContext } from './factory.js';

const SENDER = asHandle('writer');
const OTHER = asHandle('second-writer');

/**
 * Read every message in `topic` by PAGING to exhaustion. It must not read one oversized page: a
 * backend with a server-side page cap below the request would silently return a prefix, and the
 * assertions built on it would grade a partial view.
 */
async function drainAll(plugin: BackendPlugin, topic: Topic): Promise<Message[]> {
  const out: Message[] = [];
  let since: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await plugin.fetchRecent({ topic, since: since as never, limit: 500 });
    out.push(...res.messages);
    if (res.messages.length === 0 || res.nextCursor === since) return out;
    since = res.nextCursor;
  }
  throw new Error(`drainAll did not terminate for ${topic}`);
}

/**
 * Every field of the normalized Message (DESIGN §5) a plugin is responsible for populating.
 * Asserting only `content` lets a plugin return a constant `topic` — which collapses core's dedup
 * namespace across topics — or a constant `senderHandle`, and still pass in full.
 */
function expectWellFormedMessage(
  m: Message,
  expected: { topic: Topic; content: string; sender?: string },
): void {
  expect(m.topic).toBe(expected.topic);
  expect(m.content).toBe(expected.content);
  expect(typeof m.backendMsgId).toBe('string');
  expect(m.backendMsgId.length).toBeGreaterThan(0);
  expect(typeof m.cursor).toBe('string');
  expect(m.cursor.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
  if (expected.sender !== undefined) expect(m.senderHandle).toBe(expected.sender);
}

/**
 * The shared seam conformance suite (DESIGN §6; CLAUDE.md testing discipline). A backend
 * conforms iff: stable-unique backendMsgId AND monotonic, in-order, exclusive-`since` cursor
 * delivery. Write once here; run against every backend via {@link BackendFactory}.
 */
export function runConformanceSuite(name: string, factory: BackendFactory): void {
  describe(`seam conformance: ${name}`, () => {
    let ctx: ConformanceContext;
    beforeEach(async () => {
      ctx = await factory();
    });
    afterEach(async () => {
      await ctx.cleanup();
    });

    it('post → fetchRecent returns messages in order, with unique ids and distinct cursors', async () => {
      const t = ctx.freshTopic();
      const ids = [];
      for (const c of ['a', 'b', 'c']) ids.push(await ctx.plugin.post(t, SENDER, c));
      expect(new Set(ids).size).toBe(3); // backendMsgId is unique

      const { messages, nextCursor } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);
      expect(new Set(messages.map((m) => m.backendMsgId)).size).toBe(3);
      expect(new Set(messages.map((m) => m.cursor)).size).toBe(3);
      expect(messages.map((m) => m.backendMsgId)).toEqual(ids); // post() ids match read ids
      expect(nextCursor).toBe(messages.at(-1)!.cursor);

      for (const [i, c] of ['a', 'b', 'c'].entries()) {
        expectWellFormedMessage(messages[i]!, {
          topic: t,
          content: c,
          sender: ctx.carriesSenderIdentity ? SENDER : undefined,
        });
      }
    });

    it('the same content posted twice still yields distinct ids and cursors', async () => {
      const t = ctx.freshTopic();
      const first = await ctx.plugin.post(t, SENDER, 'same');
      const second = await ctx.plugin.post(t, SENDER, 'same');
      expect(first).not.toBe(second);
      const { messages } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages).toHaveLength(2);
      expect(messages[0]!.cursor).not.toBe(messages[1]!.cursor);
    });

    it('catch-up since a cursor returns only newer messages (exclusive)', async () => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'a');
      await ctx.plugin.post(t, SENDER, 'b');
      const c1 = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;
      await ctx.plugin.post(t, SENDER, 'c');
      await ctx.plugin.post(t, SENDER, 'd');

      const after = await ctx.plugin.fetchRecent({ topic: t, since: c1 });
      expect(after.messages.map((m) => m.content)).toEqual(['c', 'd']);
      expect(after.nextCursor).toBe(after.messages.at(-1)!.cursor);
    });

    // A truncating `limit` is where the most dangerous cursor bug lives: reporting the topic tail
    // instead of the last RETURNED message silently drops everything in between, with no error.
    it.each([1, 2, 4, 5, 6])('paging from a cursor with limit %i is lossless', async (limit) => {
      const t = ctx.freshTopic();
      const posted = ['m0', 'm1', 'm2', 'm3', 'm4'];
      for (const c of posted) await ctx.plugin.post(t, SENDER, c);

      const all = await drainAll(ctx.plugin, t);
      expect(all.map((m) => m.content)).toEqual(posted);
      const from = all[0]!.cursor; // page forward from the first message

      const seen: string[] = [];
      let since: string = from;
      for (let page = 0; page < 20; page++) {
        const res = await ctx.plugin.fetchRecent({ topic: t, since: since as never, limit });
        expect(res.messages.length).toBeLessThanOrEqual(limit);
        if (res.messages.length > 0) {
          expect(res.nextCursor).toBe(res.messages.at(-1)!.cursor);
          seen.push(...res.messages.map((m) => m.content));
        }
        if (res.messages.length === 0 || res.nextCursor === since) break;
        since = res.nextCursor;
      }
      expect(seen).toEqual(posted.slice(1)); // everything after m0, once, in order
    });

    // `since`-less means "the backend's default window" (seam.ts), and every shipped backend reads
    // that as the NEWEST `limit` messages. `parley_list_users` depends on it, yet nothing pinned
    // the direction — and core's own FakePlugin returns the OLDEST, so roster tests grade
    // semantics no backend implements.
    it('a since-less fetch returns the NEWEST messages, not the oldest', async () => {
      const t = ctx.freshTopic();
      const posted = ['w0', 'w1', 'w2', 'w3', 'w4'];
      for (const c of posted) await ctx.plugin.post(t, SENDER, c);

      const res = await ctx.plugin.fetchRecent({ topic: t, limit: 2 });
      expect(res.messages.map((m) => m.content)).toEqual(['w3', 'w4']);
      expect(res.nextCursor).toBe(res.messages.at(-1)!.cursor);
    });

    it('since at the tail returns empty and a stable cursor', async () => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'only');
      const tail = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;
      const drained = await ctx.plugin.fetchRecent({ topic: t, since: tail });
      expect(drained.messages).toEqual([]);
      expect(drained.nextCursor).toBe(tail);
    });

    it('fetchRecent on a never-posted topic returns an empty page with a replayable cursor', async () => {
      const t = ctx.freshTopic(); // no posts
      const first = await ctx.plugin.fetchRecent({ topic: t });
      expect(first.messages).toEqual([]);
      const again = await ctx.plugin.fetchRecent({ topic: t, since: first.nextCursor });
      expect(again.messages).toEqual([]);
      expect(again.nextCursor).toBe(first.nextCursor);
    });

    it('the same message has identical backendMsgId + cursor via live push and via catch-up', async () => {
      const t = ctx.freshTopic();
      const live: Message[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m));
      const id = await ctx.plugin.post(t, SENDER, 'x');
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

      const viaCatchUp = (await ctx.plugin.fetchRecent({ topic: t })).messages.find(
        (m) => m.content === 'x',
      );
      expect(viaCatchUp).toBeDefined();
      expect(live[0]!.backendMsgId).toBe(id);
      expect(live[0]!.backendMsgId).toBe(viaCatchUp!.backendMsgId);
      expect(live[0]!.cursor).toBe(viaCatchUp!.cursor);
      expectWellFormedMessage(live[0]!, { topic: t, content: 'x' });
    });

    // Both of subscribe's documented guarantees at once: it delivers exactly the post-subscribe
    // tail (never replaying history as if it were live — BUG-11, which has already bitten a
    // shipped backend) and it delivers in ascending cursor order.
    it('subscribe delivers exactly the post-subscribe tail, once, in cursor order', async () => {
      const t = ctx.freshTopic();
      const before = ['h0', 'h1', 'h2', 'h3', 'h4'];
      for (const c of before) await ctx.plugin.post(t, SENDER, c);

      const live: Message[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m));

      const after = ['n0', 'n1', 'n2'];
      for (const c of after) await ctx.plugin.post(t, SENDER, c);
      await vi.waitFor(() => expect(live.length).toBeGreaterThanOrEqual(after.length), {
        timeout: 5000,
        interval: 10,
      });

      // Delivery ORDER is the assertion; cursor VALUES are opaque and deliberately not comparable
      // (CLAUDE.md — core never compares cursors, and MAM archive ids are not lexically sortable).
      expect(live.map((m) => m.content)).toEqual(after); // no history replay, nothing extra
      expect(new Set(live.map((m) => m.backendMsgId)).size).toBe(after.length); // exactly once
      const viaCatchUp = await drainAll(ctx.plugin, t);
      expect(viaCatchUp.map((m) => m.content)).toEqual([...before, ...after]);
      // Live and catch-up agree on identity for the same messages, in the same order.
      expect(live.map((m) => m.backendMsgId)).toEqual(
        viaCatchUp.slice(before.length).map((m) => m.backendMsgId),
      );
    });

    it('topics are isolated', async () => {
      const a = ctx.freshTopic();
      const b = ctx.freshTopic();
      await ctx.plugin.post(a, SENDER, 'in-a');
      await ctx.plugin.post(b, SENDER, 'in-b');
      const fromA = (await ctx.plugin.fetchRecent({ topic: a })).messages;
      const fromB = (await ctx.plugin.fetchRecent({ topic: b })).messages;
      expect(fromA.map((m) => m.content)).toEqual(['in-a']);
      expect(fromB.map((m) => m.content)).toEqual(['in-b']);
      expectWellFormedMessage(fromA[0]!, { topic: a, content: 'in-a' });
      expectWellFormedMessage(fromB[0]!, { topic: b, content: 'in-b' });
    });

    it('resolveIdentity answers for the handle it was asked about', async () => {
      const id = await ctx.plugin.resolveIdentity(SENDER);
      expect(id.handle).toBe(SENDER);
      expect(typeof id.backendRef).toBe('string');
      expect(id.backendRef.length).toBeGreaterThan(0);
    });

    it('distinct senders are not collapsed onto one another', async () => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'from-first');
      await ctx.plugin.post(t, OTHER, 'from-second');
      const { messages } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages.map((m) => m.content)).toEqual(['from-first', 'from-second']);
      if (ctx.carriesSenderIdentity) {
        expect(messages.map((m) => m.senderHandle)).toEqual([SENDER, OTHER]);
      }
    });

    it('blockMs long-poll: returns promptly after a concurrent post, empty at timeout', async (testCtx) => {
      if (!ctx.supportsBlockingFetch) {
        testCtx.skip(); // backend gets long-poll from core's generic wrapper, not the plugin
        return;
      }
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'old');
      const tail = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;

      // (a) A blocked fetch at the tail wakes promptly when a message lands mid-wait.
      const started = Date.now();
      const pending = ctx.plugin.fetchRecent({ topic: t, since: tail, blockMs: 5000 });
      const posted = new Promise<void>((resolve) =>
        setTimeout(() => {
          void ctx.plugin.post(t, SENDER, 'fresh').then(() => resolve());
        }, 50),
      );
      const [woke] = await Promise.all([pending, posted]);
      expect(woke.messages.map((m) => m.content)).toEqual(['fresh']);
      expect(woke.nextCursor).not.toBe(tail); // cursor advanced
      // It woke on the message, not on the budget expiring.
      expect(Date.now() - started).toBeLessThan(4000);

      // (b) With nothing new, a blocked fetch returns an empty page with a stable cursor at timeout.
      const newTail = woke.nextCursor;
      const idleStarted = Date.now();
      const timedOut = await ctx.plugin.fetchRecent({ topic: t, since: newTail, blockMs: 300 });
      expect(timedOut.messages).toEqual([]);
      expect(timedOut.nextCursor).toBe(newTail);
      // It actually waited (did not return instantly) — allow generous slack for slow CI.
      expect(Date.now() - idleStarted).toBeGreaterThanOrEqual(150);
    });

    it('multi-process writes do not corrupt or error; cursor stays monotonic', async (testCtx) => {
      if (ctx.concurrentPost === 'unsupported') {
        testCtx.skip();
        return;
      }
      const t = ctx.freshTopic();
      const writers = 4;
      const perWriter = 25;
      await ctx.concurrentPost(t, writers, perWriter);

      const all = await drainAll(ctx.plugin, t);
      expect(all).toHaveLength(writers * perWriter);
      expect(new Set(all.map((m) => m.backendMsgId)).size).toBe(writers * perWriter);
      expect(new Set(all.map((m) => m.cursor)).size).toBe(writers * perWriter);

      // Cursor ordering is real: since the k-th message returns exactly the messages after it.
      const k = Math.floor(all.length / 2);
      const rest = await ctx.plugin.fetchRecent({ topic: t, since: all[k]!.cursor, limit: 10_000 });
      expect(rest.messages.map((m) => m.backendMsgId)).toEqual(
        all.slice(k + 1).map((m) => m.backendMsgId),
      );
    });
  });
}
