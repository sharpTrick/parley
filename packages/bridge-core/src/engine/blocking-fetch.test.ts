import { describe, expect, it, vi } from 'vitest';
import { asCursor, asHandle, asTopic, type Cursor } from '../message.js';
import type { BackendPlugin, FetchRecentArgs, FetchRecentResult } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import {
  NONCONFORMANT_SHAPE_NAMES,
  NONCONFORMANT_SHAPES,
  pagingProbe,
} from '../testing/nonconformant.js';
import { FetchAbortedError, fetchRecentBlocking, type BlockingFetchOptions } from './blocking-fetch.js';

const SENDER = asHandle('writer');

/** Flush enough microtask turns for the loop to settle between synchronous steps. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * A controllable clock + sleep so the deadline loop is deterministic (no real timers). `sleep`
 * registers a virtual waiter synchronously; `advance` moves time and fires every due waiter, then
 * drains microtasks so the loop can run its next iteration before the test asserts.
 */
function fakeClock(start = 0) {
  let t = start;
  const waiters: Array<{ due: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ due: t + ms, resolve });
      }),
    async advance(ms: number): Promise<void> {
      t += ms;
      const due = waiters.filter((w) => w.due <= t).sort((a, b) => a.due - b.due);
      for (const w of due) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
      await flush();
    },
  };
}

