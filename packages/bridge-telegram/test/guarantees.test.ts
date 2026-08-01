import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { BOT_IDENTITY } from './fake-telegram.js';
import { SENDER, startRig } from './rig.js';

/**
 * Behaviour this package states as a guarantee in its JSDoc and its README seam-mapping table but
 * that no test could fail on: prose is not a guarantee, and every row here was written by deleting
 * the implementing lines first and watching it go red.
 */
describe('telegram documented guarantees', () => {
  it('disconnect unparks a blocked fetchRecent instead of holding it for the full blockMs', async () => {
    const { plugin } = await startRig();
    const topic = asTopic('-1009700001');
    await plugin.post(topic, SENDER, 'seed');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor;

    const started = Date.now();
    const parked = plugin.fetchRecent({ topic, since: tail, blockMs: 8000 });
    await new Promise((r) => setTimeout(r, 100));
    await plugin.disconnect();

    const res = await parked;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail);
  }, 20_000);

  it('disconnect aborts the in-flight long poll rather than leaving it parked upstream', async () => {
    const { fake, plugin } = await startRig({ poll_timeout_s: 20 });
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(1), { timeout: 5000, interval: 10 });

    await plugin.disconnect();
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(0), { timeout: 1000, interval: 10 });
  }, 20_000);

  it.each([
    { name: "the bot's own username", handle: BOT_IDENTITY.username, ref: String(BOT_IDENTITY.id) },
    { name: 'any other handle', handle: 'someone-else', ref: 'someone-else' },
  ])('resolveIdentity maps $name', async ({ handle, ref }) => {
    const { plugin } = await startRig();
    const identity = await plugin.resolveIdentity(asHandle(handle));
    expect(identity).toEqual({ handle, backendRef: ref });
  }, 20_000);

  /**
   * The headline latency claim of this backend's native long poll: a blocked `fetchRecent` returns
   * because the message ARRIVED, not because its budget ran out. Returning the right page at the
   * wrong time is the failure that looks like success — the shared conformance suite's race case
   * grades only the page, so a gap between the initial query and arming the waiter leaves every
   * cell of it green while turning a 128ms call into a full-`blockMs` one.
   *
   * `postAt` sweeps the window: 0-3ms lands inside the query→waiter gap, 50ms lands after the
   * waiter exists. `blockMs` is the budget a broken wakeup would burn instead, so it appears in the
   * threshold rather than only in the input.
   */
  const WAKEUP_CELLS = [0, 1, 2, 3, 50].flatMap((postAt) =>
    [500, 5000].map((blockMs) => ({ postAt, blockMs })),
  );

  it.each(WAKEUP_CELLS)(
    'a fetch blocking for $blockMs ms wakes on a message posted $postAt ms in, not on its budget',
    async ({ postAt, blockMs }) => {
      const { plugin } = await startRig();
      const topic = asTopic('-1009700002');
      await plugin.post(topic, SENDER, 'old');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor;

      // Issued BEFORE the post is scheduled and never awaited in between: awaiting it first is what
      // hides the window, because the post then always lands after the waiter exists.
      const started = Date.now();
      const parked = plugin.fetchRecent({ topic, since: tail, blockMs });
      const posting = new Promise<void>((resolve) => {
        setTimeout(() => {
          void plugin.post(topic, SENDER, 'racer').then(() => resolve());
        }, postAt);
      });
      const [woke] = await Promise.all([parked, posting]);

      expect(woke.messages.map((m) => m.content)).toEqual(['racer']);
      expect(woke.nextCursor).not.toBe(tail);
      expect(Date.now() - started).toBeLessThan(Math.min(blockMs / 2, 300));
    },
    20_000,
  );
});
