import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler, Express } from 'express';

const GENERIC_STATUS = 500;

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
  console.error('[parley] request failed:', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = statusOf(err);
  res.status(status).type('txt').send(`${status} ${STATUS_CODES[status] ?? 'Error'}`);
};

function statusOf(err: unknown): number {
  const carrier = err as { status?: unknown; statusCode?: unknown } | null | undefined;
  const claimed = typeof carrier?.status === 'number' ? carrier.status : carrier?.statusCode;
  if (typeof claimed !== 'number' || !Number.isInteger(claimed) || claimed < 400 || claimed > 599) {
    return GENERIC_STATUS;
  }
  return claimed;
}
