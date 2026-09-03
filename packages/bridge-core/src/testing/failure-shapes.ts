/**
 * Every SHAPE a seam call's failure can arrive in AT A FIRE-AND-FORGET SITE. Core has to absorb all
 * of them identically, and it may reject with a non-Error or never settle at all.
 *
 * The two SYNCHRONOUS shapes look redundant with their async twins today, because every surviving
 * site wraps the call in an `async` function. Keep them anyway, so that the wrapper itself stays
 * graded: rewrite `closeQuietly` non-async and a synchronous throw escapes the `res.on('close')`
 * handler as an uncaught exception that takes the remote bridge down — with the whole core suite
 * green, unless these rows are here to catch it.
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
