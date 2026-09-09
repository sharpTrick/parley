import { asHandle, type Handle, type Message, parseMentions } from '@sharptrick/parley-core';
import {
  FAILURE_SHAPE_NAMES,
  FAILURE_SHAPES,
  unhandledDuring,
} from '@sharptrick/parley-core/testing';
import { expect, it, vi } from 'vitest';
import { drainAll, expectWellFormedMessage } from '../assertions.js';
import type { ConformanceContext } from '../factory.js';
import { OTHER } from '../handles.js';
import { CONTENT_SHAPES } from './content.js';

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
 * The range the tail case draws its in-flight burst from, per run. Every live case here used to put
 * at most THREE messages between a write and a delivery — the tail case sent three, the
 * independent-client case sends two and compares them as sets, and the quiet floor sends one at a
 * time — so a live path that reordered any burst wider than that satisfied the whole suite while
 * handing an agent a conversation out of sequence. DRAWN rather than named, for the same reason the
 * floor draws its depth: a path that shuffles only above a threshold can read a constant off this
 * package and sit above it.
 *
 * Ordering is a contract requirement (seam.ts clause 2) rather than a threshold, but what this
 * suite REACHES is still a width: bursts up to {@link BURST_POSTS_MAX}, and only
 * {@link BURST_POSTS_MIN} on every run. A path that hands back a burst wider than that in order and
 * shuffles nothing narrower is outside this suite's reach, and is recorded as such rather than
 * called closed.
 */
export const BURST_POSTS_MIN = 5;
export const BURST_POSTS_MAX = 8;

/**
 * Live subscriptions one connection is asked to hold at once. Two was the deepest any case went, so
 * a plugin that registered its first two and dropped every later one certified — and a real session
 * subscribes to every topic in its allowlist.
 *
 * REACH, not closure: what this figure buys is a control at a cap of two. A connection that
 * registers its first three subscriptions and ignores the fourth answers this suite honestly, and a
 * session whose allowlist is longer than this hears nothing on the rest.
 */
export const LIVE_SUBSCRIPTIONS = 3;

/**
 * A payload, and the handle it is written under, DRAWN per call. Every live case used to write from
 * a fixed vocabulary — `h0…h4`, `n0…n2`, `q0…`, `live-a`, and the one handle `writer` — so a plugin
 * that delivered only what matched it, and dropped everything else, passed all 34 cases while
 * carrying nothing a deployment would send. Nothing about a message this suite writes may be
 * knowable before the run: not its text, and not who wrote it.
 *
 * REACH, not closure: what the drawing forbids is a plugin keyed on a literal this package once
 * wrote. A plugin keyed on the SHAPE of what it draws — eight lowercase base-36 characters — is
 * still outside it, which is why the floor also carries {@link CONTENT_SHAPES} on the live path
 * rather than tokens alone.
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

/**
 * How long a faulted run is watched afterwards for an escaped rejection or a diagnostic. Both
 * arrive a turn or more after the delivery that caused them, so a case asserting the instant its
 * last message landed would assert before the failure it is looking for exists.
 */
const FAULT_SETTLE_MS = 250;

/** Owed deliveries per faulted run — sent one at a time, each awaited, so none may be dropped. */
const FAULTED_POSTS = 3;

/**
 * The ways a handler can fail that a `(msg: Message) => void` seam type does not forbid.
 * `subscribe` is handed a callback the plugin did not write — core's is the push loop, a consumer's
 * is whatever they passed — so every one of these is the CALLER's fault, and the live path owes the
 * rest of the topic regardless.
 *
 * The rejecting arms are the ones that end the bridge: a promise nothing attached to reaches Node's
 * default `--unhandled-rejections=throw`. An `instanceof` guard misses both the non-Error arm and
 * the non-native thenable, and AWAITING the handler — the obvious containment — trades the crash
 * for a stall, which is what the arm that never settles is here to forbid.
 *
 * Taken from core's own table rather than restated here, so that a shape added for ONE
 * fire-and-forget site is asked of every backend rather than of core alone. The list that used to
 * sit here had drifted: it carried an arm core's table did not, and core's table carried two this
 * clause never asked a backend for.
 */
const HANDLER_FAULTS: Array<[label: string, fault: () => unknown]> = FAILURE_SHAPE_NAMES.map(
  (shape) => [shape, (): unknown => FAILURE_SHAPES[shape](Promise.resolve())],
);

/** Where in a run of owed deliveries the handler fails. */
const FAULT_POSITIONS: Array<[where: string, faultsAt: (nth: number) => boolean]> = [
  ['on the first message of a run', (nth): boolean => nth === 0],
  ['in the middle of a run', (nth): boolean => nth === 1],
  ['on every message it is given', (): boolean => true],
];

/**
 * Every fault against every position. ONE row per pair rather than one row per shape driving three
 * runs, so that each row asks a connection for a single subscription {@link FAULTED_POSTS} deep —
 * the depth and the subscription count every other live case here already sits inside, which keeps
 * each `BROKEN_VARIANTS` control aimed at the one case it was calibrated against.
 */
/** How many positions each fault shape is graded at. Exported so the row count is derivable. */
export const FAULT_POSITIONS_PER_SHAPE = FAULT_POSITIONS.length;