describe('fetchRecentBlocking', () => {
  it('returns immediately when the first fetch already has messages (passthrough)', async () => {
    const plugin = new FakePlugin();
    const t = asTopic('room');
    await plugin.post(t, SENDER, 'a');
    const clock = fakeClock();

    const res = await fetchRecentBlocking(
      plugin,
      { topic: t },
      { blockMs: 5000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep },
    );
    expect(res.messages.map((m) => m.content)).toEqual(['a']);
  });

  it('with blockMs = 0 is a plain single passthrough (no waiting)', async () => {
    const plugin = new FakePlugin();
    const t = asTopic('room');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
    const spy = vi.spyOn(plugin, 'fetchRecent');

    const res = await fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 0, pollIntervalMs: 250 },
    );
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns promptly after a concurrent post lands mid-wait', async () => {
    const plugin = new FakePlugin();
    const t = asTopic('room');
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
    const clock = fakeClock();

    const pending = fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 10_000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep },
    );

    await flush(); // let the first (empty) iteration run and park on its poll sleep
    await plugin.post(t, SENDER, 'fresh'); // concurrent writer
    await clock.advance(250); // wake the poll

    const res = await pending;
    expect(res.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(res.nextCursor).not.toBe(tail); // cursor advanced
  });

  it('returns an empty page with a stable cursor at the deadline', async () => {
    const plugin = new FakePlugin();
    const t = asTopic('room');
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
    const clock = fakeClock();

    const pending = fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep },
    );

    await flush();
    for (let i = 0; i < 6; i++) await clock.advance(250); // past the deadline, no posts

    const res = await pending;
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail); // stable, replayable
  });

  it('passes the REMAINING budget as blockMs to the plugin each iteration (native path)', async () => {
    const plugin = new FakePlugin();
    const t = asTopic('room');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
    const clock = fakeClock();
    const seen: Array<number | undefined> = [];
    const orig = plugin.fetchRecent.bind(plugin);
    vi.spyOn(plugin, 'fetchRecent').mockImplementation(
      (args: FetchRecentArgs): Promise<FetchRecentResult> => {
        seen.push(args.blockMs);
        return orig(args);
      },
    );

    const pending = fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 1000, pollIntervalMs: 400, now: clock.now, sleep: clock.sleep },
    );
    await flush();
    for (let i = 0; i < 4; i++) await clock.advance(400);
    await pending;

    // First call gets the full budget; every call is bounded by it and non-increasing.
    expect(seen[0]).toBe(1000);
    expect(seen.every((b) => b !== undefined && b <= 1000)).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
  });

  /**
   * Cancellation has to reach the thing actually doing the waiting, not just the wrapper around it.
   * Table both plugin flavours the seam allows — one that ignores `blockMs` (core naps between
   * calls) and one that honours it NATIVELY (the wait happens inside a single plugin call) — across
   * every moment an abort can land AND every cadence an operator can configure, and assert a bounded
   * wall-clock return in every cell. Real timers: the defect is that core stays parked — inside
   * `plugin.fetchRecent`, or inside its own nap — which a fake clock cannot express.
   *
   * The cadence is a DIMENSION, not a constant. `catchup.block_poll_interval_ms` is an unbounded
   * positive integer, so it can be set as coarse as the whole budget; a wait that only re-reads the
   * signal at its boundaries then holds a cancelled long-poll for the entire budget, and a table
   * that pins the cadence small is precisely what hides it.
   */
  describe('an aborted long-poll returns in bounded time on every plugin flavour', () => {
    const BUDGET_MS = 3000;
    const BOUND_MS = 600;
    const T = asTopic('room');

    const flavours = {
      'ignores blockMs (returns instantly)': (): BackendPlugin => {
        const p = new FakePlugin();
        return p;
      },
      'honours blockMs natively (parks for the whole budget)': (): BackendPlugin => {
        const p = new FakePlugin();
        const orig = p.fetchRecent.bind(p);
        p.fetchRecent = async (a: FetchRecentArgs): Promise<FetchRecentResult> => {
          if ((a.blockMs ?? 0) > 0) await new Promise((r) => setTimeout(r, a.blockMs).unref?.());
          return orig(a);
        };
        return p;
      },
    };

    const timings = {
      'before the first fetch': (ac: AbortController) => ac.abort(),
      'while the fetch is in flight': (ac: AbortController) => setTimeout(() => ac.abort(), 25).unref?.(),
      'after several poll iterations': (ac: AbortController) => setTimeout(() => ac.abort(), 120).unref?.(),
    };

    const cadences = {
      'a cadence far finer than the budget': 40,
      'a cadence half the budget': BUDGET_MS / 2,
      'a cadence as coarse as the whole budget': BUDGET_MS,
    };

    // `since` is a DIMENSION, not a constant: the tool explicitly invites a `since`-less long poll
    // ("Omit for the recent window"), and that is the column where no page has landed yet and no
    // cursor exists to hand back — so cancellation there cannot be a `nextCursor` at all.
    const starts = {
      'a since at the tail': (tail: Cursor): { since?: Cursor } => ({ since: tail }),
      'no since': (): { since?: Cursor } => ({}),
    };

    for (const [flavour, make] of Object.entries(flavours)) {
      for (const [when, fire] of Object.entries(timings)) {
        for (const [start, argsFor] of Object.entries(starts)) {
          it.each(Object.entries(cadences))(`${flavour} × aborted ${when} × ${start} × %s`, async (_cadence, pollIntervalMs) => {
            const plugin = make();
            const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
            const ac = new AbortController();
            fire(ac);
            const t0 = Date.now();
            const outcome = await fetchRecentBlocking(
              plugin,
              { topic: T, ...argsFor(tail) },
              { blockMs: BUDGET_MS, pollIntervalMs, signal: ac.signal },
            ).then(
              (res) => ({ res }),
              (err: unknown) => ({ err }),
            );
            expect(Date.now() - t0).toBeLessThan(BOUND_MS);
            if ('err' in outcome) {
              // Cancelled before any page landed: recognisable as a cancellation, never as a
              // backend failure, so the tool layer can answer it like an empty window.
              expect(outcome.err).toBeInstanceOf(FetchAbortedError);
              return;
            }
            expect(outcome.res.messages).toEqual([]);
            expect(outcome.res.nextCursor).toBe(tail); // stable and replayable — the caller's position
          });
        }
      }

      it(`${flavour} × never aborted still spends the whole budget`, async () => {
        const plugin = make();
        const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
        const t0 = Date.now();
        await fetchRecentBlocking(plugin, { topic: T, since: tail }, { blockMs: 400, pollIntervalMs: 40 });
        // Without this row every assertion above would pass on a wrapper that never waits at all.
        expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      });
    }
  });

  /**
   * A wall-clock bound plus "the cursor came back unchanged" is satisfied identically by a live
   * branch and by a deleted one — which is how a post-nap re-query whose result was ALWAYS
   * discarded (the abort wrapper short-circuits on the signal that got us there) survived every
   * abort test while still firing a backend query per cancellation. Pin the exact number of
   * `fetchRecent` calls per abort timing: that is the only assertion that can tell the two apart.
   */
  describe('no branch of the long-poll loop is unreachable', () => {
    const T = asTopic('room');

    /** A plugin that counts queries and, optionally, parks the first one until released. */
    function counting(opts: { park?: boolean } = {}) {
      const plugin = new FakePlugin();
      const calls: FetchRecentArgs[] = [];
      let release: (() => void) | undefined;
      const orig = plugin.fetchRecent.bind(plugin);
      plugin.fetchRecent = async (a: FetchRecentArgs): Promise<FetchRecentResult> => {
        calls.push(a);
        if (opts.park === true && calls.length > 1) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return orig(a);
      };
      return { plugin, calls, release: () => release?.() };
    }

    it('an abort BEFORE the first fetch costs no backend query at all', async () => {
      const { plugin, calls } = counting();
      const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
      calls.length = 0;
      const ac = new AbortController();
      ac.abort();
      const clock = fakeClock();

      const res = await fetchRecentBlocking(
        plugin,
        { topic: T, since: tail },
        { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep, signal: ac.signal },
      );
      expect(calls).toHaveLength(0);
      expect(res).toEqual({ messages: [], nextCursor: tail });
    });

    it('an abort DURING the nap costs exactly the one query already made', async () => {
      const { plugin, calls } = counting();
      const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
      calls.length = 0;
      const ac = new AbortController();
      const clock = fakeClock();

      const pending = fetchRecentBlocking(
        plugin,
        { topic: T, since: tail },
        { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep, signal: ac.signal },
      );
      await flush(); // first (empty) iteration ran and parked on its poll sleep
      expect(calls).toHaveLength(1);
      ac.abort();
      await clock.advance(250); // wake the nap into an aborted signal

      const res = await pending;
      expect(calls).toHaveLength(1); // no re-query on the way out
      expect(res).toEqual({ messages: [], nextCursor: tail });
    });

    it('an abort while a fetch is IN FLIGHT costs exactly that query', async () => {
      const { plugin, calls, release } = counting({ park: true });
      const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
      calls.length = 0;
      const ac = new AbortController();
      const clock = fakeClock();

      const pending = fetchRecentBlocking(
        plugin,
        { topic: T, since: tail },
        { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep, signal: ac.signal },
      );
      await flush();
      await clock.advance(250); // second query starts and parks inside the plugin
      expect(calls).toHaveLength(2);
      ac.abort();

      const res = await pending;
      expect(calls).toHaveLength(2); // the parked page is abandoned, not re-queried
      expect(res).toEqual({ messages: [], nextCursor: tail });
      release();
    });

    /**
     * `block_ms` is documented as "hold up to this long", so the caller's budget is a BOUND, not a
     * rounding hint — and every case here used to pick a budget that was an exact multiple of the
     * cadence, the one column where clamping the nap to the remaining budget and not clamping it are
     * the same expression. With the shipped 250 ms cadence, a `block_ms: 10` on an empty topic then
     * overruns by 25x. Cross the two knobs (cadence finer than, equal to, and coarser than the
     * budget) and pin BOTH the virtual-clock instant the call resolves at and the exact query count:
     * the count alone cannot see an overrun, and the clock alone cannot see a lost poll.
     */
    it.each([
      ['a budget that is an exact multiple of the cadence', 1000, 250, 1000, 5],
      ['a budget that is not a multiple of the cadence', 900, 250, 900, 5],
      ['a cadence coarser than the whole budget', 10, 250, 10, 2],
      ['a one-millisecond budget', 1, 1000, 1, 2],
    ])('%s resolves at its deadline, not at the next tick', async (_name, blockMs, pollIntervalMs, at, queries) => {
      const { plugin, calls } = counting();
      const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
      calls.length = 0;
      const clock = fakeClock();

      let settledAt: number | undefined;
      const pending = fetchRecentBlocking(
        plugin,
        { topic: T, since: tail },
        { blockMs, pollIntervalMs, now: clock.now, sleep: clock.sleep },
      ).then((r) => {
        settledAt = clock.now();
        return r;
      });
      await flush();
      for (let i = 0; i < blockMs + pollIntervalMs && settledAt === undefined; i++) await clock.advance(1);
      await pending;

      expect(settledAt).toBe(at);
      expect(settledAt).toBeLessThanOrEqual(blockMs); // the caller's budget is a bound, not a hint
      expect(calls).toHaveLength(queries); // one query per nap, plus the final at-deadline query
    });
  });

  /**
   * The doc once promised that a `since`-less call "returns the recent window immediately". That
   * holds only when the window is non-empty; on an empty topic the loop blocks like any other.
   * Table both axes so a doc claim that covers one cell and not the other is contradicted here.
   */
  describe('blocking engages on an EMPTY window, with or without a since', () => {
    const T = asTopic('room');

    it.each([
      ['no since, topic has messages', false, true, 1],
      ['no since, topic is empty', false, false, 5],
      ['since at the tail, nothing newer', true, true, 5],
    ])('%s', async (_name, withSince, seeded, expectedCalls) => {
      const plugin = new FakePlugin();
      if (seeded) await plugin.post(T, SENDER, 'old');
      const tail = (await plugin.fetchRecent({ topic: T })).nextCursor;
      const calls: FetchRecentArgs[] = [];
      const orig = plugin.fetchRecent.bind(plugin);
      plugin.fetchRecent = async (a: FetchRecentArgs): Promise<FetchRecentResult> => {
        calls.push(a);
        return orig(a);
      };
      const clock = fakeClock();

      const pending = fetchRecentBlocking(
        plugin,
        withSince ? { topic: T, since: tail } : { topic: T },
        { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep },
      );
      await flush();
      for (let i = 0; i < 4; i++) await clock.advance(250);
      await pending;
      expect(calls).toHaveLength(expectedCalls);
    });
  });

  /**
   * Advancing `since` to each page's `nextCursor` is what keeps the next wait exclusive of the tail
   * and what lets a natively-blocking plugin park instead of busy-polling — and a call-COUNT
   * assertion is identical with or without it. Pin the `since` threaded into every successive call,
   * across a plugin whose empty-page cursor advances and one whose does not.
   */
  describe('every poll resumes from the previous page cursor', () => {
    const T = asTopic('room');
    const CURSORS = {
      'a cursor that advances on every empty page': (call: number) => asCursor(`fresh-${call}`),
      'a cursor that stands still on an empty page': () => asCursor('tail'),
    };

    for (const [flavour, cursorFor] of Object.entries(CURSORS)) {
      it.each([
        ['no since', undefined],
        ['a since at the tail', asCursor('tail')],
      ] as Array<[string, Cursor | undefined]>)(`${flavour}, starting from %s`, async (_name, start) => {
        const { plugin, calls } = pagingProbe((_a, call) => ({
          messages: [],
          nextCursor: cursorFor(call),
        }));
        const clock = fakeClock();

        const pending = fetchRecentBlocking(
          plugin,
          start === undefined ? { topic: T } : { topic: T, since: start },
          { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep },
        );
        await flush();
        for (let i = 0; i < 4; i++) await clock.advance(250);
        await pending;

        expect(calls.length).toBeGreaterThan(1);
        expect(calls.map((c) => c.since)).toEqual([
          start,
          ...calls.slice(0, -1).map((_c, i) => cursorFor(i)),
        ]);
      });
    }
  });

  /**
   * The same non-conformant backend shapes the catch-up driver is run against: the long poll is the
   * other loop a plugin's own data drives, so it has to stay bounded against all of them too.
   */
  describe('a non-conformant backend cannot wedge the long poll', () => {
    const T = asTopic('room');

    it.each(NONCONFORMANT_SHAPE_NAMES)('%s', async (name) => {
      const { plugin, calls } = pagingProbe(NONCONFORMANT_SHAPES[name]!.serve);
      const clock = fakeClock();

      const pending = fetchRecentBlocking(
        plugin,
        { topic: T },
        { blockMs: 1000, pollIntervalMs: 250, now: clock.now, sleep: clock.sleep },
      );
      await flush();
      for (let i = 0; i < 6; i++) await clock.advance(250);
      await pending; // the assertion is that this settles at all
      expect(calls.length).toBeLessThanOrEqual(6);
    });
  });

  /**
   * `fetchRecentBlocking` is public API, so its cadence and budget arrive from whatever a caller
   * passes — core's config schema constrains only the values core itself supplies. A non-positive
   * cadence used to collapse the long poll into ONE fetch with no error and no warning, which is the
   * opposite of what the function is for and was reachable by no test in either direction. Table the
   * degenerate values against what each knob PROMISES, so a knob added to BlockingFetchOptions later
   * inherits a row rather than a silent no-op.
   */
  describe('a degenerate cadence or budget is refused, not silently honoured', () => {
    const T = asTopic('room');

    const KNOBS: Array<[name: string, over: Partial<BlockingFetchOptions>, outcome: 'refused' | 'one plain fetch']> = [
      ['pollIntervalMs 0', { pollIntervalMs: 0 }, 'refused'],
      ['pollIntervalMs -1', { pollIntervalMs: -1 }, 'refused'],
      ['pollIntervalMs NaN', { pollIntervalMs: Number.NaN }, 'refused'],
      // `blockMs <= 0` is DOCUMENTED as "do not long-poll": one plain fetch, not an error.
      ['blockMs 0', { blockMs: 0 }, 'one plain fetch'],
      ['blockMs -1', { blockMs: -1 }, 'one plain fetch'],
      // Neither `> 0` nor `<= 0`: every deadline comparison answers false and the loop never ends.
      ['blockMs NaN', { blockMs: Number.NaN }, 'refused'],
      ['blockMs Infinity', { blockMs: Number.POSITIVE_INFINITY }, 'refused'],
    ];

    it.each(KNOBS)('%s', async (_name, over, outcome) => {
      const { plugin, calls } = pagingProbe(() => ({ messages: [], nextCursor: asCursor('tail') }));
      const clock = fakeClock();
      const run = fetchRecentBlocking(plugin, { topic: T }, {
        blockMs: 60_000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
        ...over,
      });
      if (outcome === 'refused') {
        await expect(run).rejects.toThrow(RangeError);
        expect(calls).toHaveLength(0); // refused at the boundary, before any backend query
        return;
      }
      await expect(run).resolves.toEqual({ messages: [], nextCursor: 'tail' });
      expect(calls).toHaveLength(1); // exactly the documented single passthrough
    });
  });

});
