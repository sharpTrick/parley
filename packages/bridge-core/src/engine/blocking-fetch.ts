import type { Cursor } from '../message.js';
import type { BackendPlugin, FetchRecentArgs, FetchRecentResult } from '../seam.js';

/** Options for {@link fetchRecentBlocking}. `now`/`sleep` are injectable for deterministic tests. */
export interface BlockingFetchOptions {
  /** Total long-poll budget in ms. Already clamped to the server cap by the caller. */
  blockMs: number;
  /**
   * Poll cadence for the generic fallback (used only when a plugin returns early/empty). Must be
   * `> 0`: a non-positive cadence is REJECTED, not clamped, because silently degrading it turns a
   * long poll into a single fetch — the opposite of what this function is for. Core's own config
   * schema already guarantees a positive value.
   */
  pollIntervalMs: number;
  /** Monotonic clock in ms. Default `Date.now`. */
  now?: () => number;
  /** Sleep `ms`. Default a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional cancellation. Observed while napping AND while a natively-blocking `fetchRecent` is
   * parked inside the plugin, so an aborted long-poll returns in bounded time rather than after the
   * plugin's full budget. The abandoned plugin call is left to settle on its own — the seam has no
   * way to cancel it — and its page is discarded.
   */
  signal?: AbortSignal;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A long-poll cancelled before any page came back. There is no cursor to return — core never mints
 * cursor values (DESIGN §6) and the caller supplied none — so cancellation cannot be expressed as a
 * {@link FetchRecentResult}. Keep it its own type, so that a routine cancellation is not reported to
 * the agent as a backend failure.
 */
export class FetchAbortedError extends Error {
  constructor() {
    super('fetch_recent cancelled before any page was read');
    this.name = 'FetchAbortedError';
  }
}

/**
 * The literal {@link FetchAbortedError} assigns to `this.name`. Keep it a literal rather than
 * `FetchAbortedError.name`, so that a bundler mangling the class binding cannot make the marker on
 * an instance and the marker being compared against diverge.
 */
const ABORTED_MARKER = 'FetchAbortedError';

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
 * tool. It gives EVERY backend blocking semantics with zero plugin changes, and lets a
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
 * engages whenever the queried window comes back EMPTY, with or without a `since` — a `since`-less
 * call on a topic that already has messages returns them at once, but on an empty topic it waits
 * out the budget like any other.
 */
export async function fetchRecentBlocking(
  plugin: BackendPlugin,
  args: FetchRecentArgs,
  opts: BlockingFetchOptions,
): Promise<FetchRecentResult> {
  if (!(opts.pollIntervalMs > 0)) {
    throw new RangeError(`pollIntervalMs must be > 0 (got ${opts.pollIntervalMs})`);
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
    if (result.messages.length > 0) return result;

    // Advance so the next wait is exclusive of everything we've already seen (incl. the tail).
    since = result.nextCursor;

    if (now() >= deadline || opts.blockMs <= 0 || opts.signal?.aborted) return result;

    // Race the nap against the signal, so that cancellation latency is bounded by the ABORT and not
    // by the cadence: `block_poll_interval_ms` is an operator knob up to the whole budget, and a nap
    // whose abort is only re-read at the next iteration holds a cancelled long-poll for all of it.
    await untilAborted(sleep(Math.min(opts.pollIntervalMs, Math.max(0, deadline - now()))), opts.signal);
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
