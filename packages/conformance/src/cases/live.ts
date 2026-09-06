import { asHandle, type Handle, type Message, parseMentions } from '@sharptrick/parley-core';
import { expect, it, vi } from 'vitest';
import { drainAll, expectWellFormedMessage } from '../assertions.js';
import type { ConformanceContext } from '../factory.js';
import { OTHER } from '../handles.js';

/**
 * How long a torn-down plugin is watched before its live path is called stopped. Long enough that a
 * subscription which outlived `disconnect()` has delivered, and far enough under the harness's own
 * per-case timeout that the assertion is what reports the leak.
 */
const TEARDOWN_SETTLE_MS = 500;

/** How long a handler is watched for a delivery; the echo case, writing to itself, waits less. */
export const DELIVERY_MS = 5_000;
const ECHO_MS = 3_000;

/**
 * The deepest single-topic live delivery any OTHER case here requires — the figure a plugin could
 * infer from the rest of the suite and cap itself at. The floor below draws its own depth from a
 * range that starts strictly above it, so a cap at exactly this figure fails every run rather than
 * the lucky ones; `BROKEN_VARIANTS` carries that row.
 */
export const QUIET_POSTS = 3;

/**
 * The range the floor's depth is DRAWN from, per run. Drawn rather than named, because a live path
 * that dies at a threshold can only be caught by a suite whose depth it cannot read off a constant —
 * the same reason the blocking clause draws its budgets. The bottom of the range is what every run
 * is guaranteed to reach, so it is also the figure the far-edge control sits one below.
 */
export const QUIET_POSTS_MIN = 10;
const QUIET_POSTS_MAX = 13;

/**
 * Rows the floor's topic already holds when its subscription opens. Above the deepest topic any
 * other case here subscribes to, so a live path that goes quiet once a topic is BUSY — rather than
 * once it has delivered a few messages — is reached in this case and nowhere else.
 */
export const QUIET_BACKLOG_ROWS = 10;

/**
 * How long the floor leaves a live subscription idle, once, mid-run. Every other case here delivers
 * within milliseconds of `subscribe`, so a live path that dies of AGE — a socket the server closes,
 * a poll loop that stops rescheduling, a queue whose registration expires — answers all of them.
 */
export const QUIET_IDLE_MS = 1_000;

/**
 * How long ONE message may take to arrive on a live path. `DELIVERY_MS` is how long the suite
 * WAITS; without a bound well inside it a plugin that delivers seconds late is certified, and core
 * holds nothing open for a `<channel>` event, so late is a message an agent acts on after the turn
 * it belonged to.
 */
export const QUIET_DELIVERY_MS = 2_500;

/** Which quiet post the idle span precedes. */
const QUIET_IDLE_AT = 1;

/**
 * Messages the tail case leaves in flight at once. Four is the floor, not a taste: every live case
 * here used to put at most THREE messages between a write and a delivery — the tail case sent three,
 * the independent-client case sends two and compares them as sets, and the quiet floor sends one at
 * a time — so a live path that reordered any burst wider than that satisfied the whole suite while
 * handing an agent a conversation out of sequence. Ordering is a contract requirement (seam.ts
 * clause 2), not a threshold, which is why this one is closed rather than recorded as reach.
 */
const BURST_POSTS = 5;

/**
 * Live subscriptions one connection is asked to hold at once. Two was the deepest any case went, so
 * a plugin that registered its first two and dropped every later one certified — and a real session
 * subscribes to every topic in its allowlist.
 */
export const LIVE_SUBSCRIPTIONS = 3;

/**
 * A payload, and the handle it is written under, DRAWN per call. Every live case used to write from
 * a fixed vocabulary — `h0…h4`, `n0…n2`, `q0…`, `live-a`, and the one handle `writer` — so a plugin
 * that delivered only what matched it, and dropped everything else, passed all 34 cases while
 * carrying nothing a deployment would send. Nothing about a message this suite writes may be
 * knowable before the run: not its text, and not who wrote it.
 *
 * Exported because `BROKEN_VARIANTS` stands up a plugin keyed on the OLD vocabulary, and that
 * control only fails while these really are drawn.
 */
const token = (): string => Math.random().toString(36).slice(2, 10);

export const livePayload = (): string =>
  `${String.fromCharCode(97 + Math.floor(Math.random() * 26))}${token()}`;

export const liveWriter = (): Handle => asHandle(livePayload());

/**
 * Writers the floor asks for where the fixture can represent them. Two, because a fixture may
 * legitimately count `ctx.plugin` as one of the contending writers `concurrentPost` drives, as
 * bridge-sqlite's deliberately does.
 */
