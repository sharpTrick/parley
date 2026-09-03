/**
 * Every SHAPE a seam call's failure can arrive in AT A FIRE-AND-FORGET SITE. Core has to absorb all
 * of them identically, and it may reject with a non-Error or never settle at all.
 *
 * Keep the two SYNCHRONOUS shapes, so that the `async` wrapper each site relies on stays graded: a
 * `.catch()` does not absorb a throw raised before it is attached.
 *
 * Each shape ignores the real call's result, so the same table drives any seam call regardless of
 * what it resolves to.
 */
export const FAILURE_SHAPES = {
  rejects: (_real: Promise<unknown>): Promise<never> => Promise.reject(new Error('seam boom')),
  'rejects with a non-Error': (_real: Promise<unknown>): Promise<never> =>
    Promise.reject('seam boom (string)'),
  'never settles': (_real: Promise<unknown>): Promise<never> => new Promise<never>(() => {}),
  'rejects synchronously': (_real: Promise<unknown>): Promise<never> => {
    throw new Error('seam boom (sync)');
  },
  'throws a non-Error synchronously': (_real: Promise<unknown>): Promise<never> => {
    throw 'seam boom (sync, string)';
  },
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
