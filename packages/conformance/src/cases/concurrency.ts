import { expect, it } from 'vitest';
import { DRAIN_PAGE, drainAll } from '../assertions.js';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';

/**
 * Wall-clock budget for the interleaved reader's give-up diagnostic. Keep it well UNDER the
 * harness's own `testTimeout`, so that the loop loses the race to its own message: a larger number
 * makes the one line naming the stuck topic unreachable and reports a generic timeout instead.
 */
const READER_BUDGET_MS = 15_000;

const WRITERS = 4;
const PER_WRITER = 25;

/** Concurrent writers: what a reader inside the write window sees, and what survives it. */
export function concurrencyCases(ctx: ConformanceContext): void {
  // A store that mints a cursor from a PRE-COMMIT sequence (Postgres BIGSERIAL assigns `seq` at
  // INSERT, not COMMIT) can make cursor 42 visible while 41 is still uncommitted. A reader that
  // advances past 42 in that window can never fetch 41 again: durably stored, permanently
  // unreachable. The case below cannot see it — it reads only after every writer has settled,
  // when the gap has filled in — so this one puts the reader INSIDE the write window.
  it('a reader interleaved with concurrent writers loses no message', async (testCtx) => {
    if (ctx.concurrentPost === 'unsupported') {
      testCtx.skip();
      return;
    }
    const t = ctx.freshTopic();
    // Seed first: a cursor to read from has to exist before the writers start, and a backend
    // taking the throwing arm of the absent-topic contract has none until the topic does.
    await ctx.plugin.post(t, SENDER, 'seed');
    const start = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;

    const seen: string[] = [];
    let cursor = start;
    let writing = true;
    let readFailure: unknown;
    // The handler is attached AT CREATION, so that this budget expiring while the writers are
    // still in flight fails THIS case with the line naming the stuck topic: a rejection landing
    // before the `await` below has no handler at all, and surfaces as a process-level unhandled
    // rejection that takes every other case in the file with it.
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
    })().catch((err: unknown) => {
      readFailure = err;
    });

    await ctx.concurrentPost(t, WRITERS, PER_WRITER);
    writing = false;
    await readLoop;
    if (readFailure !== undefined) throw readFailure;

    const stored = (await drainAll(ctx.plugin, t)).slice(1).map((m) => String(m.backendMsgId));
    expect(stored).toHaveLength(WRITERS * PER_WRITER);
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
    await ctx.concurrentPost(t, WRITERS, PER_WRITER);

    const all = await drainAll(ctx.plugin, t);
    expect(all).toHaveLength(WRITERS * PER_WRITER);
    expect(new Set(all.map((m) => m.backendMsgId)).size).toBe(WRITERS * PER_WRITER);
    expect(new Set(all.map((m) => m.cursor)).size).toBe(WRITERS * PER_WRITER);

    // Cursor ordering is real: since the k-th message returns exactly the messages after it.
    const k = Math.floor(all.length / 2);
    const rest = await ctx.plugin.fetchRecent({ topic: t, since: all[k]!.cursor, limit: 10_000 });
    expect(rest.messages.map((m) => m.backendMsgId)).toEqual(
      all.slice(k + 1).map((m) => m.backendMsgId),
    );
  });
}
