import type { BackendMsgId, Handle, Topic } from '../message.js';
import type { BackendPlugin } from '../seam.js';

/**
 * Every SHAPE a seam call's failure can arrive in. The seam signature says `Promise<…>`, but a
 * plugin may implement it as a plain function that validates its arguments and throws BEFORE
 * returning one, and it may reject with a non-Error. Core has to absorb all of them identically.
 *
 * Each shape ignores the real call's result, so the same table drives any seam call regardless of
 * what it resolves to.
 */
export const FAILURE_SHAPES = {
  rejects: (_real: Promise<unknown>): Promise<never> => Promise.reject(new Error('seam boom')),
  'rejects with a non-Error': (_real: Promise<unknown>): Promise<never> =>
    Promise.reject('seam boom (string)'),
  'rejects synchronously': (_real: Promise<unknown>): Promise<never> => {
    throw new Error('seam boom (sync)');
  },
  'throws a non-Error synchronously': (_real: Promise<unknown>): Promise<never> => {
    throw 'seam boom (sync, string)';
  },
  'never settles': (_real: Promise<unknown>): Promise<never> => new Promise<never>(() => {}),
} as const;

export type FailureShape = keyof typeof FAILURE_SHAPES;
export const FAILURE_SHAPE_NAMES = Object.keys(FAILURE_SHAPES) as FailureShape[];

/**
 * Every way a backend's `post` can behave, as seen by core's fire-and-forget presence path: the
 * failure shapes above plus the two that settle (immediately, and long after any teardown budget).
 */
export const POST_BEHAVIOURS = {
  resolves: (real: Promise<BackendMsgId>): Promise<BackendMsgId> => real,
  ...FAILURE_SHAPES,
  'settles long after the teardown budget': (real: Promise<BackendMsgId>): Promise<BackendMsgId> =>
    real.then((id) => new Promise<BackendMsgId>((r) => setTimeout(() => r(id), 30_000).unref?.())),
} as const;

export type PostBehaviour = keyof typeof POST_BEHAVIOURS;
export const POST_BEHAVIOUR_NAMES = Object.keys(POST_BEHAVIOURS) as PostBehaviour[];

/**
 * Install a behaviour over a plugin's `post`, keeping the wrapper NON-async so that a synchronous
 * throw stays synchronous. Re-wrapping in `async` turns it into an ordinary rejection, which
 * silently degrades every sync-throw row into a duplicate of the plain `rejects` row — and the
 * unhandled-rejection class those rows exist to catch sails straight through.
 */
export function installPost(plugin: BackendPlugin, behaviour: PostBehaviour): void {
  const orig = plugin.post.bind(plugin);
  plugin.post = ((
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> =>
    POST_BEHAVIOURS[behaviour](orig(topic, identity, content, opts))) as BackendPlugin['post'];
}

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
