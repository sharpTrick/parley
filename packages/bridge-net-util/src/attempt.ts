import { BodyTooLargeError, LabelledError } from './errors.js';
import { errorText, MAX_ERROR_BODY, redactUrls, sanitizeBody } from './redact.js';

/**
 * Bytes of a body the caller will never be handed worth pulling off the socket: enough that
 * {@link MAX_ERROR_BODY} chars of it survive {@link sanitizeBody} even when every character is four
 * bytes of UTF-8, and enough for a `retryAfterOf` parser to find a hint in a 429's JSON envelope.
 */
const DOOMED_BODY_BYTES = MAX_ERROR_BODY * 4;

/**
 * Read at most `maxBytes` of `res`, then cancel the stream. Keep the bound INSIDE the read, so that
 * a hostile or broken upstream cannot spend the process's memory on a body whose surplus is
 * discarded anyway: `res.text()` buffers whatever arrives before any cap can be applied to it.
 */
async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; overflowed: boolean }> {
  if (res.body === null) return { text: '', overflowed: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      size += value.byteLength;
      if (size > maxBytes) {
        overflowed = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), overflowed };
}

/**
 * Re-read a `Response` off the network into memory, bounded. Keep the whole body inside the
 * attempt's own budget, so that the caller's later `res.json()` cannot be aborted by a deadline
 * signal this module armed — an unlabeled `TimeoutError` escapes the envelope entirely.
 *
 * A response the caller will never be handed — including a 429 the loop only ever retries on, whose
 * body reaches nobody but `retryAfterOf` — is read to {@link DOOMED_BODY_BYTES} and the rest
 * dropped. Keep the retried statuses on this side of the split, so that the one status a hostile
 * upstream controls and repeats is not the one exempt from the cap. One the caller WILL parse
 * cannot be silently truncated — a half body is a corrupt parse, not a smaller one — so past
 * `maxBytes` it fails instead.
 */
async function buffered(res: Response, maxBytes: number, doomed: boolean): Promise<Response> {
  const { text, overflowed } = await readBounded(res, doomed ? DOOMED_BODY_BYTES : maxBytes);
  if (overflowed && !doomed) {
    throw new BodyTooLargeError(`response body exceeded ${maxBytes} bytes`);
  }
  const body = text.length === 0 ? null : text;
  const { status, statusText, headers } = res;
  return new Response(body, { status, statusText, headers });
}

/**
 * Whether `err` IS the caller's own abort, rather than something that failed while the caller
 * happened to be aborting. Keep the test on the ERROR, so that a transport failure racing a
 * plugin's `disconnect()` still leaves through the labelled, redacted envelope: reading the
 * SIGNAL's state alone hands that caller a raw `request to <credential-bearing URL> failed`.
 */
function isCallerAbort(err: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  return err === (signal.reason as unknown) || (err instanceof Error && err.name === 'AbortError');
}

/**
 * One attempt, bounded by `budgetMs`. Without this an unanswered request outlives every bound the
 * options declare — `isStopped` is never consulted while a request is in flight, so a stalled API
 * pins the MCP tool call open for undici's own default and `disconnect()` cannot unblock it.
 */
export async function fetchOnce(
  url: string,
  init: RequestInit,
  budgetMs: number,
  opts: { label: string; maxBytes: number; keeps: (res: Response) => boolean },
): Promise<Response> {
  const { label } = opts;
  const deadline = AbortSignal.timeout(budgetMs);
  const caller = init.signal ?? undefined;
  const controller = new AbortController();
  // Compose by a listener this call REMOVES rather than by `AbortSignal.any`, so that a caller
  // holding one controller for a plugin's lifetime — the documented way to cut a long-poll short —
  // does not accumulate a registration per request: Node records each composite in the source
  // signal's dependent set and prunes none of them while the source lives.
  const onDeadline = (): void => controller.abort(deadline.reason);
  const onCaller = (): void => controller.abort(caller?.reason);
  deadline.addEventListener('abort', onDeadline, { once: true });
  if (caller !== undefined) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener('abort', onCaller, { once: true });
  }

  let received: number | undefined;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    received = res.status;
    return await buffered(res, opts.maxBytes, !opts.keeps(res));
  } catch (err) {
    if (caller !== undefined && isCallerAbort(err, caller)) throw caller.reason;
    if (deadline.aborted) {
      throw new LabelledError(`${label} → deadline: no response within ${budgetMs}ms`, received);
    }
    if (err instanceof BodyTooLargeError) {
      throw new LabelledError(`${label} → body: ${err.message}`, received);
    }
    throw new LabelledError(
      `${label} → transport: ${sanitizeBody(redactUrls(errorText(err), url))}`,
      received,
    );
  } finally {
    deadline.removeEventListener('abort', onDeadline);
    caller?.removeEventListener('abort', onCaller);
  }
}
