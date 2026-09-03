import { describe, expect, it } from 'vitest';
import { asTopic } from '../message.js';
import { connectedFake } from '../testing/fake-plugin.js';
import { MAX_TIMER_MS } from '../timer-bounds.js';
import { fetchRecentBlocking } from './blocking-fetch.js';
import { SEEN_MAX_PER_TOPIC, SEEN_MAX_TOPICS, SeenSet } from './seen-set.js';

/**
 * Core's sizing knobs are all embedder-facing: `new SeenSet(a, b)`, `fetchRecentBlocking`'s poll
 * budget. Wire any of them from a mis-set config and a degenerate value does not shrink the feature,
 * it DELETES it — a zero dedup window re-emits every message as a `<channel>` event forever, a zero
 * poll interval turns a long poll into a single fetch — and it does so with no error and no log.
 * Fail fast instead. Table every such knob against the values that would degrade it, and pair each with the
 * legal value it must still accept, so "reject everything" is not a passing answer.
 *
 * A knob whose value reaches a Node TIMER is degenerate off BOTH ends, which is the half that keeps
 * being missed: a delay past what the timer holds does not slow the loop down, it wraps and fires at
 * ~1 ms, so it is the same storm as a zero. {@link TOO_LARGE} is asserted against a real timer below
 * rather than remembered, and which knobs are timer-backed is DERIVED by watching what each one
 * arms, so a cadence added later cannot join the table without its degenerate ceiling.
 */

/** Values a timer floors to ~1 ms. */
const TOO_SMALL = [0, -1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY];

/** Values that name a wait of 24.8 days or more and are fired at ~1 ms instead. */
const TOO_LARGE = [2 ** 31, 2 ** 31 + 1, 3e9, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY];

const DEGENERATE_TIMER_MS = [...TOO_SMALL, ...TOO_LARGE];

interface Knob {
  label: string;
  /** Build the feature with `value` in this knob. Must reject for a degenerate value. */
  build: (value: number) => unknown;
  /** Values whose acceptance silently turns this feature off or perverts it. */
  degenerate: number[];
  /** A value this knob must still accept — the control against an over-strict guard. */
  legal: number;
  /** Whether this knob's value is armed on a Node timer. Cross-checked against what `build` arms. */
  timerBacked?: true;
  cleanup?: (made: unknown) => Promise<void>;
}

const KNOBS: Knob[] = [
  {
    label: 'SeenSet maxPerTopic',
    build: (maxPerTopic) => new SeenSet(maxPerTopic, SEEN_MAX_TOPICS),
    degenerate: [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    legal: SEEN_MAX_PER_TOPIC,
  },
  {
    label: 'SeenSet maxTopics',
    build: (maxTopics) => new SeenSet(SEEN_MAX_PER_TOPIC, maxTopics),
    degenerate: [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    legal: SEEN_MAX_TOPICS,
  },
  {
    label: 'fetchRecentBlocking pollIntervalMs',
    // A budget far past the cadence and an abort a tick in, so the nap this knob sizes is actually
    // ARMED (the timer-backed derivation below reads it) without the case waiting the budget out.
    build: async (pollIntervalMs) =>
      fetchRecentBlocking(
        await connectedFake(),
        { topic: asTopic('ctx') },
        { blockMs: 5_000, pollIntervalMs, signal: AbortSignal.timeout(1) },
      ),
    degenerate: DEGENERATE_TIMER_MS,
    legal: 250,
    timerBacked: true,
  },
  {
    label: 'fetchRecentBlocking blockMs',
    build: async (blockMs) =>
      fetchRecentBlocking(await connectedFake(), { topic: asTopic('ctx') }, { blockMs, pollIntervalMs: 250 }),
    degenerate: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    legal: 0,
  },
];

/** Run `build` so a synchronous throw and a rejected promise are the same observable failure. */
const attempt = async (knob: Knob, value: number): Promise<unknown> => knob.build(value);

describe('a degenerate bound is refused, never silently applied', () => {
  const CELLS = KNOBS.flatMap((knob) => knob.degenerate.map((value) => [knob.label, value, knob] as const));

  it.each(CELLS)('%s = %s is a RangeError', async (_label, value, knob) => {
    await expect(attempt(knob, value)).rejects.toBeInstanceOf(RangeError);
  });

  it.each(KNOBS.map((knob) => [knob.label, knob] as const))(
    '%s still accepts its production value',
    async (_label, knob) => {
      const made = await attempt(knob, knob.legal);
      expect(made).toBeDefined();
      await knob.cleanup?.(made);
    },
  );
});

/**
 * The ceiling is the runtime's, not a remembered number. Measure it rather than assert it: if a
 * future Node honoured a 32-bit-overflowing delay, {@link TOO_LARGE} would stop being degenerate and
 * these rows would say so.
 */
describe('a delay past what a Node timer holds is not honoured, it fires at once', () => {
  const firesWithin = (ms: number, budget: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearTimeout(fence);
        resolve(true);
      }, ms);
      const fence = setTimeout(() => {
        clearTimeout(timer);
        resolve(false);
      }, budget);
    });

  it.each(TOO_LARGE.map((ms) => [ms] as const))(
    'a %s ms delay names at least 24 days and fires within 50 ms anyway',
    async (ms) => {
      expect(ms).toBeGreaterThan(MAX_TIMER_MS);
      expect(await firesWithin(ms, 50)).toBe(true);
    },
  );

  it('the ceiling itself is honoured — the control against a fence that always wins', async () => {
    expect(await firesWithin(MAX_TIMER_MS, 50)).toBe(false);
  });
});

/**
 * Which knobs are timer-backed is read off what they ARM, not off the marker. A declared marker with
 * nothing behind it, or a new cadence knob tabled without one, both fail here — and neither depends
 * on where the code lives.
 */
describe('every knob whose value reaches a Node timer is tabled against the timer ceiling', () => {
  async function armedDelays(knob: Knob): Promise<number[]> {
    const armed: number[] = [];
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    const record = <T extends typeof globalThis.setTimeout | typeof globalThis.setInterval>(real: T): T =>
      ((fn: never, ms?: number, ...rest: never[]) => {
        if (typeof ms === 'number') armed.push(ms);
        return (real as (...a: never[]) => unknown)(fn as never, ms as never, ...rest);
      }) as unknown as T;
    globalThis.setTimeout = record(realTimeout);
    globalThis.setInterval = record(realInterval);
    try {
      const made = await attempt(knob, knob.legal);
      await knob.cleanup?.(made);
    } finally {
      globalThis.setTimeout = realTimeout;
      globalThis.setInterval = realInterval;
    }
    return armed;
  }

  it('derives at least the knobs it was written against (guards against a blind derivation)', () => {
    expect(KNOBS.filter((k) => k.timerBacked).length).toBeGreaterThanOrEqual(1);
  });

  it('marks exactly the knobs that arm a timer with their own value', async () => {
    const derived: string[] = [];
    for (const knob of KNOBS) {
      if ((await armedDelays(knob)).includes(knob.legal)) derived.push(knob.label);
    }
    expect(
      derived.sort(),
      'a knob armed its own value on a Node timer without being tabled against that timer’s ceiling',
    ).toEqual(
      KNOBS.filter((k) => k.timerBacked)
        .map((k) => k.label)
        .sort(),
    );
  });

  it.each(KNOBS.filter((k) => k.timerBacked).map((k) => [k.label, k] as const))(
    '%s is tabled against every degenerate delay',
    (_label, knob) => {
      expect(knob.degenerate).toEqual(DEGENERATE_TIMER_MS);
    },
  );
});
