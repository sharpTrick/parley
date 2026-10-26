/**
 * The hostnames a remote front door may serve over plain `http:`.
 *
 * Keep this set equal to the MCP SDK's own issuer exemption — `checkIssuerUrl` in
 * @modelcontextprotocol/sdk/server/auth/router.js exempts exactly `localhost` and `127.0.0.1` — so
 * that a base URL this repo accepts also boots on the built-in front door, which hands `issuerUrl`
 * straight to it. Widening this set (IPv6 loopback, a .localhost name, the rest of 127.0.0.0/8)
 * boots here and dies there.
 *
 * A leaf module on purpose: the zod schema in config-auth.ts asks the same question, and
 * `auth/invariants.ts` imports express at module scope.
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** True for a URL whose host is one the SDK will accept an `http:` issuer on. */
export const isLoopbackAuthHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);
