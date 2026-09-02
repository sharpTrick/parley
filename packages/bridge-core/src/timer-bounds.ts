/**
 * What a Node timer can hold, and the one predicate every cadence knob that reaches one is checked
 * against.
 *
 * Past {@link MAX_TIMER_MS} a delay does not slow a timer down — it WRAPS, and the timer fires one
 * millisecond in, which is where a delay below 1 ms is floored too. A heartbeat cadence, a poll nap
 * or a shutdown budget off either end therefore becomes the same storm, and the ceiling is the one
 * end that reads as a slower loop. Every figure guarded here is an operator's or an embedder's TYPED
 * knob, so it is refused rather than clamped: silently rewriting a mis-set 24-day cadence to 24.8
 * days hides the config that produced it.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * True for a delay a Node timer honours as asked: `1 <= ms <= MAX_TIMER_MS`. Both comparisons
 * answer false for `NaN`, so nothing non-numeric passes. A FRACTION inside the range is honoured to
 * the millisecond and is deliberately still accepted — only the two ends collapse a delay to ~1 ms.
 */
export function isArmableDelay(ms: number): boolean {
  return ms >= 1 && ms <= MAX_TIMER_MS;
}
