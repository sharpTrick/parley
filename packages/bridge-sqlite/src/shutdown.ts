/** The subset of `process` the shutdown wiring touches. */
export interface ShutdownHost {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  stdin: { on(event: 'end' | 'close', listener: () => void): unknown };
}

/**
 * Run `onShutdown` at most once, on a terminating signal or on stdin EOF. Keep both stdin events
 * AND the once-only guard: an orphaned bridge (parent crashed or SIGKILLed) gets EOF and no signal,
 * so without them it heart-beats a ghost peer into every peer's roster — and 'end' followed by
 * 'close', or a signal racing EOF, would otherwise tear the bridge down twice.
 */
export function installShutdown(host: ShutdownHost, onShutdown: () => void): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    onShutdown();
  };
  host.on('SIGINT', shutdown);
  host.on('SIGTERM', shutdown);
  host.stdin.on('end', shutdown);
  host.stdin.on('close', shutdown);
}
