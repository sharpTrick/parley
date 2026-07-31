import express from 'express';
import type { OidcAuthConfig } from '../config.js';

/**
 * Boot-time invariants for the remote front doors. The config schema checks these too, but the
 * factories are public exports that can be called with a hand-built config object, so the check
 * that actually protects the deployment lives here.
 */

// Keep this set equal to the SDK's own issuer exemption — `checkIssuerUrl` in
// @modelcontextprotocol/sdk/server/auth/router.js exempts exactly `localhost` and `127.0.0.1` — so
// that a base URL this guard accepts also boots on the built-in front door, which hands issuerUrl
// straight to it. Widening this set (IPv6 loopback, a .localhost name) boots here and dies there.
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOOPBACK_LIST = [...LOOPBACK_HOSTS].join(' and ');

const TRANSPORT_SCHEMES = new Set(['http:', 'https:']);

function assertTransportScheme(url: URL, field: string, href: string): void {
  if (TRANSPORT_SCHEMES.has(url.protocol)) return;
  throw new Error(
    `${field} must use the https or http scheme (got "${url.protocol}" in "${href}"). Anything ` +
      `else names something no HTTP client can dereference, and a non-special scheme has the ` +
      `literal origin "null", which makes every same-origin check downstream compare "null" ` +
      `against itself and pass.`,
  );
}

/**
 * The advertised RFC 9728 resource identifier is `publicUrl + mcpPath`, and building it drops every
 * component of the base URL except scheme, host and port. Any component that would be dropped is
 * therefore a server that boots healthy and then 401s every token, or — for userinfo — an owner
 * credential republished in the public metadata document and in every WWW-Authenticate challenge.
 * Refuse each of them by name so the operator learns which one.
 */
export function assertPublicBaseUrl(url: URL, field: string): void {
  assertTransportScheme(url, field, url.href);
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `${field} must not carry userinfo credentials (got "${url.origin}" with a username or ` +
        `password). They would be published verbatim as the resource identifier and the token ` +
        `audience.`,
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `${field} must be an origin with no path (got "${url.href}"). Parley mounts its OAuth and ` +
        `MCP endpoints at the root of this origin, so a base path would be silently dropped from ` +
        `the advertised resource identifier.`,
    );
  }
  if (url.search !== '') {
    throw new Error(
      `${field} must not carry a query string (got "${url.href}"). It is dropped from the ` +
        `advertised resource identifier, which would then name a different resource than the one ` +
        `the operator configured.`,
    );
  }
  if (url.hash !== '') {
    throw new Error(
      `${field} must not carry a fragment (got "${url.href}"). It is dropped from the advertised ` +
        `resource identifier, which would then name a different resource than the one the ` +
        `operator configured.`,
    );
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${field} must use https outside loopback (got "${url.href}"). Only ${LOOPBACK_LIST} are ` +
        `exempt, for local development: they are exactly the hosts the built-in OAuth front door's ` +
        `own issuer check exempts, so any other host — an IPv6 loopback literal included — would ` +
        `be accepted here and refused there. The bearer tokens and the owner passphrase this ` +
        `origin carries have no confidentiality without TLS.`,
    );
  }
}

const LITERAL_PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;

/**
 * The other operand of the resource identifier. `new URL(mcpPath, base)` will happily accept an
 * authority (`//host`, `/\host`), a scheme, or a query/fragment and hand back something that is not
 * a path on this origin at all: the advertised resource, the audience every token is minted with,
 * and the route the app actually serves then disagree, which is a permanent 404 behind a consent
 * the owner already gave. A trailing slash names a different resource than the bare path.
 *
 * The same string is also read as an Express route pattern, a THIRD grammar in which ':', '*',
 * '(', ')' and '+' are metacharacters — `/mcp:v1` registers a named parameter that serves every
 * `/mcp<anything>`. Requiring a conservative literal charset makes the string mean the same thing
 * in all three.
 */
export function canonicalResourceId(base: URL, mcpPath: string, field: string): URL {
  if (!mcpPath.startsWith('/')) {
    throw new Error(
      `${field} must be an absolute path beginning with "/" (got "${mcpPath}"). It is resolved ` +
        `against the public base URL to form the advertised resource identifier.`,
    );
  }
  if (mcpPath === '/') {
    throw new Error(
      `${field} must name a path (got "${mcpPath}"). Parley serves its OAuth endpoints at the ` +
        `root of this origin, so the MCP endpoint cannot also live there.`,
    );
  }
  if (mcpPath.endsWith('/')) {
    throw new Error(
      `${field} must not end in "/" (got "${mcpPath}"). A trailing slash names a different ` +
        `resource than the bare path, and every token would carry that other audience.`,
    );
  }
  const resource = new URL(mcpPath, base);
  if (
    resource.origin !== base.origin ||
    resource.pathname !== mcpPath ||
    resource.search !== '' ||
    resource.hash !== ''
  ) {
    throw new Error(
      `${field} must be a plain path on the ${base.origin} origin (got "${mcpPath}", which ` +
        `resolves to "${resource.href}"). Anything else advertises a resource identifier this ` +
        `server does not serve, so every token is minted for an endpoint that answers 404.`,
    );
  }
  if (!LITERAL_PATH.test(mcpPath)) {
    throw new Error(
      `${field} must be a literal path of "/"-separated segments drawn from A-Z a-z 0-9 . _ ~ - ` +
        `(got "${mcpPath}"). Express reads this same string as a route pattern, where ":", "*", ` +
        `"(", ")" and "+" match paths other than the one advertised as the resource identifier.`,
    );
  }
  return resource;
}

