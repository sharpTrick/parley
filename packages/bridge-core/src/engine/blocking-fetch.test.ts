import { describe, expect, it, vi } from 'vitest';
import { asHandle, asTopic } from '../message.js';
import type { FetchRecentArgs, FetchRecentResult } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { fetchRecentBlocking } from './blocking-fetch.js';

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

  it('stops early when the abort signal fires', async () => {
    const plugin = new FakePlugin();
    const t = asTopic('room');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
    const clock = fakeClock();
    const ac = new AbortController();

    const pending = fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      {
        blockMs: 10_000,
        pollIntervalMs: 250,
        now: clock.now,
        sleep: clock.sleep,
        signal: ac.signal,
      },
    );
    await flush();
    ac.abort();
    await clock.advance(250);

    const res = await pending;
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail);
  });
});
