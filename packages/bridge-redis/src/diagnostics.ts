import type { Topic } from '@sharptrick/parley-core';
import { sanitizeBody } from '@sharptrick/parley-net-util';

// Every line this file writes goes to stderr: stdout is the MCP JSON-RPC channel.

/** `host:port` of a connection URL — never the password, which must not reach a log line. */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port === '' ? '6379' : u.port}`;
  } catch {
    return '<unparseable url>';
  }
}

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Every spelling this connection's password can be echoed back in: the one the URL carries, which
 * `URL` hands back PERCENT-ENCODED, and the decoded one the client puts on the wire. A sweep that
 * knows a single spelling is half a sweep.
 */
function passwordSpellings(url: string): string[] {
  let password: string;
  try {
    password = new URL(url).password;
  } catch {
    return [];
  }
  if (password === '') return [];
  const spellings = new Set([password]);
  try {
    spellings.add(decodeURIComponent(password));
  } catch {
    /* a stray '%' makes it no escape sequence at all; the spelling above is then the only one */
  }
  return [...spellings];
}

/**
 * Server-supplied text, made safe to put in an `Error` (which core renders into model context) or
 * in a log line: this connection's own password struck out, then bounded and stripped of the
 * control and format characters a hostile reply would forge line structure with. Keep it on every
 * path that embeds a RESP error, so that a server which quotes back the arguments it was given —
 * exactly what Redis's `unknown command '<cmd>', with args beginning with: '<arg>'` does to AUTH —
 * cannot hand it this plugin's own password to log.
 */
export function fromServer(url: string, text: string): string {
  let redacted = text;
  for (const spelling of passwordSpellings(url)) {
    redacted = redacted.split(spelling).join('<redacted>');
  }
  return sanitizeBody(redacted);
}

/**
 * Keep this line, so that a live path which can no longer deliver does not look identical to a
 * quiet topic: `subscribe()` has already resolved, core keeps advertising this instance as
 * subscribed, and nothing else in the process would ever mention the fault.
 */
export function reportLiveDeliveryStopped(url: string, topic: Topic, respError: string): void {
  process.stderr.write(
    `parley-redis: live delivery STOPPED for topic '${topic}' — the server refused the stream ` +
      `read: ${fromServer(url, respError)}. Catch-up still works; fix the cause and restart the ` +
      `bridge.\n`,
  );
}

/**
 * Keep this line, so that a fault the loop keeps RETRYING does not look identical to a quiet topic
 * either: the retry is right — the fault may still clear — but an operator whose stream reads have
 * all failed has no other way to learn live delivery has been dead since startup. Worded as
 * still-retrying, so it is not confused with the STOPPED line above.
 */
export function reportLiveDeliveryDegraded(
  url: string,
  topic: Topic,
  failures: number,
  error: string,
): void {
  process.stderr.write(
    `parley-redis: live delivery DEGRADED for topic '${topic}' — ${failures} stream reads in a ` +
      `row failed and it is still retrying: ${fromServer(url, error)}. Catch-up still works.\n`,
  );
}

export function reportLiveDeliveryResumed(url: string, topic: Topic, failures: number): void {
  process.stderr.write(
    `parley-redis: live delivery RESUMED for topic '${topic}' at ${endpointOf(url)} after ` +
      `${failures} failed stream reads.\n`,
  );
}
