import { asHandle, type Message, parseMentions } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAIN_PAGE, drainAll, expectWellFormedMessage } from './assertions.js';
import { type BackendFactory, type ConformanceContext, openContext } from './factory.js';

export { ASSERTED_PROPERTIES, CLAUSES } from './clauses.js';
export type { BackendFactory, ConformanceContext } from './factory.js';
export { assertConformanceContext, CONTEXT_FIELDS, openContext } from './factory.js';

const SENDER = asHandle('writer');
const OTHER = asHandle('second-writer');

/**
 * Wall-clock budget for the interleaved reader's give-up diagnostic. Keep it well UNDER the
 * harness's own `testTimeout`, so that the loop loses the race to its own message: a larger number
 * makes the one line naming the stuck topic unreachable and reports a generic timeout instead.
 */
const READER_BUDGET_MS = 15_000;

/**
 * How long a torn-down plugin is watched before its live path is called stopped. Long enough that a
 * subscription which outlived `disconnect()` has delivered, and far enough under the harness's own
 * per-case timeout that the assertion is what reports the leak.
 */
const TEARDOWN_SETTLE_MS = 500;

/**
 * Budget offered to the since-less blocking read. Keep it well under the harness's own per-case
 * timeout, so that a plugin which parks for the whole thing FAILS the bound below instead of being
 * killed by vitest — a generic timeout names neither the plugin's behaviour nor this clause.
 */
export const SINCELESS_BLOCK_MS = 12_000;

/**
 * How long that read may take. A bound compared against the BUDGET grades nothing: a plugin parking
 * for 95% of it still returns "under the budget", which is the hot path for every
 * `parley_fetch_recent` an agent makes before it holds a cursor. Keep this a fraction, so that the
 * assertion reads as "the plugin did not spend the budget".
 *
 * Keep the fraction between the slowest real backend and the parking control, so that widening it
 * for one does not certify the other: Matrix measures 4.1-4.8 s here against a live Synapse — a
 * room-provisioning positioning sync, not a park — and `BROKEN_VARIANTS`' parking plugin holds
 * {@link PARK_FRACTION} of the budget. A bound outside that window either reds a conformant backend
 * or greens the defect this clause exists to catch.
 */
export const SINCELESS_RETURN_MS = SINCELESS_BLOCK_MS * (2 / 3);

/**
 * The share of its budget the parking control spends. Keep it above
 * `SINCELESS_RETURN_MS / SINCELESS_BLOCK_MS`, so that the control still fails the bound it exists
 * to fail.
 */
export const PARK_FRACTION = 0.9;

/** Budget offered to the idle blocking read on the native arm — the one allowed to expire empty. */
export const IDLE_BLOCK_MS = 300;

/**
 * How much of that budget a plugin declaring NATIVE `blockMs` support must actually spend before it
 * reports "still nothing". A blocking read that answers at once is a long-poll core turns into a hot
 * loop against the backend, and it is the one native-blocking defect every other assertion in the
 * clause is blind to. Generous slack for slow CI: the control that fails this bound gives up at
 * {@link EARLY_RETURN_FRACTION} of the budget, an order of magnitude sooner rather than a hair.
 */
export const IDLE_BLOCK_FLOOR_MS = 150;

/**
 * The share of an idle budget the early-return control spends. Keep it well under
 * `IDLE_BLOCK_FLOOR_MS / IDLE_BLOCK_MS`, so that the control still fails the bound it exists to
 * fail — and above zero, so that it still wakes on a message like a conformant plugin.
 */
export const EARLY_RETURN_FRACTION = 0.1;

/** The volume the paging clause is graded over. Exported so its row generator can be self-tested. */
export const PAGING_VOLUME: readonly string[] = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];

/**
 * Page sizes that page DIFFERENTLY over `remaining` messages: one at a time, two exact divisions at
 * different depths, an uneven truncation, and exactly the remainder. Derived from the volume rather
 * than hard-coded, so that changing the message list cannot silently collapse several rows onto one
 * behaviour and drop the uneven truncation, which is where a page-boundary off-by-one lives.
 */
export const pageLimitsFor = (remaining: number): number[] =>
  [...new Set([1, 2, 3, remaining - 1, remaining])].filter((n) => n >= 1).sort((a, b) => a - b);

/**
 * The shared seam conformance suite (DESIGN §6; CLAUDE.md testing discipline). A backend
 * conforms iff: stable-unique backendMsgId AND monotonic, in-order, exclusive-`since` cursor
 * delivery. Write once here; run against every backend via {@link BackendFactory}.
 */
