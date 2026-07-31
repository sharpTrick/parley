/**
 * The non-2xx a caller did not allow, carrying the status as a FIELD.
 *
 * `message` keeps the `<label> → <status>: <body>` shape five backends' tests read, but a caller
 * that branches on the status (Telegram's fatal `getUpdates` statuses) must use {@link statusOf}:
 * recovering it by regex over prose makes any reword a silent behaviour change.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly label: string;
  readonly body: string;

  constructor(label: string, status: number, body: string) {
    super(`${label} → ${status}: ${body}`);
    this.name = 'HttpStatusError';
    this.label = label;
    this.status = status;
    this.body = body;
  }
}

/**
 * A rejection raised after the response's status was known. Keep the status ON the error, so that a
 * caller branching through {@link statusOf} keeps branching on the paths that fail while READING —
 * a rate limit that also floods, or dies mid-body, is still a rate limit.
 */
export class LabelledError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status;
  }
}

/** Thrown by name so a caller can tell "the upstream flooded us" from an ordinary status failure. */
export class BodyTooLargeError extends Error {}

/**
 * HTTP status behind a `fetchWithRetry` rejection, or undefined when no response was received.
 * Read off the FIELD, not off `instanceof` or the message, so a plugin resolving a second copy of
 * this package is still graded honestly — and so every rejection raised after a status was received
 * reports it, not only the `<label> → <status>: <body>` one.
 */
export function statusOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const { status } = err as { status?: unknown };
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
