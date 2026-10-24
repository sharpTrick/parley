import type { Topic } from '@sharptrick/parley-core';
import {
  isLoopbackHost,
  type PlaintextCredentialRisk,
  sanitizeBody,
} from '@sharptrick/parley-net-util';

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
 * Every spelling this connection's credential can be echoed back in: the one the URL carries, which
 * `URL` hands back PERCENT-ENCODED, and the decoded one the client puts on the wire. A sweep that
 * knows a single spelling is half a sweep.
 *
 * Keep the credential read from the USERNAME only when there is no password, so that
 * `redis://<user>:<secret>@host` cannot have its ACL name — which Redis itself spells `default` —
 * struck out of every server message. A URL written without the colon puts the secret in the
 * username position instead, and node-redis AUTHs with it either way.
 */
function credentialSpellings(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const credential = parsed.password === '' ? parsed.username : parsed.password;
  if (credential === '') return [];
  const spellings = new Set([credential]);
  try {
    spellings.add(decodeURIComponent(credential));
  } catch {
    /* a stray '%' makes it no escape sequence at all; the spelling above is then the only one */
  }
  return [...spellings];
}

/**
 * Text the CALLER supplied — a topic, an opaque cursor, a rejected `backend_config` value — made
 * safe to put in an `Error` or a log line. Every one of those arrives over a bare `z.string()` from
 * an MCP client, so they are the same untrusted text {@link fromServer} bounds and flattens, on a
 * second channel into the identical sinks. Nothing is redacted here: the caller wrote the text, so
 * there is no secret of ours in it to lose.
 */
export const fromCaller = (text: string): string => sanitizeBody(text);

/**
 * How much of a credential's opening a run of server text must match to be struck out when the whole
 * credential is not there. An exact-match sweep is not enough: Redis cuts its `with args beginning
 * with:` echo at 128 bytes, so a long credential comes back as a PREFIX of itself.
 */
const ECHOED_PREFIX_CHARS = 8;

/**
 * For every position of `text`, how many chars from there match the opening of `credential`: the
 * Z-algorithm over `credential`, a sentinel no char equals, then `text` — linear, so a hostile
 * periodic reply cannot make the sweep quadratic.
 */
function openingMatchLengths(text: string, credential: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < credential.length; i++) units.push(credential.charCodeAt(i));
  units.push(-1);
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  const z = new Array<number>(units.length).fill(0);
  for (let i = 1, left = 0, right = 0; i < units.length; i++) {
    let k = i < right ? Math.min(right - i, z[i - left] ?? 0) : 0;
    while (i + k < units.length && units[k] === units[i + k]) k++;
    z[i] = k;
    if (i + k > right) {
      left = i;
      right = i + k;
    }
  }
  return z.slice(credential.length + 1);
}

/**
 * `text` with every char struck out that lies inside ANY run matching the opening of `credential`.
 * Keep it a check at every position rather than a scan that resumes past each run: a credential
 * with a border (`ABCDEFGHABCDEFGH…`) behind a partial copy of itself matches from the copy, falls
 * short, and the real occurrence starts INSIDE that run — a scan that steps past it leaks the rest.
 * No whole-string pass goes ahead of it either: replacing one of two OVERLAPPING occurrences leaves
 * the other's tail behind with no opening to be found by.
 */
function strikeCredential(text: string, credential: string): string {
  const shortest = Math.min(credential.length, ECHOED_PREFIX_CHARS);
  const matched = openingMatchLengths(text, credential);
  let out = '';
  let reach = 0;
  let striking = false;
  for (let i = 0; i < text.length; i++) {
    const run = matched[i] ?? 0;
    if (run >= shortest) reach = Math.max(reach, i + run);
    if (i >= reach) {
      out += text[i];
      striking = false;
    } else if (!striking) {
      out += '<redacted>';
      striking = true;
    }
  }
  return out;
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
  for (const spelling of credentialSpellings(url)) {
    redacted = strikeCredential(redacted, spelling);
  }
  return sanitizeBody(redacted);
}

/** The one scheme node-redis dials over TLS; `redis:` puts the AUTH it sends on the wire as text. */
const TLS_SCHEME = 'rediss:';

/** A config shape that widens this backend's trust boundary, as the fact rather than the sentence. */
export type ConfigRisk = PlaintextCredentialRisk<'url', 'url'>;

/**
 * A credential in `url` bound for a cleartext remote link. Loopback is not a risk, and neither is a
 * URL with no credential to lose; the ORIGIN is named and never the value.
 */
export function configRisks(url: string): ConfigRisk[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const carriesCredential = parsed.username !== '' || parsed.password !== '';
  if (parsed.protocol === TLS_SCHEME || !carriesCredential || isLoopbackHost(parsed.hostname)) {
    return [];
  }
  return [{ key: 'url', origin: `${parsed.protocol}//${parsed.host}`, exposes: ['url'] }];
}

/** The operator's stderr line for a risk. Rendered from the risk, so it cannot describe another. */
export const describeRisk = (risk: ConfigRisk): string =>
  `backend_config.${risk.key} ${risk.origin} carries a credential over plaintext ` +
  `${new URL(risk.origin).protocol}// to a non-loopback host, so the AUTH this bridge sends from ` +
  `${risk.exposes.map((k) => `backend_config.${k}`).join(' and ')} — and every message body after ` +
  'it — crosses the network in the clear. Use rediss:// for any remote server.';

/**
 * Keep this line, so that an operator who put a password in `backend_config.url` and pointed it at a
 * shared deployment — which both the README quickstart and `examples/multi-session` invite — learns
 * that every host on the path can read it and post as this bridge.
 */
export function reportPlaintextCredential(url: string): void {
  for (const risk of configRisks(url)) {
    process.stderr.write(`parley-redis: SECURITY: ${describeRisk(risk)}\n`);
  }
}

/**
 * Keep this line, so that a live path which can no longer deliver does not look identical to a
 * quiet topic: `subscribe()` has already resolved, core keeps advertising this instance as
 * subscribed, and nothing else in the process would ever mention the fault.
 */
export function reportLiveDeliveryStopped(url: string, topic: Topic, respError: string): void {
  process.stderr.write(
    `parley-redis: live delivery STOPPED for topic '${fromCaller(topic)}' — the server refused ` +
      `the stream read: ${fromServer(url, respError)}. Catch-up still works; fix the cause and ` +
      `restart the bridge.\n`,
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
    `parley-redis: live delivery DEGRADED for topic '${fromCaller(topic)}' — ${failures} stream ` +
      `reads in a row failed and it is still retrying: ${fromServer(url, error)}. Catch-up still ` +
      `works.\n`,
  );
}

export function reportLiveDeliveryResumed(url: string, topic: Topic, failures: number): void {
  process.stderr.write(
    `parley-redis: live delivery RESUMED for topic '${fromCaller(topic)}' at ` +
      `${endpointOf(url)} after ${failures} failed stream reads.\n`,
  );
}
