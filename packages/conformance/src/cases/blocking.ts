import {
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  isBlockingFetchUnsupportedError,
  MAX_BLOCK_MS,
  type Topic,
} from '@sharptrick/parley-core';
import { expect, it } from 'vitest';
import { expectSeamSentinel } from '../assertions.js';
import {
  CALLER_BLOCK_FLOOR_FRACTION,
  CALLER_BLOCK_RETURN_MS,
  IDLE_BLOCK_CEILING_MS,
  IDLE_BLOCK_FLOOR_MS,
  IDLE_BLOCK_MS,
  PROBE_MAX_BLOCK_MS,
  RACE_BLOCK_MS,
  RACE_RETURN_MS,
  REFUSAL_RETURN_MS,
  SERVED_BLOCK_FLOOR_FRACTION,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
  STABILITY_CALLER_READS,
  STABILITY_DEEP_TOPIC_ROWS,
  STABILITY_LONG_BLOCK_MAX_MS,
  STABILITY_LONG_BLOCK_MIN_MS,
  STABILITY_LONG_READS,
  STABILITY_READS_MAX,
  STABILITY_READS_MIN,
  STABILITY_SHORT_BLOCK_MAX_MS,
  STABILITY_SHORT_BLOCK_MIN_MS,
  STABILITY_SPAN_MS,
  STABILITY_TOPICS,
  TAIL_BLOCK_MS,
} from '../budgets.js';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';

/** What a read carrying a block budget answered with: a page, or the backend's refusal. */
type BlockingOutcome = FetchRecentResult | 'refused';

/** The arm such a read took. */
type BlockingArm = 'refused' | 'served';

/** One blocking read as it happened — the only evidence of which arm a backend is really on. */
interface BlockingRead {
  arm: BlockingArm;
  budgetMs: number;
  elapsedMs: number;
  emptyPage: boolean;
}

const between = (low: number, high: number): number =>
  low + Math.floor(Math.random() * (high - low + 1));

const probeBudget = (): number => 1 + Math.floor(Math.random() * PROBE_MAX_BLOCK_MS);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A budget the size a real caller sends, drawn against the ceiling CORE enforces rather than a copy
 * of it — `catchup.block_max_ms` may be set anywhere up to {@link MAX_BLOCK_MS}, and the skill this
 * repo ships tells an agent to send 55 000. Larger than the harness's own per-case ceiling by
 * design; every read that carries one is raced against {@link CALLER_BLOCK_RETURN_MS}, so this is a
 * figure handed to a plugin and never a wait this suite sits through.
 */
/** When the write the caller-scale wake read parks on lands — far inside every budget above. */
const WAKE_POST_MS = 50;

const callerScaleBudget = (): number =>
  between(Math.floor(MAX_BLOCK_MS * CALLER_BLOCK_FLOOR_FRACTION), MAX_BLOCK_MS);

/**
 * The budgets the stability run hands out, shuffled: a fixed few long enough that the run really
 * covers {@link STABILITY_SPAN_MS}, the rest short. None of them is a figure the suite hardcodes
 * anywhere else, so a plugin cannot recognise the reads it is about to be asked and answer only
 * those honestly.
 */
function stabilityBudgets(): number[] {
  const count = between(STABILITY_READS_MIN, STABILITY_READS_MAX);
  const budgets = Array.from({ length: count }, (_, i) =>
    i < STABILITY_LONG_READS
      ? between(STABILITY_LONG_BLOCK_MIN_MS, STABILITY_LONG_BLOCK_MAX_MS)
      : between(STABILITY_SHORT_BLOCK_MIN_MS, STABILITY_SHORT_BLOCK_MAX_MS),
  );
  for (let i = budgets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [budgets[i], budgets[j]] = [budgets[j] as number, budgets[i] as number];
  }
  return budgets;
}

/**
 * The `blockMs` contract: honoured natively — waits, wakes on arrival, and does not overshoot — or
 * REFUSED, naming the backend. Never silently ignored, never a hang.
 *
 * One contract for every backend. There is no declaration to take a backend's word for: which arm a
 * plugin is on is decided by what it does when a budget reaches it, so a plugin that answers a
 * budget with the page it already had is graded on the arm that requires it to have waited.
 *
 * Inferring the arm costs what a declaration did not: it has to be read off calls a plugin can see
 * coming. So it is graded two ways at once, and both span the whole file rather than one case. Which
 * arm a read took is recorded ACROSS every case here — a backend that answers `block_ms` one way on
 * this connection and another way on the next has changed the contract under a caller who cannot see
 * connections at all. And every SERVED read that came back EMPTY must have spent its budget, so a
 * backend that stays nominally on the serving arm while silently dropping the budget is graded on
 * the arm it claims rather than on the label.
 *
 * What that buys is bounded and the bound is the point: a finite run cannot catch a switch at an
 * arbitrary threshold, so what is held is the class up to this run's REACH — the reads it makes, the
 * budgets it hands out, the topics it names and the wall clock it covers, each of which
 * `ARM_SWITCHES` has a control sitting at the far edge of.
 */
