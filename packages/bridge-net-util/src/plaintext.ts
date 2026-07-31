import { isIPv4, isIPv6 } from 'node:net';

/**
 * The schemes that carry a credential under TLS. Keep the set on the SECURE side, so that a scheme
 * this classifier has never met — `ws:`, which is how a gateway handshake carries a bot token, and
 * whatever a backend dials next — is warned about rather than passed: `undefined` is read by every
 * caller as "no plaintext-credential risk".
 */
const SECURE_SCHEMES = new Set(['https:', 'wss:']);

/**
 * The origin to name when the URL would put a credential on the wire in the clear, else undefined.
 * Keep the warning on the ORIGIN rather than the whole configured URL, so that a secret smuggled
 * into a path of a key secret-hygiene classifies by NAME as harmless is not the thing stderr — and
 * the tool result core hands the model — prints.
 */
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
