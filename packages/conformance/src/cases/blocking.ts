import type { Topic } from '@sharptrick/parley-core';
import { expect, it } from 'vitest';
import {
  IDLE_BLOCK_FLOOR_MS,
  IDLE_BLOCK_MS,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
} from '../budgets.js';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';

/** The `blockMs` contract: honoured natively, or ignored promptly, and never a lost wakeup. */
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
    const posted = postAfter(t, 50, 'fresh');
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
    const postLater = (): Promise<void> => postAfter(t, at, 'racer');

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
}
