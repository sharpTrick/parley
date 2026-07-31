import { expect, it } from 'vitest';
import { drainAll, expectWellFormedMessage } from '../assertions.js';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';

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

/** The read path: ordering, cursor arithmetic, paging, the default window, and topic isolation. */
export function catchUpCases(ctx: ConformanceContext): void {
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
}
