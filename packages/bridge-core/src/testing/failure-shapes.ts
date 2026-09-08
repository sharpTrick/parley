/**
 * Every SHAPE a seam call's failure can arrive in AT A FIRE-AND-FORGET SITE. Core has to absorb all
 * of them identically, and it may reject with a non-Error or never settle at all.
 *
 * Keep the two SYNCHRONOUS shapes, so that the `async` wrapper each site relies on stays graded: a
 * `.catch()` does not absorb a throw raised before it is attached.
 *
 * Keep the NON-NATIVE thenable, so that a site is graded on ADOPTING what it was handed rather than
 * on recognising it: `x instanceof Promise` compiles and passes every other row here. It wraps an
 * already-rejected native promise, which is what makes dropping it visible — the inner rejection
 * reaches Node unhandled unless something calls `then` on the wrapper. A seam handler's return type
 * is `void`, which constrains nothing about what it actually returns, and `Promise.resolve` was
 * chosen precisely because it adopts any thenable.
 *
 * Each shape ignores the real call's result, so the same table drives any seam call regardless of
 * what it resolves to.
 */
export const FAILURE_SHAPES = {
  rejects: (_real: Promise<unknown>): Promise<never> => Promise.reject(new Error('seam boom')),
  'rejects with a non-Error': (_real: Promise<unknown>): Promise<never> =>
    Promise.reject('seam boom (string)'),
  'rejects a turn later': (_real: Promise<unknown>): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('seam boom (late)')), 0);
    }),
  'rejects as a non-native thenable': (_real: Promise<unknown>): Promise<never> => {
    const inner = Promise.reject(new Error('seam boom (thenable)'));
    return {
      then: (onFulfilled?: unknown, onRejected?: (reason: unknown) => void): Promise<unknown> =>
        inner.then(onFulfilled as undefined, onRejected),
    } as unknown as Promise<never>;
  },
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
 * Collect every failure that ESCAPED while `work` runs — an unhandled rejection, and equally the
 * `uncaughtException` a synchronous throw becomes when it leaves an event handler nothing is
 * awaiting. Listening for rejections alone reads that second case as clean, which is how a
 * fire-and-forget site that stopped absorbing a synchronous throw kept a table of shapes green.
 * Node reports a rejection a turn after the microtask queue drains, so this keeps listening for a
 * macrotask past the end of `work`.
 */
export async function unhandledDuring(work: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const capture = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on('unhandledRejection', capture);
  process.on('uncaughtException', capture);
  try {
    await work();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    process.off('unhandledRejection', capture);
    process.off('uncaughtException', capture);
  }
  return escaped;
}
