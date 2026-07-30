import {
  asHandle,
  type BackendPlugin,
  type Message,
  parseMentions,
  type Topic,
} from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BackendFactory, type ConformanceContext, openContext } from './factory.js';

export type { BackendFactory, ConformanceContext } from './factory.js';
export { assertConformanceContext, CONTEXT_FIELDS, openContext } from './factory.js';

const SENDER = asHandle('writer');
const OTHER = asHandle('second-writer');

const DRAIN_PAGE = 500;

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

/** The volume the paging clause is graded over. Exported so its row generator can be self-tested. */
export const PAGING_VOLUME: readonly string[] = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];

/**
 * Page sizes that page DIFFERENTLY over `remaining` messages: one at a time, two exact divisions at
 * different depths, an uneven truncation, and exactly the remainder. Derived from the volume rather
 * than hard-coded, so that changing the message list cannot silently collapse several rows onto one
 * behaviour — `[1, 2, 4, 5, 6]` over 4 remaining ran the same single-page case three times and never
 * ran the uneven truncation at all, which is where a page-boundary off-by-one lives.
 */
export const pageLimitsFor = (remaining: number): number[] =>
  [...new Set([1, 2, 3, remaining - 1, remaining])].filter((n) => n >= 1).sort((a, b) => a - b);

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
 * Every clause this suite grades, as a phrase that must appear in the title of a case it registers.
 *
 * A conformance clause could previously be deleted with nothing anywhere going red — the suite's own
 * self-tests pinned a case count and one title — and eleven backends would keep being certified
 * against the weakened suite while the README kept advertising the clause. This table is what makes
 * a deletion or a rename a failure in THIS package. Adding a case means adding its clause here.
 */
export const CLAUSES: readonly string[] = [
  'in order, with unique ids and distinct cursors',
  'the same content posted twice',
  'only newer messages (exclusive)',
  'paging from a cursor with limit',
  'returns the NEWEST messages',
  'since at the tail',
  'never-posted topic',
  'via live push and via catch-up',
  'either round-trips',
  'post accepts inReplyTo',
  'exactly the post-subscribe tail',
  'written by an independent client',
  'topics are isolated',
  'on the live path too',
  'disconnect is idempotent',
  'resolveIdentity answers',
  'not collapsed onto one another',
  'blockMs is honoured natively or ignored promptly',
  'blocking fetch is not missed',
  'interleaved with concurrent writers',
  'multi-process writes',
];

/**
 * What the suite asserts that is neither a `Message` FIELD nor a seam CALL. The clause↔variant and
 * field↔variant mappings both stop above these, which is how five cursor and limit assertions could
 * be deleted at once — negative control included — with this package staying green. Each term owns a
 * `BROKEN_VARIANTS` entry, exactly as every `Message` field does.
 *
 * - `nextCursor-agreement`: a page's `nextCursor` is the cursor of the last row IT returned, never
 *   the topic's tail — reporting the tail on a truncated page drops everything in between.
 * - `nextCursor-stability`: an empty page's cursor does not move, so a drained catch-up loop stays
 *   drained instead of re-reading the window forever.
 * - `limit-honoured`: a page never carries more rows than `limit`.
 * - `disconnect-stops-live-delivery`: nothing reaches a handler after `disconnect()` — the loop or
 *   socket that goes round once more decides whether core keeps emitting `<channel>` events for a
 *   backend it believes is gone, and whether the MCP process can exit.
 */
