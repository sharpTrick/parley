import {
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  isBlockingFetchUnsupportedError,
  type Topic,
} from '@sharptrick/parley-core';
import { expect, it } from 'vitest';
import {
  IDLE_BLOCK_CEILING_MS,
  IDLE_BLOCK_FLOOR_MS,
  IDLE_BLOCK_MS,
  MAX_EXTRA_PROBES,
  PROBE_MAX_BLOCK_MS,
  RACE_BLOCK_MS,
  RACE_RETURN_MS,
  REFUSAL_RETURN_MS,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
  TAIL_BLOCK_MS,
} from '../budgets.js';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';

/** What a read carrying a block budget answered with: a page, or the backend's refusal. */
type BlockingOutcome = FetchRecentResult | 'refused';

/** The arm such a read took. */
type BlockingArm = 'refused' | 'served';

const extraProbes = (): number => 1 + Math.floor(Math.random() * MAX_EXTRA_PROBES);
const probeBudget = (): number => 1 + Math.floor(Math.random() * PROBE_MAX_BLOCK_MS);

/**
 * The `blockMs` contract: honoured natively — waits, wakes on arrival, and does not overshoot — or
 * REFUSED, naming the backend. Never silently ignored, never a hang.
 *
 * One contract for every backend. There is no declaration to take a backend's word for: which arm a
 * plugin is on is decided by what it does when a budget reaches it, so a plugin that answers a
 * budget with the page it already had is graded on the arm that requires it to have waited.
 *
 * Inferring the arm has a cost the declaration did not have: a FIXED schedule of blocking reads is a
 * fingerprint. A plugin that refuses exactly the reads the suite is known to make and silently drops
 * every budget after them takes the refusing arm here and ignores every `block_ms` a real agent
 * sends. So neither the number of blocking reads nor the budgets they carry are predictable from
 * this file, and what is graded is that the arm never CHANGES within a case.
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

  /**
   * Every read a case makes carrying a budget, and the arm it took. Fresh per case, because the
   * fixture is: a plugin is entitled to answer differently after a reconnect, but not within one.
   */
  const armRecorder = (): {
    read: (args: FetchRecentArgs) => Promise<BlockingOutcome>;
    served: (outcome: BlockingOutcome) => FetchRecentResult;
    probeAgain: (topic: Topic, since: Cursor) => Promise<void>;
    assertStable: () => void;
  } => {
    const taken: BlockingArm[] = [];
    // A rejection of any OTHER kind propagates: only the seam's own refusal is an arm of the
    // contract, and swallowing the rest would let a backend answer every blocking read with a crash.
    const read = async (args: FetchRecentArgs): Promise<BlockingOutcome> => {
      try {
        const page = await ctx.plugin.fetchRecent(args);
        taken.push('served');
        return page;
      } catch (err) {
        if (!isBlockingFetchUnsupportedError(err)) throw err;
        taken.push('refused');
        return 'refused';
      }
    };
    return {
      read,
      served: (outcome) => {
        if (outcome === 'refused') {
          return expect.fail(
            'blocking-arm-is-stable: the backend served an earlier block budget and refused a ' +
              'later one, so no caller can know which answer a `block_ms` will get',
          );
        }
        return outcome;
      },
      probeAgain: async (topic, since) => {
        for (let left = extraProbes(); left > 0; left--) {
          const budget = probeBudget();
          await read({ topic, since, blockMs: budget });
        }
      },
      assertStable: () => {
        expect(
          [...new Set(taken)],
          'blocking-arm-is-stable: the backend changed its answer to a block budget part-way ' +
            'through the case — it refused some and served others. A plugin that refuses only the ' +
            'reads a suite is known to make, and silently drops every budget after them, is ' +
            'indistinguishable from one that refuses at all',
        ).toHaveLength(1);
      },
    };
  };

  it('blockMs is honoured natively or refused — never silently ignored', async () => {
    const t = ctx.freshTopic();
    const { read, served, probeAgain, assertStable } = armRecorder();
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
      await probeAgain(t, plain.nextCursor);
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
    await probeAgain(t, newTail);
    assertStable();
  });

  // The window between a blocking `fetchRecent` issuing its read and registering its waiter. A
  // message landing inside it is dropped by a plugin that parks at "from now" instead of at the
  // caller's cursor — and is then invisible until something else wakes the call. Only 0-3ms
  // discriminates: by ~5ms the waiter is registered and the case degenerates into the 50ms
  // long-poll case above, which is why that one never caught this.
  it.each([0, 1, 2, 3])('a post landing %ims into a blocking fetch is not missed', async (at) => {
    const t = ctx.freshTopic();
    const { read, served, probeAgain, assertStable } = armRecorder();
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
      await probeAgain(t, second.nextCursor);
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
    await probeAgain(t, woke.nextCursor);
    assertStable();
  });
}
