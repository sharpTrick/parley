import {
  asHandle,
  type BackendPlugin,
  type Message,
  parseMentions,
  type Topic,
} from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertConformanceContext, type BackendFactory, type ConformanceContext } from './factory.js';

export type { BackendFactory, ConformanceContext } from './factory.js';
export { assertConformanceContext, CONTEXT_FIELDS } from './factory.js';

const SENDER = asHandle('writer');
const OTHER = asHandle('second-writer');

const DRAIN_PAGE = 500;

/**
 * Read every message in `topic` by PAGING to exhaustion. It must not read one oversized page: a
 * backend with a server-side page cap below the request would silently return a prefix, and the
 * assertions built on it would grade a partial view.
 *
 * The FIRST page has no `since`, which the suite itself pins as the NEWEST `limit` messages — so a
 * full first page means the oldest messages are outside the window and paging forward can never
 * reach them. Keep the guard, so that a caller raising a volume past {@link DRAIN_PAGE} gets an
 * error naming the helper instead of a passing assertion over a silently truncated suffix.
 */
async function drainAll(plugin: BackendPlugin, topic: Topic): Promise<Message[]> {
  const out: Message[] = [];
  let since: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await plugin.fetchRecent({ topic, since: since as never, limit: DRAIN_PAGE });
    if (since === undefined && res.messages.length >= DRAIN_PAGE) {
      throw new Error(
        `drainAll(${topic}): the since-less first page returned ${res.messages.length} messages, ` +
          `filling the ${DRAIN_PAGE} limit — anything older is unreachable from here. Raise ` +
          `DRAIN_PAGE or lower the volume; do not grade a partial view.`,
      );
    }
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
  // `senderHandle` is asserted on every backend, not only the ones that round-trip `identity`:
  // whoever the sender turns out to be, core routes and displays it.
  expect(typeof m.senderHandle).toBe('string');
  expect(m.senderHandle.length).toBeGreaterThan(0);
  // `mentions` is what core's push loop filters on (transport/push-loop.ts) — a backend that
  // drops it delivers NOTHING once mention filtering is on. Compared against the content the
  // BACKEND returned, so a transport that rewrites mention syntax is still graded honestly.
  expect(m.mentions).toEqual(parseMentions(m.content));
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
      ctx = assertConformanceContext(name, await factory());
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

    // The content carries an @mention so `mentions` is asserted non-vacuously on BOTH paths: core's
    // push loop drops every message whose `mentions` misses the identity when filtering is on.
    it('the same message has identical backendMsgId + cursor via live push and via catch-up', async () => {
      const t = ctx.freshTopic();
      const body = `x for @${OTHER}`;
      const live: Message[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m));
      const id = await ctx.plugin.post(t, SENDER, body);
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

      const viaCatchUp = (await ctx.plugin.fetchRecent({ topic: t })).messages.find(
        (m) => m.content === body,
      );
      expect(viaCatchUp).toBeDefined();
      expect(live[0]!.backendMsgId).toBe(id);
      expect(live[0]!.backendMsgId).toBe(viaCatchUp!.backendMsgId);
      expect(live[0]!.cursor).toBe(viaCatchUp!.cursor);
      expectWellFormedMessage(live[0]!, { topic: t, content: body });
      expectWellFormedMessage(viaCatchUp!, { topic: t, content: body });
      expect(live[0]!.mentions).toContain(OTHER);
      expect(viaCatchUp!.mentions).toContain(OTHER);
    });

    // `post`'s `opts.inReplyTo` is part of the seam and core's post tool passes it
    // (transport/tools.ts), but no case ever supplied it — a plugin that 400s on a threaded reply,
    // or takes a different endpoint for one, was certified conformant. The seam surfaces no reply
    // field on Message, so the contract is exactly "accepted, and durable in order".
    it('post accepts inReplyTo and the reply is durable, in order', async () => {
      const t = ctx.freshTopic();
      const parent = await ctx.plugin.post(t, SENDER, 'question');
      const reply = await ctx.plugin.post(t, SENDER, 'answer', { inReplyTo: parent });
      expect(reply).not.toBe(parent);

      const { messages } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages.map((m) => m.content)).toEqual(['question', 'answer']);
      expect(messages.map((m) => m.backendMsgId)).toEqual([parent, reply]);
    });

    // Both of subscribe's documented guarantees at once: it delivers exactly the post-subscribe
    // tail (never replaying history as if it were live — a defect that has already bitten a
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

    // The same property on the OTHER delivery path. Every other subscribe case uses one topic, so a
    // plugin whose live path ignored the topic filter passed: core would then emit a `<channel>`
    // event for a topic the allowlist never admitted.
    it('topics are isolated on the live path too', async () => {
      const a = ctx.freshTopic();
      const b = ctx.freshTopic();
      const inA: Message[] = [];
      const inB: Message[] = [];
      await ctx.plugin.subscribe(a, (m) => inA.push(m));
      await ctx.plugin.subscribe(b, (m) => inB.push(m));

      await ctx.plugin.post(a, SENDER, 'live-a');
      await ctx.plugin.post(b, SENDER, 'live-b');
      await vi.waitFor(
        () => {
          expect(inA.length).toBeGreaterThanOrEqual(1);
          expect(inB.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000, interval: 10 },
      );

      expect(inA.map((m) => m.content)).toEqual(['live-a']);
      expect(inB.map((m) => m.content)).toEqual(['live-b']);
      for (const m of inA) expect(m.topic).toBe(a);
      for (const m of inB) expect(m.topic).toBe(b);
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
