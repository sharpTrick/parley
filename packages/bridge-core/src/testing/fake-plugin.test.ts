import { describe, expect, it } from 'vitest';
import { asHandle, asTopic } from '../message.js';
import { FakePlugin } from './fake-plugin.js';

/**
 * A shared fake that implements a seam clause BACKWARDS is worse than no coverage: every test built
 * on it stays green while grading the opposite of production. That is what happened here — a
 * since-less `fetchRecent` answered with the OLDEST page while `seam.ts` ("the backend's default
 * recent window") and every shipped backend answer with the NEWEST, so the roster and cold-start
 * catch-up were both graded at the wrong end of history, and the one grid that needed the real
 * clause had to carry its own private fake to get it.
 *
 * The conformance suite already grades this clause against every shipped plugin; core's fake is the
 * half that sits outside it, so it is graded here against the same clause.
 */
describe('FakePlugin implements the seam clauses core tests rely on', () => {
  const T = asTopic('ctx');
  const me = asHandle('alice');

  async function seeded(n: number): Promise<FakePlugin> {
    const p = new FakePlugin();
    await p.connect({});
    for (let i = 1; i <= n; i++) await p.post(T, me, `m${i}`);
    return p;
  }

  // (messages posted, page size) — straddling the limit in both directions, and at the sizes the
  // roster actually runs at (`PRESENCE_FETCH_LIMIT` is 500).
  it.each([
    [501, 500],
    [500, 500],
    [500, 499],
    [3, 1],
    [1, 1],
  ])('a since-less fetch of %i messages at limit %i returns the NEWEST page', async (total, limit) => {
    const p = await seeded(total);
    const page = await p.fetchRecent({ topic: T, limit });

    const kept = Math.min(total, limit);
    const newest = Array.from({ length: kept }, (_u, i) => `m${total - kept + i + 1}`);
    expect(page.messages.map((m) => m.content)).toEqual(newest);
    expect(page.nextCursor).toBe(page.messages.at(-1)!.cursor);

    // The cursor a page hands back is replayable: resuming from it yields nothing and stands still.
    const drained = await p.fetchRecent({ topic: T, since: page.nextCursor, limit });
    expect(drained.messages).toEqual([]);
    expect(drained.nextCursor).toBe(page.nextCursor);
  });

  it('a since-ful fetch still pages forward from the OLDEST unread', async () => {
    const p = await seeded(5);
    const page = await p.fetchRecent({ topic: T, since: (await p.fetchRecent({ topic: T, limit: 5 })).messages[0]!.cursor, limit: 2 });
    expect(page.messages.map((m) => m.content)).toEqual(['m2', 'm3']);
  });

  it('an empty topic answers with a replayable zero cursor either way', async () => {
    const p = await seeded(0);
    const cold = await p.fetchRecent({ topic: T, limit: 10 });
    expect(cold.messages).toEqual([]);
    const resumed = await p.fetchRecent({ topic: T, since: cold.nextCursor, limit: 10 });
    expect(resumed.messages).toEqual([]);
    expect(resumed.nextCursor).toBe(cold.nextCursor);
  });
});
