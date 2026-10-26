import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler, Express } from 'express';

const GENERIC_STATUS = 500;

/** Enough of a message or a stack to diagnose from; short enough that logging it is not a service. */
const MESSAGE_MAX = 120;
const STACK_MAX = 2000;

/**
 * Everything that does not survive being written into a log as itself: every control (`Cc`: C0, C1,
 * DEL) and format character (`Cf`: the bidi overrides and isolates, ZWSP, BOM), the two line and
 * paragraph separators, which are `Zl`/`Zp` and so in neither class, and a surrogate with no partner
 * — which under `u` is the only thing this range can still match, an astral character being one code
 * point. `JSON.stringify` escapes the first family and nothing else.
 *
 * Keep this as the CLASSES rather than a hand-listed set, so that a family nobody thought of — NEL,
 * CSI, an isolate added in a later Unicode — cannot forge line structure.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029\ud800-\udfff]/gu;

/**
 * Keep BOTH halves of this. Express hands any error no route caught to its default handler, which
 * renders `err.stack` — absolute install paths and frame list — into the response body whenever
 * `env` is not 'production'. The browser-facing OAuth front door is unauthenticated, and a generic
 * framework failure (oversize body, unparseable body, unsupported charset) reaches that handler on
 * every route, so pinning `env` and terminating the chain here is what keeps an anonymous request
 * from reading back the server's filesystem layout.
 */
export function hardenErrorSurface(app: Express): void {
  app.set('env', 'production');
  app.use(terminalErrorHandler);
}

const terminalErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const status = statusOf(err);
  console.error('[parley] request failed:', errorDigest(err, status));
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(status).type('txt').send(`${status} ${STATUS_CODES[status] ?? 'Error'}`);
};

/**
 * What an operator gets to see about a failed request, built here rather than being the error
 * itself. `console.error` prints an Error's own enumerable properties, and body-parser attaches the
 * RAW request body to the errors it raises — on the unauthenticated OAuth doors that is the body
 * carrying `passphrase`, `client_secret`, `code_verifier` and `refresh_token`, so handing the object
 * over publishes whatever an anonymous caller chose to send, as often as they choose to send it.
 * `name`, `type` and the status say which parser branch fired, which is what the log is for.
 *
 * Message and stack are kept only for a GENERIC_STATUS fault — our own code failing, where nothing
 * attached a request body and the stack is the whole diagnosis. Every 4xx here is the framework
 * refusing something the caller shaped, and its message quotes that input back: V8's own JSON
 * SyntaxError embeds a slice of the document it could not parse.
 */
export function errorDigest(err: unknown, status: number = statusOf(err)): Record<string, unknown> {
  const carrier = err as
    | { name?: unknown; type?: unknown; message?: unknown; stack?: unknown }
    | null
    | undefined;
  const digest: Record<string, unknown> = {
    status,
    name: logSafe(carrier?.name, MESSAGE_MAX),
    type: logSafe(carrier?.type, MESSAGE_MAX),
  };
  if (status === GENERIC_STATUS) {
    digest.message = logSafe(carrier?.message, MESSAGE_MAX);
    digest.stack = logSafe(carrier?.stack, STACK_MAX);
  }
  return digest;
}

/** `value` as a bounded, printable one-liner, or undefined if it was never a string to begin with. */
function logSafe(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clipped = value.length > max ? `${value.slice(0, max)}[+${value.length - max}]` : value;
  return clipped.replace(UNPRINTABLE, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

function statusOf(err: unknown): number {
  const carrier = err as { status?: unknown; statusCode?: unknown } | null | undefined;
  const claimed = typeof carrier?.status === 'number' ? carrier.status : carrier?.statusCode;
  if (typeof claimed !== 'number' || !Number.isInteger(claimed) || claimed < 400 || claimed > 599) {
    return GENERIC_STATUS;
  }
  return claimed;
}
