import type { Cursor } from '../message.js';
import type { BackendPlugin, FetchRecentArgs, FetchRecentResult } from '../seam.js';

/** Options for {@link fetchRecentBlocking}. `now`/`sleep` are injectable for deterministic tests. */
export interface BlockingFetchOptions {
  /** Total long-poll budget in ms. Already clamped to the server cap by the caller. */
  blockMs: number;
  /** Poll cadence for the generic fallback (used only when a plugin returns early/empty). */
  pollIntervalMs: number;
  /** Monotonic clock in ms. Default `Date.now`. */
  now?: () => number;
  /** Sleep `ms`. Default a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional cancellation; when aborted the loop returns the latest empty page at once. */
  signal?: AbortSignal;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Generic long-poll wrapper over the seam's `fetchRecent`, used ONLY by the MCP `fetch_recent`
 * tool (issue #20). It gives EVERY backend blocking semantics with zero plugin changes, and lets a
 * backend that DOES honor `blockMs` natively block efficiently — the two compose:
 *
 *   - Each iteration calls `plugin.fetchRecent({ ...args, since, blockMs: remaining })`.
 *     A native plugin blocks up to `remaining` inside that one call; a non-native plugin ignores
 *     the field and returns immediately.
 *   - Non-empty result → return at once.
 *   - Deadline reached (or aborted) → return the latest (empty) page with a STABLE, replayable
 *     `nextCursor`.
 *   - Otherwise sleep `min(pollIntervalMs, remaining)` and retry, advancing `since` to the last
 *     `nextCursor` so we only ever wait for messages STRICTLY AFTER the caller's position and never
 *     re-scan the window.
 *
 * With `blockMs <= 0` this collapses to a single plain `fetchRecent` (current semantics). Blocking
 * only engages relative to a `since`: with no `since` the first fetch returns the recent window
 * immediately, exactly as before.
 */
export async function fetchRecentBlocking(
  plugin: BackendPlugin,
  args: FetchRecentArgs,
  opts: BlockingFetchOptions,
): Promise<FetchRecentResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const deadline = now() + Math.max(0, opts.blockMs);

  let since: Cursor | undefined = args.since;
  for (;;) {
    const remaining = deadline - now();
    const result = await plugin.fetchRecent({
      ...args,
      since,
      blockMs: Math.max(0, remaining),
    });
    if (result.messages.length > 0) return result;

    // Advance so the next wait is exclusive of everything we've already seen (incl. the tail).
    since = result.nextCursor;

    if (now() >= deadline || opts.blockMs <= 0 || opts.signal?.aborted) return result;

    const nap = Math.min(opts.pollIntervalMs, Math.max(0, deadline - now()));
    if (nap <= 0) return result;
    await sleep(nap);
    if (opts.signal?.aborted) {
      // Re-query once so the returned cursor reflects anything that landed during the nap.
      return plugin.fetchRecent({ ...args, since, blockMs: 0 });
    }
  }
}
