/** `setTimeout` promise — the one copy that replaces the per-plugin `delay` duplicates. */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How often a backoff re-reads `isStopped()`. Bounds how long a disconnect waits on a backoff. */
export const STOP_POLL_MS = 25;

/**
 * Sleep `ms`, resolving false as soon as `isStopped()` polls true. Keep the wait racing against
 * that poll rather than only checking around it, so that a disconnect landing mid-backoff is not
 * held for the server's stated wait — which is deliberately unbounded, so a routine
 * `Retry-After: 25` would otherwise stall `disconnect()` for 25 seconds and pin the event loop.
 */
export async function sleepUnlessStopped(ms: number, isStopped: () => boolean): Promise<boolean> {
  if (isStopped()) return false;
  let resolveWait!: (v: boolean) => void;
  const wait = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
  const cancels: (() => void)[] = [];
  const finish = (v: boolean): void => {
    for (const cancel of cancels) cancel();
    resolveWait(v);
  };

  // Take the resolve and arm the poll before the wait timer, so that a timer firing the instant it
  // is armed still finds a resolve to call and a poll to cancel. Reordering leaks the interval.
  const poll = setInterval(() => {
    if (isStopped()) finish(false);
  }, STOP_POLL_MS);
  cancels.push(() => clearInterval(poll));
  const waited = setTimeout(() => finish(true), ms);
  cancels.push(() => clearTimeout(waited));
  return wait;
}