export function blockingCases(ctx: ConformanceContext): void {
  // Resolves only once the write has LANDED, so a case cannot conclude on a message the backend has
  // not accepted yet. Keep BOTH settle paths bound, so that a `post` rejecting mid-case — a flood
  // wait, a revoked token — fails this case by name instead of leaving it pending for the whole
  // timeout while raising a process-level unhandled rejection against whichever case is running.
  const postAfter = (topic: Topic, delayMs: number, content: string): Promise<void> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        void ctx.plugin.post(topic, SENDER, content).then(() => resolve(), reject);
      }, delayMs);
    });

  /** Every read this file has made carrying a budget, over every case and every connection. */
  const taken: BlockingRead[] = [];

  /**
   * A read carrying a budget the size an agent sends, raced against a bound this suite can afford.
   * Every caller-scale budget goes through here, so one a plugin decides to park on fails by NAME
   * instead of being killed by vitest with a diagnostic that names no clause — and the case is never
   * held for the minutes such a budget would otherwise buy.
   */
  const PARKED = Symbol('parked');
  const callerScaleRead = async (args: FetchRecentArgs): Promise<void> => {
    const pending = read(args);
    // The timer arm can win, and a rejection landing after it would otherwise reach the process
    // unhandled and be attributed to whichever unrelated case is running by then.
    let late: unknown;
    const guarded = pending.catch((err: unknown) => {
      late = err;
      return PARKED;
    });
    const answered = await Promise.race([guarded, sleep(CALLER_BLOCK_RETURN_MS).then(() => PARKED)]);
    if (late !== undefined) throw late;
    expect(
      answered,
      `caller-scale-block-is-answered: the backend was handed a ${args.blockMs ?? 0}ms budget — the ` +
        'size an agent really sends — and had not answered it after ' +
        `${CALLER_BLOCK_RETURN_MS}ms, though the read either had a window to return or had a write ` +
        'land inside it. A caller cannot tell that from a backend that has stopped answering',
    ).not.toBe(PARKED);
  };

  // A rejection of any OTHER kind propagates: only the seam's own refusal is an arm of the
  // contract, and swallowing the rest would let a backend answer every blocking read with a crash.
  const read = async (args: FetchRecentArgs): Promise<BlockingOutcome> => {
    const budgetMs = args.blockMs ?? 0;
    const startedAt = Date.now();
    let page: FetchRecentResult;
    try {
      page = await ctx.plugin.fetchRecent(args);
    } catch (err) {
      if (!isBlockingFetchUnsupportedError(err)) throw err;
      expectSeamSentinel(err, 'BlockingFetchUnsupportedError');
      taken.push({ arm: 'refused', budgetMs, elapsedMs: Date.now() - startedAt, emptyPage: false });
      return 'refused';
    }
    taken.push({
      arm: 'served',
      budgetMs,
      elapsedMs: Date.now() - startedAt,
      emptyPage: page.messages.length === 0,
    });
    return page;
  };

  const served = (outcome: BlockingOutcome): FetchRecentResult => {
    if (outcome === 'refused') {
      return expect.fail(
        'blocking-arm-is-stable: the backend served an earlier block budget and refused a ' +
          'later one, so no caller can know which answer a `block_ms` will get',
      );
    }
    return outcome;
  };

  /**
   * Both halves of the arm, over every blocking read this file has made so far — not over the
   * handful the running case happens to have issued. Kept out of {@link read} so that a case's own
   * assertions are what fails first when both are broken: a control aimed at one of them would
   * otherwise be scored on whichever fires earlier.
   */
  const assertStable = (): void => {
    expect(
      [...new Set(taken.map((r) => r.arm))],
      'blocking-arm-is-stable: the backend changed its answer to a block budget — it refused some ' +
        'and served others. A plugin that refuses only the reads a suite is known to make, and ' +
        'silently drops every budget after them, is indistinguishable from one that refuses at all',
    ).toHaveLength(1);
    const hurried = taken.filter(
      (r) =>
        r.arm === 'served' &&
        r.emptyPage &&
        r.elapsedMs < Math.floor(r.budgetMs * SERVED_BLOCK_FLOOR_FRACTION),
    );
    expect(
      hurried.map((r) => `${r.budgetMs}ms budget answered empty in ${r.elapsedMs}ms`),
      'native-block-waits-every-time: the backend took the serving arm and then answered a block ' +
        'budget with an empty page it had nothing to put in, without waiting. Core long-polls that ' +
        'in a hot loop — and a backend that only starts doing it after the first few budgets ' +
        'passes every bound measured on one read by hand',
    ).toEqual([]);
  };

  it('blockMs is honoured natively or refused — never silently ignored', async () => {
    const t = ctx.freshTopic();
    await ctx.plugin.post(t, SENDER, 'old');

    // The since-LESS read, which both arms answer at once. Core's long-poll wrapper issues its first
    // iteration with the caller's own `since` — undefined whenever the agent holds no cursor yet —
    // so this is the hot path for every `parley_fetch_recent` that carries a block budget and no
    // cursor.
    const openedAt = Date.now();
    const opening = await read({ topic: t, blockMs: SINCELESS_BLOCK_MS });
    expect(
      Date.now() - openedAt,
      'sinceless-block-returns-promptly: a cursor-less read carrying a block budget parked instead ' +
        'of answering at once — with the default window it already had, or with a refusal',
    ).toBeLessThan(SINCELESS_RETURN_MS);

    if (opening === 'refused') {
      // The durable read underneath is untouched by the refusal: what a backend cannot do is serve
      // the WAIT, not serve the topic.
      const plain = await ctx.plugin.fetchRecent({ topic: t });
      expect(plain.messages.map((m) => m.content)).toEqual(['old']);
      const refusedAt = Date.now();
      const atTail = await read({
        topic: t,
        since: plain.nextCursor,
        blockMs: TAIL_BLOCK_MS,
      });
      expect(
        Date.now() - refusedAt,
        'refusal-is-prompt: the backend spent most of the budget before refusing it, so the caller ' +
          'paid for the wait and got nothing in exchange',
      ).toBeLessThan(REFUSAL_RETURN_MS);
      expect(
        atTail,
        'refusal-is-not-an-empty-page: a backend that refused one block budget answered another ' +
          'with a page, which a caller cannot tell from a long-poll that timed out empty — so an ' +
          'agent polls on believing it is parked',
      ).toBe('refused');
      assertStable();
      return;
    }

    const tail = opening.nextCursor;
    expect(opening.messages.map((m) => m.content)).toEqual(['old']);

    // (a) A blocked fetch at the tail wakes promptly when a message lands mid-wait.
    const started = Date.now();
    const pending = read({ topic: t, since: tail, blockMs: 5000 });
    const posted = postAfter(t, 50, 'fresh');
    const [outcome] = await Promise.all([pending, posted]);
    const woke = served(outcome);
    expect(woke.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(woke.nextCursor).not.toBe(tail); // cursor advanced
    expect(
      Date.now() - started,
      'native-block-wakes-on-the-message: it returned the message only once the budget expired',
    ).toBeLessThan(4000);

    // (b) With nothing new, a blocked fetch returns an empty page with a stable cursor at timeout —
    // AT the timeout, neither before it nor a multiple past it.
    const newTail = woke.nextCursor;
    const idleStarted = Date.now();
    const timedOut = served(await read({ topic: t, since: newTail, blockMs: IDLE_BLOCK_MS }));
    const idleSpent = Date.now() - idleStarted;
    expect(timedOut.messages).toEqual([]);
    expect(timedOut.nextCursor).toBe(newTail);
    expect(
      idleSpent,
      'native-block-actually-waits: a backend that took the blocking arm gave up on the budget at ' +
        'once, which makes core long-poll it in a hot loop',
    ).toBeGreaterThanOrEqual(IDLE_BLOCK_FLOOR_MS);
    expect(
      idleSpent,
      'native-block-does-not-overshoot-the-budget: it held the caller far past the budget it was ' +
        'given. Core keeps the request open for whatever the plugin spends, so an overshoot is a ' +
        'hang under a politer name — and every floor in this clause passes for one',
    ).toBeLessThan(IDLE_BLOCK_CEILING_MS);
    assertStable();
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
    const probeBudgetMs = probeBudget();
    const refuses = (await read({ topic: t, since: tail, blockMs: probeBudgetMs })) === 'refused';
    const postLater = (): Promise<void> => postAfter(t, at, 'racer');

    if (refuses) {
      // Nothing parks here, so the same hazard lands on the DURABLE read racing the write: a read
      // that reports a cursor ABOVE a message it did not return loses that message for good.
      let landingFailure: unknown;
      const landing = postLater().catch((err: unknown) => {
        landingFailure = err;
      });
      const first = await ctx.plugin.fetchRecent({ topic: t, since: tail });
      await landing;
      if (landingFailure !== undefined) throw landingFailure;
      const second = await ctx.plugin.fetchRecent({ topic: t, since: first.nextCursor });
      expect(
        [...first.messages, ...second.messages].map((m) => m.content),
        'refusing-read-covers-only-what-it-returned: a read racing the write reported a cursor ' +
          'ABOVE a message it did not return, so resuming from that cursor skips the message for ' +
          'good — the lost wakeup, on the arm that never parks',
      ).toEqual(['racer']);
      assertStable();
      return;
    }

    // Issued BEFORE the post is scheduled and never awaited in between: awaiting it first is what
    // hides the window, because the post then always lands after the waiter exists.
    const startedAt = Date.now();
    const pending = read({ topic: t, since: tail, blockMs: RACE_BLOCK_MS });
    const [outcome] = await Promise.all([pending, postLater()]);
    const woke = served(outcome);
    expect(woke.messages.map((m) => m.content)).toEqual(['racer']);
    expect(woke.nextCursor).not.toBe(tail);
    expect(
      Date.now() - startedAt,
      'native-block-wakes-on-the-message: the write landed within 3 ms and the read came back near ' +
        'its budget, so it woke on the timeout rather than on the write',
    ).toBeLessThan(RACE_RETURN_MS);
    assertStable();
  });

  /**
   * The arm, asked for longer than a plugin can fake and about reads it cannot enumerate: an
   * unpredictable NUMBER of budgets, drawn from ranges nothing else here uses, spread over several
   * topics and over {@link STABILITY_SPAN_MS} of ONE connection.
   *
   * Every other case works on one topic, on a connection of its own, inside a few hundred
   * milliseconds — so a switch conditioned on a call count, on wall clock, on the budget's value, on
   * the topic or on which connection this is was invisible to all of them at once. Three plugins
   * built on exactly those predicates passed the whole suite.
   */
  it('the same arm answers a long run of unpredictable budgets', async () => {
    const openedAt = Date.now();
    const topics = Array.from({ length: STABILITY_TOPICS }, () => ctx.freshTopic());
    const tails = new Map<Topic, Cursor>();
    for (const [at, topic] of topics.entries()) {
      // The FIRST topic is deep: every other case here works on a topic holding one message, so a
      // backend that serves budgets only while a topic is small enough to answer from a first page
      // answers all of them exactly as a conformant one does.
      const rows = at === 0 ? STABILITY_DEEP_TOPIC_ROWS : 1;
      for (let i = 0; i < rows; i++) await ctx.plugin.post(topic, SENDER, `old-${i}`);
      tails.set(topic, (await ctx.plugin.fetchRecent({ topic, limit: rows })).nextCursor);
    }

    const budgets = stabilityBudgets();
    const before = taken.length;
    // One read per slot of a schedule that outlasts the window, so the LAST of them reaches the
    // backend strictly after it. The refusing arm answers at once, so without a schedule the whole
    // run collapses into the milliseconds a refusal costs and a switch conditioned on wall clock is
    // never asked a question on both sides of the clock it switches at.
    const slotMs = Math.ceil(STABILITY_SPAN_MS / (budgets.length - 1)) + 1;
    for (const [i, blockMs] of budgets.entries()) {
      const topic = topics[i % topics.length] as Topic;
      await read({ topic, since: tails.get(topic), blockMs });
      const owed = openedAt + (i + 1) * slotMs - Date.now();
      if (owed > 0) await sleep(owed);
    }

    // …and the same question at the SIZE an agent asks it. Both shapes answer at once by contract,
    // so a budget of minutes costs nothing here: the first is a since-less read of a topic that
    // already has messages, the second wakes on a write scheduled inside it.
    const deep = topics[0] as Topic;
    const sinceless = callerScaleBudget();
    await callerScaleRead({ topic: deep, blockMs: sinceless });
    const woken = topics[1] as Topic;
    const wake = postAfter(woken, WAKE_POST_MS, 'caller-scale');
    let wakeFailure: unknown;
    const landed = wake.catch((err: unknown) => {
      wakeFailure = err;
    });
    const atTail = callerScaleBudget();
    await callerScaleRead({ topic: woken, since: tails.get(woken), blockMs: atTail });
    await landed;
    if (wakeFailure !== undefined) throw wakeFailure;

    // Without this the case can degenerate into a handful of reads, which is the window a switch
    // conditioned on a call count hides in. The window the run COVERS needs no assertion here: the
    // schedule above is what realises it, and a run that stopped covering it would stop failing the
    // time-conditioned variant in `BROKEN_VARIANTS`.
    expect(taken.length - before).toBeGreaterThanOrEqual(
      STABILITY_READS_MIN + STABILITY_CALLER_READS,
    );
    assertStable();
  });
}
