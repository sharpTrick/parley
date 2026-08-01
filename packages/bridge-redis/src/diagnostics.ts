import type { Topic } from '@sharptrick/parley-core';
import { isLoopbackHost, sanitizeBody } from '@sharptrick/parley-net-util';

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

const MINTED_HERE = Symbol('parley-redis');

/**
 * An error this plugin composed, marked as one.
 *
 * Keep the mark OFF the message, so that a server whose RESP error opens with `parley-redis:`
 * cannot pass its own text off as already sanitized: a provenance test the SERVER can spell hands
 * back an unbounded, unredacted, line-structure-forging reply verbatim, straight into an operator's
 * log and into the model context core renders a thrown seam error into.
 */
export function pluginError(message: string): Error {
  return Object.assign(new Error(message), { [MINTED_HERE]: true });
}

/** True only of an error {@link pluginError} minted — never of one whose text merely claims to be. */
export function isPluginError(err: unknown): err is Error {
  return err instanceof Error && MINTED_HERE in err;
}

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

/** The one scheme node-redis dials over TLS; `redis:` puts the AUTH it sends on the wire as text. */
const TLS_SCHEME = 'rediss:';

/**
 * Keep this line, so that an operator who put a password in `backend_config.url` and pointed it at a
 * shared deployment — which both the README quickstart and `examples/multi-session` invite — learns
 * that every host on the path can read it and post as this bridge. Loopback is silent, and so is a
 * URL with no credential to lose; the ORIGIN is named and never the value.
 */
export function reportPlaintextCredential(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const carriesCredential = parsed.username !== '' || parsed.password !== '';
  if (parsed.protocol === TLS_SCHEME || !carriesCredential || isLoopbackHost(parsed.hostname)) {
    return;
  }
  process.stderr.write(
    `parley-redis: SECURITY: backend_config.url ${parsed.protocol}//${parsed.host} carries a ` +
      `credential over plaintext ${parsed.protocol}// to a non-loopback host, so the AUTH this ` +
      `bridge sends — and every message body after it — crosses the network in the clear. Use ` +
      `rediss:// for any remote server.\n`,
  );
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
