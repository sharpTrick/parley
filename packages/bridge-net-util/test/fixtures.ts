import { readFileSync } from 'node:fs';
import { afterEach, vi } from 'vitest';
import type { FetchWithRetryOptions } from '@sharptrick/parley-net-util';

/** The published description, read once: several checks in this suite derive a bound FROM it. */
export const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** A figure the README states, as the figure — so restating it here cannot drift from the prose. */
export function documentedFigure(pattern: RegExp, what: string): number {
  const found = pattern.exec(README);
  if (found === null) throw new Error(`the README no longer states ${what}`);
  return Number(found[1]);
}

export const OPTS = {
  label: 'Test GET /thing',
  isStopped: () => false,
  retryAfterOf: () => 1,
};

/** The bounds a case cares about, over the two options every case has to state. */
export const loop = (opts: Partial<FetchWithRetryOptions> = {}): FetchWithRetryOptions => ({
  label: 'L',
  isStopped: () => false,
  ...opts,
});

/** Canned responses in order; the stub records every call. */
export function stubFetch(responses: Response[]): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', () => {
    const res = responses[state.calls];
    state.calls++;
    if (res === undefined) throw new Error(`unexpected fetch call #${state.calls}`);
    return Promise.resolve(res);
  });
  return state;
}

/** A server that returns the same status forever — the shape a fixed array cannot express. */
export function stubForever(make: () => Response): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', () => {
    state.calls++;
    return Promise.resolve(make());
  });
  return state;
}

/**
 * A server that accepts the request and never answers, settling only if the request is aborted —
 * what a real `fetch` does, and the shape every stub above hides.
 */
export function stubStalling(opts: { settleAfterMs?: number } = {}): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
    state.calls++;
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (opts.settleAfterMs !== undefined) {
        setTimeout(() => resolve(new Response('late', { status: 200 })), opts.settleAfterMs);
      }
      if (signal === undefined || signal === null) return;
      if (signal.aborted) reject(signal.reason as Error);
      else signal.addEventListener('abort', () => reject(signal.reason as Error));
    });
  });
  return state;
}

/** Capture the waits a run performs without actually sleeping. */
export function captureWaits(): number[] {
  const waits: number[] = [];
  vi.stubGlobal('setTimeout', ((fn: () => void, ms: number) => {
    waits.push(ms);
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  return waits;
}

export const res = (status: number, body = '', headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

export const rejects = async (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e as Error,
  );

/**
 * The globals every file here stubs. Called per file rather than registered on import, so that a
 * worker evaluating this module once still arms the hook for each suite that loads it.
 */
export function resetGlobalsAfterEach(): void {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}
