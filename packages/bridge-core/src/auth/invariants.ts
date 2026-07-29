import type { OidcAuthConfig } from '../config.js';

/**
 * Boot-time invariants for the remote front doors. The config schema checks these too, but the
 * factories are public exports that can be called with a hand-built config object, so the check
 * that actually protects the deployment lives here.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The advertised RFC 9728 resource identifier is `publicUrl + mcpPath`, and building it drops every
 * component of the base URL except scheme, host and port. Any component that would be dropped is
 * therefore a server that boots healthy and then 401s every token, or — for userinfo — an owner
 * credential republished in the public metadata document and in every WWW-Authenticate challenge.
 * Refuse each of them by name so the operator learns which one.
 */
export function assertPublicBaseUrl(url: URL, field: string): void {
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
      `${field} must use https outside loopback (got "${url.href}"). The bearer tokens and the ` +
        `owner passphrase this origin carries have no confidentiality without TLS.`,
    );
  }
}

/**
 * The other operand of the resource identifier. `new URL(mcpPath, base)` will happily accept an
 * authority (`//host`, `/\host`), a scheme, or a query/fragment and hand back something that is not
 * a path on this origin at all: the advertised resource, the audience every token is minted with,
 * and the route the app actually serves then disagree, which is a permanent 404 behind a consent
 * the owner already gave. A trailing slash names a different resource than the bare path.
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
  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${field} must use https outside loopback (got "${url}"). Parley fetches token ` +
        `verification material from this URL, so anyone on the path can otherwise substitute ` +
        `their own keys and mint tokens this server accepts.`,
    );
  }
}

/**
 * Delegated OIDC has no owner-consent step, so an identity gate is the only thing standing between
 * a shared realm and full bridge access for every user in it. `required_scope` does not count —
 * Claude's connector may request no scopes at all.
 */
export function assertIdentityGate(oidc: OidcAuthConfig): void {
  if (
    oidc.allowed_subjects === undefined &&
    oidc.allowed_usernames === undefined &&
    oidc.required_role === undefined
  ) {
    throw new Error(
      'auth.mode "oidc" requires an identity gate: set at least one of allowed_subjects / ' +
        'allowed_usernames / required_role to preserve the single-tenant posture ' +
        '(required_scope alone is not sufficient). See docs/keycloak-integration.md.',
    );
  }
}
