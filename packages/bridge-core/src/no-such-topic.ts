const MARKER = 'NoSuchTopicError';

/** Thrown by a plugin whose `fetchRecent`/`subscribe` target topic has no backend
 *  representation yet (e.g. a chat channel that does not exist). Core maps ONLY this to
 *  "topic absent" — all other rejections are real failures and propagate. */
export class NoSuchTopicError extends Error {
  constructor(public readonly topic: string) {
    super(`no such topic: ${JSON.stringify(topic)}`);
    this.name = MARKER;
  }
}

/**
 * True for a {@link NoSuchTopicError} raised by ANY copy of this package.
 *
 * `instanceof` answers "was this thrown by MY class object", not "is this the seam contract". A
 * consumer that pins `@sharptrick/parley-core` at one version while a plugin depends on another
 * ends up with two installs and two distinct classes, and every `instanceof` check in core then
 * reads a plugin's "topic does not exist yet" as a hard backend failure. Recognise the contract by
 * its marker instead, so a duplicated install degrades to nothing rather than to a broken catch-up.
 */
export function isNoSuchTopicError(err: unknown): boolean {
  if (err instanceof NoSuchTopicError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === MARKER
  );
}
