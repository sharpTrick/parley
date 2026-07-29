import type { OidcAuthConfig } from '../config.js';

/**
 * Boot-time invariants for the remote front doors. The config schema checks these too, but the
 * factories are public exports that can be called with a hand-built config object, so the check
 * that actually protects the deployment lives here.
 */

/**
 * The AS/RS endpoints are mounted at the origin root, so a base URL carrying a path would advertise
 * a resource identifier and metadata URLs that nothing is served at. Refuse it instead of booting
 * healthy and then 401-ing every token this server issues.
 */
export function assertRootPath(url: URL, field: string): void {
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `${field} must be an origin with no path (got "${url.href}"). Parley mounts its OAuth and ` +
        `MCP endpoints at the root of this origin, so a base path would be silently dropped from ` +
        `the advertised resource identifier.`,
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
