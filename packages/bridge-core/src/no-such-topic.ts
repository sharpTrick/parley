import { NoSuchTopicError } from './seam.js';

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
    (err as { name?: unknown }).name === NoSuchTopicError.name
  );
}