const FAULT_MATRIX: Array<[label: string, fault: () => unknown, faultsAt: (nth: number) => boolean]> =
  HANDLER_FAULTS.flatMap(([label, fault]) =>
    FAULT_POSITIONS.map(
      ([where, faultsAt]) =>
        [`${label} ${where}`, fault, faultsAt] as [string, () => unknown, (nth: number) => boolean],
    ),
  );

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
    const after = Array.from({ length: between(BURST_POSTS_MIN, BURST_POSTS_MAX) }, livePayload);
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
    // not ordered by core (CLAUDE.md — ordering is the plugin's guarantee, and MAM archive ids
    // are not lexically sortable), so delivery ORDER is what carries it.
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
  // deeper than any other case subscribes over, an independent WRITER where the fixture has one, a
  // per-message LATENCY well inside what the suite will wait, and the CONTENT it carries — every
  // other live case here writes an eight-character lowercase token, so a path that drops anything
  // longer, anything non-ASCII, or anything with a newline in it delivered every message this suite
  // sent and nothing a person types. `BROKEN_VARIANTS` carries one control per axis; without them a
  // plugin that recognises the shape of the reads this suite makes passes it while dropping
  // everything a deployment sends — the class the blocking clause's own switch table exists to
  // forbid, on the live path.
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

    // The shapes this fixture DECLARED it can carry. A backend may refuse one — the write clause
    // permits that arm and grades the refusal against this same list — but the refusal is a
    // declaration, never a run-time fallback: while a rejection here silently retried as a bare
    // token, a backend refusing every shape on `post` and dropping every long, non-ASCII or
    // control-carrying message live was certified 36 of 36, which is the identical measurement
    // recorded for the defect the shared table was added to catch. The drawn depth is still the
    // depth EVERY backend is held to.
    const carries = CONTENT_SHAPES.filter(([label]) => !ctx.refusesContentShapes.includes(label));

    const sent: string[] = [];
    for (let i = 0, depth = between(QUIET_POSTS_MIN, QUIET_POSTS_MAX); i < depth; i++) {
      // Once, mid-run: nothing else here holds a subscription open long enough to ask whether it
      // is still alive, so a path that dies of age answers every other case exactly as a live one.
      if (i === QUIET_IDLE_AT) await sleep(QUIET_IDLE_MS);
      // The drawn token, carrying one shape from the table the write path is graded on. The draw
      // keeps the text unknowable; the shape is what makes the message something a person could
      // have sent.
      const shape = carries[i]?.[1];
      const token = livePayload();
      const content = shape === undefined ? token : `${token} ${shape}`;
      const sentAt = Date.now();
      await ctx.plugin.post(t, writer, content);
      sent.push(content);
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

  /**
   * DESIGN §6: the handler is best-effort, and its failure is the CALLER's. Three properties, so
   * that no two of them can be satisfied by the same accident — a plugin that "contains" a fault by
   * abandoning the topic passes the first alone, and one that contains it by awaiting the handler
   * passes the first two while a handler that never settles parks every later message behind it.
   * Ten backends carried this guarantee in a hand-written comment that no test could tell from its
   * absence; four of the ten had no grade for it anywhere.
   */
  it.each(FAULT_MATRIX)('a live path survives a handler that %s', async (_label, fault, faultsAt) => {
    const noise: string[] = [];
    const onStderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
      noise.push(String(chunk));
      return true;
    });
    const onConsole = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]): void => {
      noise.push(args.map((a) => String(a)).join(' '));
    });
    const writer = liveWriter();
    try {
      // Collected per row rather than left to the runner's global accounting, so the row that
      // produced the escape is the row that fails. `unhandledDuring` listens for BOTH shapes: a
      // synchronous throw that leaves a detached task is an `uncaughtException`, not a rejection,
      // and a rejection-only listener reports it as clean while the run exits non-zero with no row
      // red — green to anything reading the report.
      const escaped = await unhandledDuring(async () => {
        const t = ctx.freshTopic();
        const offered: string[] = [];
        const sent: string[] = [];
        let nth = 0;
        await ctx.plugin.subscribe(t, (m) => {
          offered.push(m.content);
          return faultsAt(nth++) ? fault() : undefined;
        });

        for (let i = 0; i < FAULTED_POSTS; i++) {
          const content = livePayload();
          await ctx.plugin.post(t, writer, content);
          sent.push(content);
          await delivered(DELIVERY_MS, () =>
            expect(
              offered,
              'handler-fault-does-not-stop-delivery: a failing handler took the rest of the topic ' +
                'down with it. The messages were sent one at a time, each awaited before the ' +
                'next, so none of them is a burst a delivery window may drop — and the failure is ' +
                'the consumer\'s, never the backend\'s',
            ).toEqual(sent),
          );
        }

        await sleep(FAULT_SETTLE_MS);
      });

      expect(
        escaped,
        'handler-fault-reaches-no-unhandled-rejection: a handler\'s failure escaped to the ' +
          'process. The seam types the handler `=> void`, which does not forbid an `async` one, ' +
          'and under Node\'s default `--unhandled-rejections=throw` an unattached rejection ends ' +
          'the whole bridge — every topic, not just this one. A synchronous throw that leaves a ' +
          'detached task arrives here as an uncaughtException and ends it just the same',
      ).toEqual([]);
      expect(
        noise,
        'handler-fault-is-not-a-backend-failure: the plugin diagnosed a consumer fault as its own. ' +
          'A backend that counts it toward a failure ladder backs a perfectly healthy topic off, ' +
          'which is how a live path "contains" a fault by going quiet',
      ).toEqual([]);
    } finally {
      onStderr.mockRestore();
      onConsole.mockRestore();
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
