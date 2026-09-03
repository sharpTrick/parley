/**
 * Every SHAPE a seam call's failure can arrive in AT A FIRE-AND-FORGET SITE. Core has to absorb all
 * of them identically, and it may reject with a non-Error or never settle at all.
 *
 * A synchronous throw is not among them: every surviving site wraps the call in an `async` function,
 * which converts a sync throw into a rejection before the `void … .catch()` sees it, so a sync shape
 * would be an async twin that can never fail on its own.
 *
 * Each shape ignores the real call's result, so the same table drives any seam call regardless of
 * what it resolves to.
 */
export const FAILURE_SHAPES = {
  rejects: (_real: Promise<unknown>): Promise<never> => Promise.reject(new Error('seam boom')),
  'rejects with a non-Error': (_real: Promise<unknown>): Promise<never> =>
    Promise.reject('seam boom (string)'),
  'never settles': (_real: Promise<unknown>): Promise<never> => new Promise<never>(() => {}),
} as const;

export type FailureShape = keyof typeof FAILURE_SHAPES;
export const FAILURE_SHAPE_NAMES = Object.keys(FAILURE_SHAPES) as FailureShape[];

/**
 * Collect every unhandled rejection raised while `work` runs. Node reports one a turn after the
 * microtask queue drains, so this keeps listening for a macrotask past the end of `work`.
 */
export async function unhandledDuring(work: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const capture = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', capture);
  try {
    await work();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    process.off('unhandledRejection', capture);
  }
  return escaped;
}