export const ASSERTED_PROPERTIES: readonly string[] = [
  'nextCursor-agreement',
  'nextCursor-stability',
  'limit-honoured',
  'disconnect-stops-live-delivery',
];

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
      const posted = PAGING_VOLUME;
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

    // seam.ts permits TWO answers for a topic with no backend representation, and pinning one of
    // them made the suite narrower than the seam it is written against — a plugin taking the
    // documented alternative failed conformance, while core's NoSuchTopicError mapping had no
    // producer anywhere to grade it. A backend states which arm it takes; the default is the
    // stricter one, so this cannot become a way to weaken the grade.
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

    // `post`'s `opts.inReplyTo` is part of the seam and core's post tool passes it
    // (transport/tools.ts), but no case ever supplied it — a plugin that 400s on a threaded reply,
    // or takes a different endpoint for one, was certified conformant. The seam surfaces no reply
    // field on Message, so the contract is exactly "accepted, and durable in order".
    // Every other case posts short ASCII ('a', 'same', 'm0'), so nothing certified that `post`
    // round-trips content AT ALL. Carriage return is not a row YET: an XMPP body is XML character
    // data, whose parser normalizes CR to LF before any plugin sees it, so no plugin can round-trip
    // one — but refusing it is the arm this clause already permits, and bridge-xmpp accepts a CR and
    // stores an LF. Add the row when that plugin refuses; adding it first only reddens the backend.
    // The same `parley_post` could behave four different ways across
    // certified backends, and a backend that silently rewrote or truncated a payload would pass in
    // full. Refusing a payload is a visible, legitimate answer; altering it silently is not.
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

    // Every other subscribe case posts through the SAME client that registered the handler, so a
    // plugin whose live path merely echoes its own writes — a loopback that registers no
    // server-side listener at all — passed conformance in full. That is precisely the case Parley
    // exists for: a human posts in chat, an agent must receive it. `concurrentPost` is the
    // independent writer the context can already hand out; two of them, because SQLite's fixture
    // counts `ctx.plugin` as one of the contending writers.
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


    // `disconnect()` is declared to tear down the connection AND all subscriptions, but the suite
    // only ever called it from `cleanup()` and asserted nothing about it — so a plugin that leaves
    // its poll loop or socket running, or that keeps serving `post` afterwards, was certified.
    // The live half is graded by WATCHING the handler across a settle window: re-reading `live` the
    // instant teardown returns cannot fail, because nothing in between could have delivered. What
    // the window catches is the loop or socket that outlived `disconnect()` and went round once
    // more. Grading it with a fresh WRITE instead is still out of reach — a fixture may legitimately
    // count `ctx.plugin` as one of the contending writers `concurrentPost` drives, as
    // bridge-sqlite's deliberately does, so there is no client here that survives the teardown.
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

      // The since-LESS arm, graded on BOTH capability arms and carried by the fetch this case
      // already had to make. Core's long-poll wrapper issues its first iteration with the caller's
      // own `since` — undefined whenever the agent holds no cursor yet — so this is the hot path
      // for every `parley_fetch_recent` that carries a block budget and no cursor. seam.ts and
      // engine/blocking-fetch.ts agree here: a default window that HAS messages returns at once.
      // Every other case in this suite passes a `since`, so nothing else can see a plugin that
      // parks instead and holds the tool open for its whole budget.
      const openedAt = Date.now();
      const opening = await ctx.plugin.fetchRecent({ topic: t, blockMs: SINCELESS_BLOCK_MS });
      const tail = opening.nextCursor;
      expect(opening.messages.map((m) => m.content)).toEqual(['old']);
      expect(Date.now() - openedAt).toBeLessThan(SINCELESS_RETURN_MS);

      if (!ctx.supportsBlockingFetch) {
        // The hint is OPTIONAL; hanging on it is not. This is the only case in the suite that ever
        // passes `blockMs`, so a plugin that parks forever on it — the worst behaviour available,
        // stalling `parley_fetch_recent` for its whole timeout — used to be certified by the skip.
        const startedIgnoring = Date.now();
        const ignored = await ctx.plugin.fetchRecent({ topic: t, since: tail, blockMs: 5000 });
        expect(ignored.messages).toEqual([]);
        expect(ignored.nextCursor).toBe(tail);
        expect(Date.now() - startedIgnoring).toBeLessThan(1000);
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
        const landing = postLater();
        const first = await ctx.plugin.fetchRecent({ topic: t, since: tail, blockMs: 2000 });
        await landing;
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
      })();

      await ctx.concurrentPost(t, writers, perWriter);
      writing = false;
      await readLoop;

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