const INDEPENDENT_WRITERS = 2;

const delivered = (within: number, arrived: () => void): Promise<void> =>
  vi.waitFor(arrived, { timeout: within, interval: 10 });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const between = (low: number, high: number): number =>
  low + Math.floor(Math.random() * (high - low + 1));

/** The push path: what `subscribe` delivers, to which topic, and what `disconnect` stops. */
export function liveCases(ctx: ConformanceContext): void {
  // The content carries an @mention so `mentions` is asserted non-vacuously on BOTH paths: core's
  // push loop drops every message whose `mentions` misses the identity when filtering is on.
  it('the same message has identical backendMsgId + cursor via live push and via catch-up', async () => {
    const t = ctx.freshTopic();
    const body = `${livePayload()} for @${OTHER}`;
    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));
    const id = await ctx.plugin.post(t, liveWriter(), body);
    await delivered(ECHO_MS, () => expect(live).toHaveLength(1));

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

  // subscribe's UPPER bound: whatever it delivers is drawn from the post-subscribe tail, in cursor
  // order, never twice. It is NOT required to deliver all of it — a burst wider than a backend's
  // delivery window is reconciled by catch-up, which is asserted here as the other half of the
  // bargain. Replaying history as if it were live is a superset, and still forbidden.
  it('subscribe delivers only the post-subscribe tail, in cursor order, never twice', async () => {
    const t = ctx.freshTopic();
    const writer = liveWriter();
    const before = Array.from({ length: 5 }, livePayload);
    for (const c of before) await ctx.plugin.post(t, writer, c);

    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));

    // Sent back to back with nothing waited for in between, so more than three are in flight at
    // once: what a delivery window sees here is a BATCH, and the order it hands that batch over in
    // is the only thing this case can grade that the one-at-a-time floor below cannot.
    const after = Array.from({ length: BURST_POSTS }, livePayload);
    for (const c of after) await ctx.plugin.post(t, writer, c);
    // The whole tail is WAITED for and never required: a backend whose delivery window cannot cover
    // a burst may drop ALL of it and stay conformant (DESIGN §6), so a floor asserted here would be
    // stricter than the contract this case grades. What requires delivery at all is the case below.
    // Bounded by the per-message figure that case holds a backend to, so a lossy backend does not
    // spend the whole delivery window on an outcome the contract permits.
    const settleBy = Date.now() + QUIET_DELIVERY_MS;
    while (live.length < after.length && Date.now() < settleBy) await sleep(20);

    // A SUBSEQUENCE of the tail, which is one assertion for three properties: nothing from before
    // the subscribe, nothing twice, nothing out of order. Cursor VALUES are opaque and deliberately
    // not comparable (CLAUDE.md — core never compares cursors, and MAM archive ids are not
    // lexically sortable), so delivery ORDER is what carries it.
    const seen = live.map((m) => m.content);
    expect(
      seen,
      'the live path handed a burst over out of cursor order — order is a plugin guarantee ' +
        '(seam.ts clause 2), and a subset may be shorter than the tail but never shuffled',
    ).toEqual(after.filter((c) => seen.includes(c)));
    expect(new Set(live.map((m) => String(m.backendMsgId))).size).toBe(live.length);

    // The other half of the bargain: what push left out, catch-up returns — under the same identity
    // core's dedup depends on.
    const viaCatchUp = await drainAll(ctx.plugin, t);
    expect(viaCatchUp.map((m) => m.content)).toEqual([...before, ...after]);
    const byContent = new Map(viaCatchUp.map((m) => [m.content, m]));
    for (const m of live) {
      expect(String(m.backendMsgId)).toBe(String(byContent.get(m.content)?.backendMsgId));
      expect(String(m.cursor)).toBe(String(byContent.get(m.content)?.cursor));
    }
  });

  // The FLOOR under the subset above. `only the post-subscribe tail` is satisfied by any PREFIX of
  // that tail, the empty one included, so a live path that serves the first message and then stops
  // answers every other live clause in this file — and so, on the arm where `concurrentPost` cannot
  // represent a second writer, does one that never registers a listener at all. What a delivery
  // window cannot cover is a BURST, so a topic written one message at a time, each delivered before
  // the next is sent, loses nothing and is owed all of it.
  //
  // Held along every axis a live path can die along rather than at one threshold in one window: a
  // DEPTH drawn from a range no constant names, an AGE past what any other case waits, a BACKLOG
  // deeper than any other case subscribes over, an independent WRITER where the fixture has one,
  // and a per-message LATENCY well inside what the suite will wait. `BROKEN_VARIANTS` carries one
  // control per axis; without them a plugin that recognises the shape of the reads this suite makes
  // passes it while dropping everything a deployment sends — the class the blocking clause's own
  // switch table exists to forbid, on the live path.
  it('a live subscriber does not fall behind a quiet topic', async () => {
    const t = ctx.freshTopic();
    const writer = liveWriter();
    for (let i = 0; i < QUIET_BACKLOG_ROWS; i++) await ctx.plugin.post(t, writer, livePayload());

    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));

    // Where the fixture has a second writer, the first thing this live path is asked to carry comes
    // from one — an echo of the subscriber's own writes satisfies every step below.
    const writers = ctx.concurrentPost;
    const independent = writers === 'unsupported' ? 0 : INDEPENDENT_WRITERS;
    if (writers !== 'unsupported') {
      await writers(t, INDEPENDENT_WRITERS, 1);
      await delivered(DELIVERY_MS, () =>
        expect(
          live.length,
          'the live path carried nothing written by anyone but the subscriber — a loopback that ' +
            'echoes this client\'s own posts satisfies every other step of this case',
        ).toBeGreaterThanOrEqual(independent),
      );
    }

    const sent: string[] = [];
    for (let i = 0, depth = between(QUIET_POSTS_MIN, QUIET_POSTS_MAX); i < depth; i++) {
      // Once, mid-run: nothing else here holds a subscription open long enough to ask whether it
      // is still alive, so a path that dies of age answers every other case exactly as a live one.
      if (i === QUIET_IDLE_AT) await sleep(QUIET_IDLE_MS);
      const content = livePayload();
      sent.push(content);
      const sentAt = Date.now();
      await ctx.plugin.post(t, writer, content);
      await delivered(DELIVERY_MS, () =>
        expect(
          live.map((m) => m.content).slice(independent),
          'the live path fell behind a topic written one message at a time, waiting for each to ' +
            'arrive before sending the next — a subset is what a delivery window cannot cover, ' +
            'not a licence to deliver nothing, nor to deliver something else',
        ).toEqual(sent),
      );
      expect(
        Date.now() - sentAt,
        'live-delivery-is-prompt: a message took longer to reach the handler than a live path may ' +
          'take. Core holds nothing open for a <channel> event, so a delivery this late is one the ' +
          'agent acts on after the turn it belonged to',
      ).toBeLessThan(QUIET_DELIVERY_MS);
    }
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
    await delivered(DELIVERY_MS, () => expect(live.length).toBeGreaterThanOrEqual(2));

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

  // The same property on the OTHER delivery path. Every other subscribe case uses one topic, so a
  // plugin whose live path ignored the topic filter passed: core would then emit a `<channel>`
  // event for a topic the allowlist never admitted.
  it('topics are isolated on the live path too', async () => {
    const writer = liveWriter();
    const topics = Array.from({ length: LIVE_SUBSCRIPTIONS }, () => ctx.freshTopic());
    const got: Message[][] = topics.map(() => []);
    for (const [i, t] of topics.entries()) {
      await ctx.plugin.subscribe(t, (m) => got[i]!.push(m));
    }

    const sent = topics.map(livePayload);
    for (const [i, t] of topics.entries()) await ctx.plugin.post(t, writer, sent[i]!);
    await delivered(DELIVERY_MS, () => {
      for (const each of got) {
        expect(
          each.length,
          'a subscription this connection opened after its first two carried nothing — a session ' +
            'subscribes to every topic in its allowlist, and a plugin holding a fixed listener ' +
            'pool answers the first few and silently ignores the rest',
        ).toBeGreaterThanOrEqual(1);
      }
    });

    for (const [i, t] of topics.entries()) {
      expect(
        got[i]!.map((m) => m.content),
        "a live subscription carried another topic's message",
      ).toEqual([sent[i]]);
      for (const m of got[i]!) expect(m.topic).toBe(t);
    }
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
    const writer = liveWriter();
    await ctx.plugin.post(t, writer, livePayload());
    await delivered(DELIVERY_MS, () => expect(live).toHaveLength(1));

    await ctx.plugin.disconnect();
    await ctx.plugin.disconnect();

    await expect(ctx.plugin.post(t, writer, livePayload())).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, TEARDOWN_SETTLE_MS));
    expect(live, 'a torn-down plugin delivered again — something outlived disconnect()').toHaveLength(
      1,
    );
  });
}
