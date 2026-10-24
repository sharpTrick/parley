import { isIPv4, isIPv6 } from 'node:net';

/**
 * The schemes that carry a credential under TLS. Keep the set on the SECURE side, so that a scheme
 * this classifier has never met — `ws:`, which is how a gateway handshake carries a bot token, and
 * whatever a backend dials next — is warned about rather than passed: `undefined` is read by every
 * caller as "no plaintext-credential risk".
 */
const SECURE_SCHEMES = new Set(['https:', 'wss:']);

/**
 * A config value that would put a credential on the wire in the clear, as the FACT rather than as
 * the sentence an operator reads: which `backend_config` key opens the boundary, the endpoint its
 * value names, and which `backend_config` keys hold the secrets that endpoint then receives. Keep a
 * backend's warning RENDERED from one of these and its tests asserting the value, so that a warning
 * reworded to deny the risk cannot pass by still naming the same words.
 */
export interface PlaintextCredentialRisk<Key extends string = string, Secret extends string = string> {
  key: Key;
  /** The endpoint, as safe to print: no userinfo, path or query. */
  origin: string;
  exposes: readonly Secret[];
}

/** The origin to name when the URL would put a credential on the wire in the clear, else undefined. */
export function plaintextRemoteOrigin(baseUrl: string): string | undefined {
  try {
    const { protocol, hostname, host } = new URL(baseUrl);
    if (SECURE_SCHEMES.has(protocol) || hostname === '' || isLoopbackHost(hostname)) {
      return undefined;
    }
    // Built rather than read off `origin`, which is the string "null" for every scheme the URL
    // parser does not know — an operator cannot act on that.
    return `${protocol}//${host}`;
  } catch {
    return undefined;
  }
}

/**
 * Loopback iff the host is exactly `localhost` or a literal `127.0.0.0/8` / `::1` address. Keep this a
 * parse rather than a prefix match, so that a resolvable DNS name shaped like an address —
 * `127.0.0.1.example.com`, `localhost.example.com` — is classified by what it is and still gets the
 * plaintext-credential warning. Anything else, including an IPv4-mapped spelling of a loopback
 * address, counts as remote: an unproven host is warned about rather than excused.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (isIPv4(host)) return host.startsWith('127.');
  if (!isIPv6(host)) return false;
  const groups = host.split(':');
  const tail = groups.pop() ?? '';
  if (groups.some((g) => g !== '' && Number.parseInt(g, 16) !== 0)) return false;
  return Number.parseInt(tail, 16) === 1;
}

/**
 * True for a BASE URL a plugin may concatenate request paths onto: an http(s) URL carrying no
 * userinfo, query or fragment.
 *
 * REFUSE rather than strip. A credential written into a base URL is a credential the operator
 * believes is authenticating the link, and every plugin here authenticates from its own config
 * keys instead — so a silently-stripped one leaves a deployment that reads as configured and
 * connects as anonymous. It is also disclosed by every diagnostic that names the base URL, which
 * is a label no response-body redaction reaches. A query or fragment is refused for the same
 * reason it is in a path: it is appended to every request this plugin ever makes, and can hide a
 * credential under a key hygiene treats as non-secret.
 */
export const isBaseUrl = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return (
    parsed.username === '' && parsed.password === '' && parsed.search === '' && parsed.hash === ''
  );
};
