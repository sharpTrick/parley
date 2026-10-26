import type { Cursor } from '../message.js';
import type { BackendPlugin, FetchRecentArgs, FetchRecentResult } from '../seam.js';
import { isArmableDelay, MAX_TIMER_MS } from '../timer-bounds.js';

/** Options for {@link fetchRecentBlocking}. `now`/`sleep` are injectable for deterministic tests. */
export interface BlockingFetchOptions {
  /** Total long-poll budget in ms. Already clamped to the server cap by the caller. */
  blockMs: number;
  /**
   * Cadence at which the budget is re-driven when a plugin returns early/empty. Must be in
   * `[1, MAX_TIMER_MS]`: a cadence outside that is REJECTED, not clamped, because silently degrading
   * it turns a long poll into a single fetch — the opposite of what this function is for — and every
   * value off either end arms the nap at ~1 ms, which is a spin against the backend rather than a
   * poll. Core's own config schema already guarantees a value inside it.
   */
  pollIntervalMs: number;
  /** Monotonic clock in ms. Default `Date.now`. */
  now?: () => number;
  /**
   * Sleep `ms`, resolving early if `signal` fires. Default a real `setTimeout` that CLEARS its timer
   * on abort: the nap is up to the caller's whole remaining budget (minutes), so a timer left armed
   * holds the Node event loop open for all of it after the request it belonged to has been answered
   * and thrown away — a shutdown then waits on a poll that nobody is listening to.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Optional cancellation. Observed while napping AND while a natively-blocking `fetchRecent` is
   * parked inside the plugin, so an aborted long-poll returns in bounded time rather than after the
   * plugin's full budget. The abandoned plugin call is left to settle on its own — the seam has no
   * way to cancel it — and its page is discarded.
   */
  signal?: AbortSignal;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const ABORTED_MARKER = 'FetchAbortedError';

/**
 * A long-poll cancelled before any page came back. There is no cursor to return — core never mints
 * cursor values (DESIGN §6) and the caller supplied none — so cancellation cannot be expressed as a
 * {@link FetchRecentResult}. Keep it its own type, so that a routine cancellation is not reported to
 * the agent as a backend failure.
 */
export class FetchAbortedError extends Error {
  constructor() {
    super('fetch_recent cancelled before any page was read');
  }

  override readonly name: typeof ABORTED_MARKER = ABORTED_MARKER;
}

/**
 * True for a {@link FetchAbortedError} raised by ANY copy of this package.
 *
 * `instanceof` answers "was this thrown by MY class object", not "is this a cancellation". A tree
 * with two installs of `@sharptrick/parley-core` has two distinct classes, and an `instanceof` check
 * then renders a routine client cancellation to the agent as a backend failure. Recognise it by its
 * marker instead, exactly as `isNoSuchTopicError` does for the absence sentinel.
 */
export function isFetchAbortedError(err: unknown): boolean {
  if (err instanceof FetchAbortedError) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === ABORTED_MARKER;
}

const ABORTED = Symbol('aborted');

/**
 * Resolve with `work`'s value, or with {@link ABORTED} as soon as `signal` fires — whichever comes
 * first. A rejection from `work` still propagates while `work` is the winner.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Generic long-poll wrapper over the seam's `fetchRecent`, used ONLY by the MCP `fetch_recent`
 * tool. It owns the cancellation race, the coarse-delivery arrival filter, the range validation and
 * the re-drive of a budget a plugin returned early from — a natively blocking backend still needs
 * every one of them:
 *
 *   - Each iteration calls `plugin.fetchRecent({ ...args, since, blockMs: remaining })`.
 *     A native plugin blocks up to `remaining` inside that one call. A backend with nowhere to put
 *     the budget REFUSES it — `BlockingFetchUnsupportedError` off the very first call, propagated
 *     unchanged, never retried or emulated, so the caller learns the wait did not happen.
 *   - A page carrying the REQUESTED topic → return at once. A page carrying only other topics (a
 *     backend whose delivery is coarser than a topic) is not arrival: `since` advances past it and
 *     the wait continues.
 *   - Deadline reached (or aborted) → return the latest (empty) page with a STABLE, replayable
 *     `nextCursor`.
 *   - Otherwise sleep `min(pollIntervalMs, remaining)` and retry, advancing `since` to the last
 *     `nextCursor` so we only ever wait for messages STRICTLY AFTER the caller's position and never
 *     re-scan the window.
 *
 * With `blockMs <= 0` this collapses to a single plain `fetchRecent` (current semantics). Blocking
 * engages whenever the queried window comes back EMPTY, with or without a `since` — a `since`-less
 * call on a topic that already has messages returns them at once, but on an empty topic it waits
 * out the budget like any other.
 */
export async function fetchRecentBlocking(
  plugin: BackendPlugin,
  args: FetchRecentArgs,
  opts: BlockingFetchOptions,
): Promise<FetchRecentResult> {
  if (!isArmableDelay(opts.pollIntervalMs)) {
    throw new RangeError(
      `pollIntervalMs must be in [1, ${MAX_TIMER_MS}] (got ${opts.pollIntervalMs})`,
    );
  }
  // A non-finite budget is neither `> 0` nor `<= 0`, so every deadline comparison below answers false
  // and the loop naps forever — refuse it here rather than hanging the caller's request.
  if (!Number.isFinite(opts.blockMs)) {
    throw new RangeError(`blockMs must be finite (got ${opts.blockMs})`);
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const deadline = now() + Math.max(0, opts.blockMs);

  let since: Cursor | undefined = args.since;
  for (;;) {
    // Keep this ahead of the fetch, so that an already-aborted signal costs no backend query:
    // `untilAborted` short-circuits on it, but the plugin call is EVALUATED first and its page then
    // thrown away — once on entry, and once more for every nap the abort lands in.
    if (opts.signal?.aborted) return abandoned(since);
    const remaining = deadline - now();
    const result = await untilAborted(
      plugin.fetchRecent({ ...args, since, blockMs: Math.max(0, remaining) }),
      opts.signal,
    );
    if (result === ABORTED) return abandoned(since);
    // Decide arrival on the topic that was ASKED for. A backend whose history read is coarser than a
    // topic answers a query for `ctx` with a page of somebody else's traffic, and taking that as
    // arrival ends the long poll on a page the caller's own filter then empties — so a busy shared
    // room collapses every long poll into a single fetch.
    if (result.messages.some((m) => m.topic === args.topic)) return result;

    // Advance so the next wait is exclusive of everything we've already seen (incl. the tail).
    since = result.nextCursor;

    if (now() >= deadline || opts.blockMs <= 0 || opts.signal?.aborted) return result;

    // Race the nap against the signal, so that cancellation latency is bounded by the ABORT and not
    // by the cadence: `block_poll_interval_ms` is an operator knob up to the whole budget, and a nap
    // whose abort is only re-read at the next iteration holds a cancelled long-poll for all of it.
    await untilAborted(
      sleep(Math.min(opts.pollIntervalMs, Math.max(0, deadline - now())), opts.signal),
      opts.signal,
    );
  }
}

/**
 * What a cancelled long-poll returns: the caller's own position, empty. Before the first page has
 * landed there is no cursor to hand back and none may be invented, so it raises
 * {@link FetchAbortedError} — which callers map back to an empty result rather than to a failure.
 */
function abandoned(since: Cursor | undefined): FetchRecentResult {
  if (since === undefined) throw new FetchAbortedError();
  return { messages: [], nextCursor: since };
}
