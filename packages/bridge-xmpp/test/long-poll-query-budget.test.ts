import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, expectNoLeaks, FakeXmpp } from './fake-xmpp.js';

// Class: a wake that latches a POLL CADENCE for the rest of a long-poll. `fetchRecent({blockMs})`
// is a live wait, not a poll: its cost must be a function of how many messages arrived, never of
// how long the caller was willing to wait. Any state that turns "the archive lagged once" into a
// short re-query interval held for the remaining budget converts one blocked fetch into hundreds
// of archive queries against a shared server (blockMs 60s at a 50 ms cadence is ~1200 IQs, per
// agent, per topic). The table walks server latencies x budgets x wake patterns and bounds the
// query count by the number of WAKES — a bound the buggy shape blows through at the larger budget
// while still satisfying every "did it return the message / did it hold the budget" assertion.

const TOPIC = asTopic('t-budget');
/** One wake may buy at most one re-query plus a small, bounded lag re-poll run. */
const QUERIES_PER_WAKE = 6;

type Pattern = 'no wake' | 'one spurious wake' | 'lagging then archived' | 'repeated spurious wakes';

const patterns: Array<{ pattern: Pattern; wakes: number }> = [
  { pattern: 'no wake', wakes: 0 },
  { pattern: 'one spurious wake', wakes: 1 },
  { pattern: 'lagging then archived', wakes: 1 },
  { pattern: 'repeated spurious wakes', wakes: 3 },
];
const rows = patterns.flatMap((p) =>
  [0, 120].flatMap((latencyMs) => [400, 1600].map((blockMs) => ({ ...p, latencyMs, blockMs }))),
);

describe('XMPP long-poll query budget scales with wakes, never with blockMs', () => {
  it.each(rows)(
    '$pattern at $latencyMs ms latency over a $blockMs ms budget',
    async ({ pattern, wakes, latencyMs, blockMs }) => {
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      const p = attach(plugin, fake);
      const room = p.roomJid(TOPIC);
      p.joined.set(room, Promise.resolve());
      const seed = fake.archiveOnly(room, 'old');

      let queries = 0;
      fake.onMamRequest = () => {
        queries++;
      };
      fake.mamLatencyMs = latencyMs;

      // Offset by one round trip, so that every wake lands inside the blocking phase rather than
      // during the plain catch-up query that precedes it (where there is no waiter to wake).
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const at = (ms: number, fire: () => void): void => {
        timers.push(setTimeout(fire, latencyMs + ms));
      };
      if (pattern === 'one spurious wake') at(50, () => fake.reflectOnly(room, 'not-archived'));
      if (pattern === 'lagging then archived') {
        at(30, () => fake.reflectOnly(room, 'lagging'));
        at(60, () => fake.archiveOnly(room, 'lagging'));
      }
      if (pattern === 'repeated spurious wakes') {
        for (const ms of [50, 150, 250]) at(ms, () => fake.reflectOnly(room, `not-archived-${ms}`));
      }

      const started = Date.now();
      const res = await plugin.fetchRecent({
        topic: TOPIC,
        since: asCursor(seed.archId),
        blockMs,
      });
      const elapsed = Date.now() - started;
      for (const t of timers) clearTimeout(t);

      expect(queries).toBeLessThanOrEqual(2 + wakes * QUERIES_PER_WAKE);
      if (pattern === 'lagging then archived') {
        expect(res.messages.map((m) => m.content)).toEqual(['lagging']);
      } else {
        expect(res.messages).toEqual([]);
        expect(elapsed).toBeGreaterThanOrEqual(blockMs * 0.9);
      }
      expectNoLeaks(plugin);
      await plugin.disconnect();
    },
  );

  it('spaces lag re-polls by the poll interval even when the round trip is slower than it', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    p.joined.set(room, Promise.resolve());
    const seed = fake.archiveOnly(room, 'old');

    const LATENCY_MS = 200;
    const startedAt: number[] = [];
    const t0 = Date.now();
    fake.onMamRequest = (): void => {
      startedAt.push(Date.now() - t0);
    };
    fake.mamLatencyMs = LATENCY_MS;

    const wake = setTimeout(() => fake.reflectOnly(room, 'not-archived'), LATENCY_MS + 50);
    await plugin.fetchRecent({ topic: TOPIC, since: asCursor(seed.archId), blockMs: 1_400 });
    clearTimeout(wake);

    // From the round that follows the wake — neither the plain catch-up query nor a round whose
    // waiter had already fired parks at all.
    const repolls = startedAt.slice(2);
    const gaps = repolls.slice(1).map((t, i) => t - (repolls[i] as number));
    // A re-poll must wait its interval AFTER the query it re-polls, not overlap it: an interval
    // started before the query is already spent when a slow server answers, so the rounds run
    // back to back and the gap collapses to the bare round trip.
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const gap of gaps) expect(gap).toBeGreaterThan(LATENCY_MS + 30);
    expectNoLeaks(plugin);
    await plugin.disconnect();
  });
});
