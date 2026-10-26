import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { connectFresh, SENDER, seqOf, startFake, startRig } from './rig.js';

/**
 * A cursor this plugin never issued is a caller bug, and core feeds `nextCursor` straight back in
 * as `since`: swallowing it turns the topic permanently empty with no error anywhere. `bridge-
 * sqlite` rejects exactly this input — the house norm.
 */
describe('telegram cursor grammar', () => {
  type Verdict = 'serves' | 'malformed' | 'unqualified' | 'foreign' | 'ahead';

  /** How each rejection announces itself; `serves` is the absence of one. */
  const VERDICTS: Record<Exclude<Verdict, 'serves'>, RegExp> = {
    malformed: /malformed cursor/,
    unqualified: /carries no store identity/,
    foreign: /issued by a different observed-message store/,
    ahead: /ahead of every message this store has observed/,
  };

  const POSTED = ['a', 'b', 'c'];

  interface Row {
    since: string;
    verdict: Verdict;
    /** The observation sequence a SERVED cursor names — everything above it is the page. */
    seq?: number;
  }

  /**
   * The whole grammar `requireOwnCursor` implements, straddling every branch's boundary. The table
   * used to hold only its syntactically-broken half — every row failed the bare-digit and the
   * qualified pattern alike — so the branch that refuses an unqualified NON-ZERO sequence had no
   * coverage anywhere in the package: replacing it with `return Number(raw)` left the suite green
   * while `since: '3'` was answered out of a sequence space unrelated to the one that minted it,
   * and every message below it became unreachable with no error anywhere. That is the permanently
   * short page `cursor-lifecycle.test.ts` exists to make impossible, through the one door it left
   * open.
   */
  const spellings = (epoch: string): Row[] => {
    const other = epoch === 'a'.repeat(16) ? 'b'.repeat(16) : 'a'.repeat(16);
    return [
      // Nothing the grammar can read at all.
      { since: '', verdict: 'malformed' },
      { since: 'abc', verdict: 'malformed' },
      { since: '1.5', verdict: 'malformed' },
      { since: '-1', verdict: 'malformed' },
      { since: 'NaN', verdict: 'malformed' },
      { since: '1e999', verdict: 'malformed' },
      { since: '0x10', verdict: 'malformed' },
      { since: ' 1', verdict: 'malformed' },
      { since: '1 ', verdict: 'malformed' },
      { since: '1,2', verdict: 'malformed' },
      // Qualified in shape but not in this grammar: an identity of the wrong width or case, a
      // missing half, a third component, a negative sequence.
      { since: `${epoch}.`, verdict: 'malformed' },
      { since: '.1', verdict: 'malformed' },
      { since: `${epoch}.1.2`, verdict: 'malformed' },
      { since: `${epoch}.-1`, verdict: 'malformed' },
      { since: `${epoch.toUpperCase()}.1`, verdict: 'malformed' },
      { since: `${epoch.slice(0, 15)}.1`, verdict: 'malformed' },
      { since: `${epoch}0.1`, verdict: 'malformed' },
      // Unqualified: '0' names the start of the retained window whatever store reads it, and every
      // other bare sequence names a sequence space nothing can identify.
      { since: '0', verdict: 'serves', seq: 0 },
      { since: '00', verdict: 'serves', seq: 0 },
      { since: '0000000000', verdict: 'serves', seq: 0 },
      { since: '1', verdict: 'unqualified' },
      { since: '2', verdict: 'unqualified' },
      { since: String(POSTED.length), verdict: 'unqualified' },
      { since: '999', verdict: 'unqualified' },
      // Qualified by a store file this one did not inherit.
      { since: `${other}.1`, verdict: 'foreign' },
      { since: `${other}.999`, verdict: 'foreign' },
      // Qualified by this one, on both sides of its high-water mark.
      { since: `${epoch}.0`, verdict: 'serves', seq: 0 },
      { since: `${epoch}.1`, verdict: 'serves', seq: 1 },
      { since: `${epoch}.000000001`, verdict: 'serves', seq: 1 },
      { since: `${epoch}.${POSTED.length}`, verdict: 'serves', seq: POSTED.length },
      { since: `${epoch}.${POSTED.length + 1}`, verdict: 'ahead' },
      { since: `${epoch}.999`, verdict: 'ahead' },
    ];
  };

  const verdictOf = (answer: unknown): string => {
    if (!(answer instanceof Error)) return 'serves';
    for (const [name, pattern] of Object.entries(VERDICTS)) {
      if (pattern.test(answer.message)) return name;
    }
    return `unrecognized rejection: ${answer.message}`;
  };

  it('gives every cursor spelling the verdict its grammar states', async () => {
    const rig = await startRig();
    const topic = asTopic('-1009100001');
    for (const c of POSTED) await rig.plugin.post(topic, SENDER, c);
    const issued = (await rig.plugin.fetchRecent({ topic })).nextCursor as string;
    const epoch = issued.split('.')[0] ?? '';
    expect(epoch).toMatch(/^[0-9a-f]{16}$/);
    const rows = spellings(epoch);
    // A table that lost a branch's rows would pass vacuously: every verdict must be exercised.
    expect(new Set(rows.map((r) => r.verdict))).toEqual(
      new Set<Verdict>(['serves', 'malformed', 'unqualified', 'foreign', 'ahead']),
    );

    const graded = [];
    for (const row of rows) {
      const answer = await rig.plugin
        .fetchRecent({ topic, since: row.since as never, limit: 100 })
        .then(
          (page) => page,
          (err: unknown) => err as Error,
        );
      graded.push({
        since: row.since,
        verdict: verdictOf(answer),
        page: answer instanceof Error ? undefined : answer.messages.map((m) => m.content),
      });
    }

    expect(graded).toEqual(
      rows.map((row) => ({
        since: row.since,
        verdict: row.verdict,
        page: row.seq === undefined ? undefined : POSTED.slice(row.seq),
      })),
    );
  }, 30_000);
});

