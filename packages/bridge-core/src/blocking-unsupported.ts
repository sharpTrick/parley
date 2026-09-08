const MARKER = 'BlockingFetchUnsupportedError';

/**
 * Raised by a `fetchRecent` asked to honour a `blockMs` its backend has no read primitive to park
 * on. `parley_fetch_recent` advertises `block_ms` on every deployment, so the refusal is what tells
 * a caller the budget was not served — a page returned as if the wait had happened is
 * indistinguishable from a long-poll that timed out empty, and a polling agent then burns a turn per
 * tick believing it is parked.
 *
 * Lives in core because plugins depend on core and never the reverse (CLAUDE.md prime directive #1).
 */
export class BlockingFetchUnsupportedError extends Error {
  constructor(public readonly backend: string) {
    super(
      `${backend}: \`block_ms\` is not supported by this backend — its read path has no primitive ` +
        "to park a caller's budget on. Omit `block_ms` and poll on your own cadence.",
    );
    this.name = MARKER;
  }
}

/**
 * True for a {@link BlockingFetchUnsupportedError} raised by ANY copy of this package.
 *
 * `instanceof` answers "was this thrown by MY class object", not "is this the seam contract". A
 * consumer that pins `@sharptrick/parley-core` at one version while a plugin depends on another ends
 * up with two installs and two distinct classes, and the refusal then reads as a hard backend
 * failure. Recognise it by its marker instead, exactly as `isNoSuchTopicError` does for the absence
 * sentinel.
 */
export function isBlockingFetchUnsupportedError(err: unknown): boolean {
  if (err instanceof BlockingFetchUnsupportedError) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === MARKER;
}

/**
 * The `blockMs` half of the seam contract, in one place: a backend that cannot serve a caller's
 * budget REFUSES it rather than answering as though it had waited. Called by every plugin whose read
 * path has nowhere to put the budget; a plugin that blocks natively never calls it.
 *
 * `> 0` and not "present": core hands a plugin `blockMs: 0` on the ordinary catch-up path, and that
 * is the durable read every backend serves.
 */
export function assertBlockMsUnsupported(backend: string, blockMs: number | undefined): void {
  if (blockMs !== undefined && blockMs > 0) throw new BlockingFetchUnsupportedError(backend);
}