/**
 * A URL the auth layer will fetch a trust root from — the issuer's discovery document, or the JWKS
 * every delegated-mode token is verified against. Over plaintext HTTP anyone on the path serves
 * their own keys and forges a token that satisfies every other check, so the transport invariant
 * belongs on each of them, not only on the issuer.
 */
export function assertTrustRootUrl(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${field} must be an absolute URL (got "${url}").`);
  }
  assertTransportScheme(parsed, field, url);
  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${field} must use https outside loopback (got "${url}"). Parley fetches token ` +
        `verification material from this URL, so anyone on the path can otherwise substitute ` +
        `their own keys and mint tokens this server accepts.`,
    );
  }
}

const UNBOUNDED_TRUST = new Set<unknown>([true, 'true']);

/** One address per IPv4 /8 and per IPv6 top nibble: a proxy list that trusts every one of these
 *  leaves no address it would refuse, whatever the CIDRs spelling it are. */
const ADDRESS_SPACE: Array<[string, string[]]> = [
  ['IPv4', Array.from({ length: 256 }, (_, i) => `${i}.128.0.1`)],
  ['IPv6', Array.from({ length: 16 }, (_, i) => `${i.toString(16)}000::1`)],
];

function unboundedTrust(field: string, value: unknown, because: string): Error {
  return new Error(
    `${field} must not be ${JSON.stringify(value)}. ${because}, so ` +
      `req.ip becomes a header the caller writes and every per-address rate limit on this front ` +
      `door is defeated by rotating it — an anonymous attacker gets unlimited guesses at the ` +
      `owner passphrase. Name the real topology instead: "loopback" for the reverse proxy in ` +
      `examples/self-host-remote, the number of proxy hops as a number, or the proxies' CIDR.`,
  );
}

/**
 * Keep this refusal, so that `req.ip` can never be a value the caller wrote: Express resolves it
 * from the `trust proxy` setting, and every rate limiter on a front door keys on it — including the
 * brute-force gate on the owner passphrase, the single secret that authorizes the whole bridge.
 *
 * The refusal is a property of what the value TRUSTS, not of how it is written: a proxy list whose
 * CIDRs cover a whole address family is `true` under another name. Express's own compiled predicate
 * answers that question, so a list naming real public proxies — a CDN's ranges, say — is unaffected.
 * A hop count is exempt: its predicate ignores the address entirely, and how many hops the real
 * chain has is not knowable here.
 */
export function assertTrustProxy(value: unknown, field: string): void {
  if (UNBOUNDED_TRUST.has(value)) {
    throw unboundedTrust(field, value, 'It trusts every hop of X-Forwarded-For');
  }
  if (typeof value !== 'string' && !Array.isArray(value)) return;
  const probe = express();
  probe.set('trust proxy', value);
  const trusted = probe.get('trust proxy fn') as (addr: string, hop: number) => boolean;
  const covered = ADDRESS_SPACE.filter(([, samples]) => samples.every((addr) => trusted(addr, 0)));
  if (covered.length === 0) return;
  throw unboundedTrust(
    field,
    value,
    `It trusts every ${covered.map(([family]) => family).join(' and ')} address there is`,
  );
}

const MAX_CLOCK_SKEW_S = 300;

function isNonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function namesSomebody(value: readonly string[] | string | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 && value.every(isNonBlank) : isNonBlank(value);
}

/**
 * Every rule the config schema puts on the `auth.oidc` block, restated where it is depended on.
 * Mirroring a rule only halfway is worse than not mirroring it: `allowed_subjects: []` satisfies
 * "a gate is present" and matches nothing, so the server boots healthy and then 401s every valid
 * token with nothing at boot naming the cause. Delegated OIDC has no owner-consent step, so a gate
 * that matches SOMEONE is the only thing standing between a shared realm and full bridge access for
 * every user in it — `required_scope` does not count, Claude's connector may request no scopes.
 */
export function assertOidcPolicy(oidc: OidcAuthConfig): void {
  const gates: Array<[string, readonly string[] | string | undefined]> = [
    ['allowed_subjects', oidc.allowed_subjects],
    ['allowed_usernames', oidc.allowed_usernames],
    ['required_role', oidc.required_role],
  ];
  const effective = gates.filter(([, value]) => namesSomebody(value));
  const blank = gates.filter(([, value]) => value !== undefined && !namesSomebody(value));
  if (blank.length > 0) {
    throw new Error(
      `auth.oidc ${blank.map(([name, v]) => `${name}=${JSON.stringify(v)}`).join(', ')} ` +
        'must name at least one non-blank value. A blank or empty gate is not an open gate — no ' +
        'token claim can equal it, so the server would boot healthy and then reject the callers ' +
        'the gate was written to admit. Remove the key or give it a value.',
    );
  }
  if (effective.length === 0) {
    throw new Error(
      'auth.mode "oidc" requires an identity gate: set at least one of allowed_subjects / ' +
        'allowed_usernames / required_role to preserve the single-tenant posture ' +
        '(required_scope alone is not sufficient). See docs/keycloak-integration.md.',
    );
  }
  if (oidc.audience !== undefined && !isNonBlank(oidc.audience)) {
    throw new Error(
      `auth.oidc.audience must not be blank (got ${JSON.stringify(oidc.audience)}). Every token ` +
        'is matched against it exactly, so a blank audience rejects all of them.',
    );
  }
  const skew = oidc.clock_skew_s;
  if (
    skew !== undefined &&
    (!Number.isInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_S)
  ) {
    throw new Error(
      `auth.oidc.clock_skew_s must be an integer between 0 and ${MAX_CLOCK_SKEW_S} seconds ` +
        `(got ${JSON.stringify(skew)}). A negative or non-finite tolerance is handed straight to ` +
        'the JWT verifier, and a large one keeps expired tokens alive.',
    );
  }
}