/**
 * `limit` means the same thing on both fetchRecent branches. `slice(-0)` is `slice(0)` — the
 * whole history — so an unnormalized limit inverts its own meaning at zero and drops leading
 * messages when negative. And on BOTH branches the cursor a caller is handed back must be at
 * least the one it came in with: a truncated (or empty) page that reports '0' sends the next
 * catch-up back to the beginning of the retained window, replaying everything.
 */
describe('telegram fetchRecent limit normalization', () => {
  const LIMITS = [0, 1, 2, -1, -5, 1.5, 1000, undefined];

  /**
   * Past which point a POSITIVE limit stops being run at its own magnitude. A thousand posts would
   * say what the rows below say, and the coincidence this straddle exists for is not reachable
   * from above zero.
   */
  const DEPTH_CAP = 8;

  /**
   * How many messages sit ABOVE `since`, per limit — below its magnitude, at it, and past it.
   *
   * One fixed volume is how the clamp in `requireLimit` came to be graded by nothing: `slice(0, -k)`
   * on exactly k rows is `[]`, which is the same page the clamp produces, so `limit: -5` measured
   * against 5 remaining messages agrees with the un-normalized answer by arithmetic alone. Deleting
   * the clamp left the whole suite green while `limit: -5` on a deeper topic served the FIRST two
   * messages and set `nextCursor` to the second — reinterpreting a published seam argument as "drop
   * the last five" and skipping the rest of the topic forever. No single volume can be chosen that
   * a magnitude cannot coincide with, so each limit brings its own; a negative one is never capped,
   * because that is the half the coincidence lives in.
   */
  const volumesFor = (limit: number | undefined): number[] => {
    const k = Math.floor(limit ?? 100);
    const depth = k < 0 ? -k : Math.min(k, DEPTH_CAP);
    return [...new Set([Math.max(1, depth - 1), Math.max(1, depth), depth + 3])];
  };

  const CELLS = LIMITS.flatMap((limit) => volumesFor(limit).map((above) => ({ limit, above })));

  it.each(CELLS)(
    'limit $limit means the same with and without `since`, $above above it',
    async ({ limit, above }) => {
      const fake = await startFake();
      const plugin = await connectFresh(fake);
      const empty = asTopic('-1009900002');
      const topic = asTopic('-1009900001');
      // An empty topic has no tail to report, on any limit.
      expect(seqOf((await plugin.fetchRecent({ topic: empty, limit })).nextCursor)).toBe(0);
      const POSTED = Array.from({ length: above + 1 }, (_, i) => `m${i}`);
      for (const c of POSTED) await plugin.post(topic, SENDER, c);

      const cap = (n: number): number =>
        limit === undefined ? n : Math.max(0, Math.min(Math.floor(limit), n));
      const head = await plugin.fetchRecent({ topic, limit });
      expect(head.messages).toHaveLength(cap(POSTED.length));
      // Default window = the most recent `limit`, ascending.
      expect(head.messages.map((m) => m.content)).toEqual(
        POSTED.slice(POSTED.length - cap(POSTED.length)),
      );

      const all = (await plugin.fetchRecent({ topic })).messages;
      const since = all[0]!.cursor;
      const topicTail = all.at(-1)!.cursor;
      // The since-less branch always reports the topic's tail: it has already returned the newest
      // messages there are, so nothing below the tail is left for a later catch-up to find.
      expect(head.nextCursor).toBe(topicTail);

      const tail = await plugin.fetchRecent({ topic, since, limit });
      expect(tail.messages).toHaveLength(cap(above));
      expect(tail.messages.map((m) => m.content)).toEqual(POSTED.slice(1, 1 + cap(above)));
      // The cursor never regresses, whatever the limit.
      expect(seqOf(tail.nextCursor)).toBeGreaterThanOrEqual(seqOf(since));
    },
    20_000,
  );
});

/**
 * A page size outside the domain `fetchRecent` slices with is refused, not silently reinterpreted.
 * `slice(NaN)` is the whole retained window and `slice(0, NaN)` is empty, so one un-normalized
 * value means the OPPOSITE thing on either side of `since`: an unbounded page on the default
 * branch and a topic that looks permanently drained on the catch-up branch, with a stable cursor
 * and no error anywhere. Every other numeric input this package takes is domain-checked; the page
 * size is one of them, and `FetchRecentArgs.limit` is a published seam type that callers other than
 * core's zod-validated tool reach.
 */
describe('telegram fetchRecent limit domain', () => {
  const REFUSED = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it.each(REFUSED)('refuses limit %s identically on both branches', async (limit) => {
    const fake = await startFake();
    const plugin = await connectFresh(fake);
    const topic = asTopic('-1009900005');
    for (const c of ['a', 'b', 'c']) await plugin.post(topic, SENDER, c);
    const head = (await plugin.fetchRecent({ topic, limit: 100 })).messages[0]?.cursor;

    const refusal = /limit must be a finite number/;
    await expect(plugin.fetchRecent({ topic, limit })).rejects.toThrow(refusal);
    await expect(plugin.fetchRecent({ topic, since: head, limit })).rejects.toThrow(refusal);
    // And the topic is untouched by the refusal.
    expect((await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content)).toEqual(
      ['a', 'b', 'c'],
    );
  }, 20_000);
});