export function runConformanceSuite(name: string, factory: BackendFactory): void {
  describe(`seam conformance: ${name}`, () => {
    let ctx: ConformanceContext;
    let live: ConformanceContext | undefined;
    beforeEach(async () => {
      live = undefined;
      ctx = await openContext(name, factory);
      live = ctx;
    });
    afterEach(async () => {
      const done = live;
      live = undefined;
      await done?.cleanup();
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
    it.each(pageLimitsFor(PAGING_VOLUME.length - 1))('paging from a cursor with limit %i is lossless', async (limit) => {
      const t = ctx.freshTopic();
      for (const c of PAGING_VOLUME) await ctx.plugin.post(t, SENDER, c);

      const all = await drainAll(ctx.plugin, t);
      expect(all.map((m) => m.content)).toEqual(PAGING_VOLUME);
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
      expect(seen).toEqual(PAGING_VOLUME.slice(1)); // everything after m0, once, in order
    });

    // `since`-less means "the backend's default window" (seam.ts), and every shipped backend reads
    // that as the NEWEST `limit` messages, which `parley_list_users` depends on.
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

    // seam.ts permits TWO answers for a topic with no backend representation, so pinning one makes
    // the suite narrower than the seam it is written against. A backend states which arm it takes;
    // the default is the stricter one, so this cannot become a way to weaken the grade.
    it('fetchRecent on a never-posted topic returns an empty page with a replayable cursor', async () => {
      const t = ctx.freshTopic(); // no posts
      if ((ctx.absentTopicBehaviour ?? 'empty-page') === 'throws') {
        // The TYPE is the contract: core maps ONLY NoSuchTopicError to "topic not present yet", so
        // a plain rejection here is an outage, and the topic must be named for the operator.
        const err: unknown = await ctx.plugin.fetchRecent({ topic: t }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe('NoSuchTopicError');
        expect((err as { topic?: unknown }).topic).toBe(String(t));
        expect((err as Error).message).toContain(String(t));
        return;
      }
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

    // Every other case posts short ASCII ('a', 'same', 'm0'), so nothing else certifies that `post`
    // round-trips content at all: the same `parley_post` could behave four different ways across
    // certified backends. Refusing a payload is a visible, legitimate answer; altering it silently
    // is not. Carriage return is not a row YET: an XMPP body is XML character data, whose parser
    // normalizes CR to LF before any plugin sees it, so no plugin can round-trip one — but refusing
    // it is the arm this clause already permits, and bridge-xmpp accepts a CR and stores an LF. Add
    // the row when that plugin refuses; adding it first only reddens the backend.
    it.each([
      ['a newline', 'fidelity\nsecond line'],
      ['leading and trailing spaces', '  fidelity  '],
      ['an astral emoji', 'fidelity \u{1F600} done'],
      ['a combining sequence', 'fidelity e\u0301 vs \u00E9'],
      ['a tab', 'fidelity\tcolumn'],
    ])('post either round-trips %s exactly or refuses it', async (_label, content) => {
      const t = ctx.freshTopic();
      const posted: string | Error = await ctx.plugin.post(t, SENDER, content).then(
        (id) => String(id),
        (err: unknown) => err as Error,
      );
      if (posted instanceof Error) {
        expect(posted.message.length).toBeGreaterThan(0);
        return;
      }
      const { messages } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe(content);
      expect(messages[0]!.mentions).toEqual(parseMentions(content));
    });

    // `post`'s `opts.inReplyTo` is part of the seam and core's post tool passes it
    // (transport/tools.ts). The seam surfaces no reply field on Message, so the contract is exactly
    // "accepted, and durable in order" — a plugin that 400s on a threaded reply does not conform.
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

    // Every other subscribe case posts through the SAME client that registered the handler, so only
    // this one can see a plugin whose live path merely echoes its own writes — a loopback with no
    // server-side listener at all, which is precisely the case Parley exists for: a human posts in
    // chat, an agent must receive it. Two writers, because SQLite's fixture counts `ctx.plugin` as
    // one of the contending writers.
    it('subscribe delivers a message written by an independent client', async (testCtx) => {
      if (ctx.concurrentPost === 'unsupported') {
        testCtx.skip();
        return;
      }
      const t = ctx.freshTopic();
      const live: Message[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m));
      await ctx.concurrentPost(t, 2, 1);
      await vi.waitFor(() => expect(live.length).toBeGreaterThanOrEqual(2), {
        timeout: 5000,
        interval: 10,
      });

      const viaCatchUp = await drainAll(ctx.plugin, t);
      expect(viaCatchUp).toHaveLength(2);
      // Compared as SETS: two independent writers race, and the suite grades live ORDER against a
      // single writer elsewhere. What is graded here is that both writes arrived, exactly once,
      // under the same identity catch-up reports — the agreement core's dedup depends on.
      const ids = (ms: Message[]): string[] => ms.map((m) => String(m.backendMsgId)).sort();
      expect(live).toHaveLength(2);
      expect(ids(live)).toEqual(ids(viaCatchUp));
      for (const m of live) {
        expect(m.topic).toBe(t);
        expect(m.mentions).toEqual(parseMentions(m.content));
        expect(m.senderHandle.length).toBeGreaterThan(0);
      }
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

    // `disconnect()` tears down the connection AND all subscriptions, and keeps serving nothing
    // afterwards. The live half is graded by WATCHING the handler across a settle window: re-reading
    // `live` the instant teardown returns cannot fail, because nothing in between could have
    // delivered. What the window catches is the loop or socket that outlived `disconnect()` and went
    // round once more. Grading it with a fresh WRITE instead is out of reach — a fixture may
    // legitimately count `ctx.plugin` as one of the contending writers `concurrentPost` drives, as
    // bridge-sqlite's deliberately does, so no client here survives the teardown.
    it('disconnect is idempotent and stops the plugin serving', async () => {
      const t = ctx.freshTopic();
      const live: Message[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m));
      await ctx.plugin.post(t, SENDER, 'before-teardown');
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 5000, interval: 10 });

      await ctx.plugin.disconnect();
      await ctx.plugin.disconnect();

      await expect(ctx.plugin.post(t, SENDER, 'after-teardown')).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, TEARDOWN_SETTLE_MS));
      expect(live, 'a torn-down plugin delivered again — something outlived disconnect()').toHaveLength(
        1,
      );
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
      } else {
        // Declaring `identity` not carried buys a WEAKER contract, not none. Without this arm the
        // flag deletes every sender assertion, so a backend that scrambles or blanks `senderHandle`
        // — which core routes and displays — passes by flipping one boolean.
        expect(new Set(messages.map((m) => m.senderHandle)).size).toBe(1);
        expect(messages[0]!.senderHandle.length).toBeGreaterThan(0);
        expect(messages[0]!.backendMsgId).not.toBe(messages[1]!.backendMsgId);
      }
    });

    it('blockMs is honoured natively or ignored promptly — never a hang', async () => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'old');

      // The since-LESS arm, graded on BOTH capability arms. Core's long-poll wrapper issues its
      // first iteration with the caller's own `since` — undefined whenever the agent holds no cursor
      // yet — so this is the hot path for every `parley_fetch_recent` that carries a block budget and
      // no cursor. seam.ts and engine/blocking-fetch.ts agree: a default window that HAS messages
      // returns at once, and no other case here passes a `blockMs` without a `since`.
      const openedAt = Date.now();
      const opening = await ctx.plugin.fetchRecent({ topic: t, blockMs: SINCELESS_BLOCK_MS });
      const tail = opening.nextCursor;
      expect(opening.messages.map((m) => m.content)).toEqual(['old']);
      expect(
        Date.now() - openedAt,
        'sinceless-block-returns-promptly: a cursor-less read with a block budget parked instead ' +
          'of returning the default window it already had',
      ).toBeLessThan(SINCELESS_RETURN_MS);

      if (!ctx.supportsBlockingFetch) {
        // The hint is OPTIONAL; hanging on it is not. This is the only case in the suite that ever
        // passes `blockMs`, so nothing else can see a plugin that parks forever on it and stalls
        // `parley_fetch_recent` for its whole timeout.
        const startedIgnoring = Date.now();
        const ignored = await ctx.plugin.fetchRecent({ topic: t, since: tail, blockMs: 5000 });
        expect(ignored.messages).toEqual([]);
        expect(ignored.nextCursor).toBe(tail);
        expect(
          Date.now() - startedIgnoring,
          'ignored-block-returns-promptly: a plugin that declares no native blockMs support ' +
            'parked on the hint instead of ignoring it',
        ).toBeLessThan(1000);
        return;
      }

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
      expect(
        Date.now() - started,
        'native-block-wakes-on-the-message: it returned the message only once the budget expired',
      ).toBeLessThan(4000);

      // (b) With nothing new, a blocked fetch returns an empty page with a stable cursor at timeout.
      const newTail = woke.nextCursor;
      const idleStarted = Date.now();
      const timedOut = await ctx.plugin.fetchRecent({
        topic: t,
        since: newTail,
        blockMs: IDLE_BLOCK_MS,
      });
      expect(timedOut.messages).toEqual([]);
      expect(timedOut.nextCursor).toBe(newTail);
      expect(
        Date.now() - idleStarted,
        'native-block-actually-waits: a plugin declaring native blockMs support gave up on the ' +
          'budget at once, which makes core long-poll it in a hot loop',
      ).toBeGreaterThanOrEqual(IDLE_BLOCK_FLOOR_MS);
    });

    // The window between a blocking `fetchRecent` issuing its read and registering its waiter. A
    // message landing inside it is dropped by a plugin that parks at "from now" instead of at the
    // caller's cursor — and is then invisible until something else wakes the call. Only 0-3ms
    // discriminates: by ~5ms the waiter is registered and the case degenerates into the 50ms
    // long-poll case above, which is why that one never caught this.
    it.each([0, 1, 2, 3])('a post landing %ims into a blocking fetch is not missed', async (at) => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'old');
      const tail = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;
      const postLater = (): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(() => {
            void ctx.plugin.post(t, SENDER, 'racer').then(() => resolve());
          }, at);
        });

      if (!ctx.supportsBlockingFetch) {
        // The same hazard on a polling backend: a read racing the post must not report a cursor
        // ABOVE the message it did not see, or that message is lost for good.
        let landingFailure: unknown;
        const landing = postLater().catch((err: unknown) => {
          landingFailure = err;
        });
        const first = await ctx.plugin.fetchRecent({ topic: t, since: tail, blockMs: 2000 });
        await landing;
        if (landingFailure !== undefined) throw landingFailure;
        const second = await ctx.plugin.fetchRecent({
          topic: t,
          since: first.nextCursor,
          blockMs: 2000,
        });
        expect([...first.messages, ...second.messages].map((m) => m.content)).toEqual(['racer']);
        return;
      }

      // Issued BEFORE the post is scheduled and never awaited in between: awaiting it first is what
      // hides the window, because the post then always lands after the waiter exists.
      const pending = ctx.plugin.fetchRecent({ topic: t, since: tail, blockMs: 5000 });
      const [woke] = await Promise.all([pending, postLater()]);
      expect(woke.messages.map((m) => m.content)).toEqual(['racer']);
      expect(woke.nextCursor).not.toBe(tail);
    });

    // A store that mints a cursor from a PRE-COMMIT sequence (Postgres BIGSERIAL assigns `seq` at
    // INSERT, not COMMIT) can make cursor 42 visible while 41 is still uncommitted. A reader that
    // advances past 42 in that window can never fetch 41 again: durably stored, permanently
    // unreachable. The case above cannot see it — it reads only after every writer has settled,
    // when the gap has filled in — so this one puts the reader INSIDE the write window.
    it('a reader interleaved with concurrent writers loses no message', async (testCtx) => {
      if (ctx.concurrentPost === 'unsupported') {
        testCtx.skip();
        return;
      }
      const t = ctx.freshTopic();
      const writers = 4;
      const perWriter = 25;
      // Seed first: a cursor to read from has to exist before the writers start, and a backend
      // taking the throwing arm of the absent-topic contract has none until the topic does.
      await ctx.plugin.post(t, SENDER, 'seed');
      const start = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;

      const seen: string[] = [];
      let cursor = start;
      let writing = true;
      let readFailure: unknown;
      // The handler is attached AT CREATION, so that this budget expiring while the writers are
      // still in flight fails THIS case with the line naming the stuck topic: a rejection landing
      // before the `await` below has no handler at all, and surfaces as a process-level unhandled
      // rejection that takes every other case in the file with it.
      const readLoop = (async () => {
        const giveUpAt = Date.now() + READER_BUDGET_MS;
        while (Date.now() < giveUpAt) {
          // Sample `writing` BEFORE the fetch, so that an empty page taken while a writer was
          // still in flight cannot be read as "drained" once that writer lands — otherwise the
          // last row commits between the fetch and the check and the loop exits without it.
          const wasWriting = writing;
          const page = await ctx.plugin.fetchRecent({ topic: t, since: cursor, limit: DRAIN_PAGE });
          for (const m of page.messages) seen.push(String(m.backendMsgId));
          cursor = page.nextCursor;
          if (!wasWriting && page.messages.length === 0) return;
          // Keep the macrotask yield, so that a backend whose fetchRecent resolves synchronously
          // cannot starve the writers: on SQLite they are forked processes whose exit events never
          // fire inside a microtask-only loop, and the reader spins until the deadline.
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error(`the interleaved reader did not drain ${t}`);
      })().catch((err: unknown) => {
        readFailure = err;
      });

      await ctx.concurrentPost(t, writers, perWriter);
      writing = false;
      await readLoop;
      if (readFailure !== undefined) throw readFailure;

      const stored = (await drainAll(ctx.plugin, t)).slice(1).map((m) => String(m.backendMsgId));
      expect(stored).toHaveLength(writers * perWriter);
      const missed = stored.filter((id) => !seen.includes(id));
      expect(missed, 'the reader advanced past a row it can never fetch again').toEqual([]);
      expect(seen, 'the reader saw a message twice or out of order').toEqual(stored);
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
