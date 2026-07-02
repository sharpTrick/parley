import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  InsufficientScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export interface OidcVerifierOptions {
  /** Expected `iss` claim — the external IdP's issuer URL (e.g. a Keycloak realm). */
  issuer: string;
  /** Expected `aud` value; matched exactly against the claim (string or array member). */
  audience: string;
  /** JWKS endpoint of the issuer (from discovery, or the config override). */
  jwksUri: string;
  /** If set, the token's space-separated `scope` must include this value. */
  requiredScope?: string;
  /** Identity gates (single-tenant posture) — any that are set must ALL pass. */
  allowedSubjects?: readonly string[];
  /** Matched against `preferred_username`. */
  allowedUsernames?: readonly string[];
  /** Required realm role (Keycloak `realm_access.roles`). */
  requiredRole?: string;
  /** exp/nbf tolerance in seconds. Default 30. */
  clockSkewS?: number;
  /** Accepted signing algorithms. Asymmetric only — never allow HS* on a public IdP. */
  algorithms?: string[];
  /** Injectable clock for tests (ms epoch). */
  now?: () => number;
}

/** Keycloak-style realm-roles claim. */
interface RealmAccessClaim {
  roles?: unknown;
}

/**
 * Resource-server token verification against an external OIDC IdP (DESIGN §10, delegated
 * variant): JWKS signature, `iss`, `exp`/`nbf` ± skew, and `aud` are always enforced; scope and
 * identity gates apply on top when configured. Plugs into the SDK's `requireBearerAuth`, so it
 * must only ever throw the SDK's OAuth error classes: `InvalidTokenError` → 401 (+ discovery
 * challenge), `InsufficientScopeError` → 403. Identity-gate failures are deliberately 401, not
 * 403, so the gate policy itself is not leaked to unauthorized callers.
 */
export class OidcTokenVerifier implements OAuthTokenVerifier {
  private readonly opts: OidcVerifierOptions;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(opts: OidcVerifierOptions) {
    this.opts = opts;
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUri));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { opts } = this;
    let payload: JWTPayload;
    try {
      // One call covers signature (kid-selected key, auto-refetch on unknown kid), iss, exp,
      // nbf (± clockTolerance), and aud-contains-audience.
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: opts.algorithms ?? ['RS256', 'PS256', 'ES256'],
        clockTolerance: opts.clockSkewS ?? 30,
        ...(opts.now !== undefined ? { currentDate: new Date(opts.now()) } : {}),
      }));
    } catch {
      // Never leak which check failed (sig vs iss vs exp vs aud).
      throw new InvalidTokenError('invalid or expired access token');
    }

    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    if (opts.requiredScope !== undefined && !scopes.includes(opts.requiredScope)) {
      throw new InsufficientScopeError(`token is missing the required scope`);
    }

    if (!this.passesIdentityGates(payload)) {
      throw new InvalidTokenError('token does not satisfy this server’s access policy');
    }

    const clientId =
      (typeof payload.azp === 'string' && payload.azp) ||
      (typeof payload.client_id === 'string' && payload.client_id) ||
      'oidc-client';

    return {
      token,
      clientId,
      scopes,
      ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
      // AuthInfo.resource must be a URL; with a fixed-string Keycloak audience (e.g.
      // "parley-mcp") there is no URL to report, so it is set only when the audience parses.
      ...(asUrl(opts.audience) !== undefined ? { resource: asUrl(opts.audience) } : {}),
      extra: {
        ...(typeof payload.sub === 'string' ? { sub: payload.sub } : {}),
        ...(typeof payload.preferred_username === 'string'
          ? { preferred_username: payload.preferred_username }
          : {}),
        ...(typeof payload.iss === 'string' ? { iss: payload.iss } : {}),
      },
    };
  }

  private passesIdentityGates(payload: JWTPayload): boolean {
    const { allowedSubjects, allowedUsernames, requiredRole } = this.opts;
    if (allowedSubjects !== undefined) {
      if (typeof payload.sub !== 'string' || !allowedSubjects.includes(payload.sub)) return false;
    }
    if (allowedUsernames !== undefined) {
      const username = payload.preferred_username;
      if (typeof username !== 'string' || !allowedUsernames.includes(username)) return false;
    }
    if (requiredRole !== undefined) {
      const realmAccess = payload.realm_access as RealmAccessClaim | undefined;
      const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles : [];
      if (!roles.includes(requiredRole)) return false;
    }
    return true;
  }
}

function asUrl(s: string): URL | undefined {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}
