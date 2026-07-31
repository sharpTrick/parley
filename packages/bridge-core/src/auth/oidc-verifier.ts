import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTHeaderParameters,
  type JWTPayload,
} from 'jose';
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
  /** Injectable clock for tests (ms epoch). */
  now?: () => number;
}

/**
 * Every asymmetric JWS algorithm, and only those. Keep HS* out, so that anyone who learns the
 * client secret an IdP shares with its clients cannot forge a token this server accepts.
 */
export const ACCEPTED_SIGNING_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

/**
 * `typ` values an IdP stamps on credentials that are not bearer access tokens (Keycloak: `ID`,
 * `Refresh`, `Logout`). An ID token is a client-side login receipt, so accepting one here would
 * let any client replay its own receipt as authorization for this resource. Keycloak puts this in
 * the CLAIMS, not the JOSE header (where it writes a generic `JWT`) — check both.
 */
const NON_ACCESS_TOKEN_TYPES = new Set(['id', 'refresh', 'logout', 'serialized-id']);

/**
 * `typ` values that positively identify a bearer access token: Keycloak's `Bearer` claim and
 * RFC 9068's media type. A token that declares one of these is not an ID token whatever else it
 * carries, so the claim-shape heuristic below must not overrule it.
 */
const ACCESS_TOKEN_TYPES = new Set(['bearer', 'at+jwt', 'application/at+jwt']);

/**
 * Claims OIDC Core defines only for an ID token: `nonce` is echoed from the authentication request,
 * and `at_hash`/`c_hash` are digests of the access token and code the ID token was issued beside.
 * They are how a `typ`-less IdP still gives an ID token away.
 */
const ID_TOKEN_ONLY_CLAIMS = ['nonce', 'at_hash', 'c_hash'];

const DEFAULT_CLOCK_SKEW_S = 30;

/**
 * Keep every 401 on this ONE string, so that a caller cannot tell which check refused it: the SDK
 * echoes it verbatim into `WWW-Authenticate: error_description` and the JSON body, and a distinct
 * message for the identity gate tells any realm user that their signature, `iss`, `aud` and `exp`
 * all passed and only the gate policy stopped them. Keep it ASCII, so that it survives the Latin1-
 * only WWW-Authenticate header.
 */
const REJECTION_MESSAGE = 'invalid or expired access token';

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
    const skewS = opts.clockSkewS ?? DEFAULT_CLOCK_SKEW_S;
    let payload: JWTPayload;
    let header: JWTHeaderParameters;
    try {
      // One call covers signature (kid-selected key, auto-refetch on unknown kid), iss, exp,
      // nbf (± clockTolerance), and aud-contains-audience.
      ({ payload, protectedHeader: header } = await jwtVerify(token, this.jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ACCEPTED_SIGNING_ALGORITHMS,
        clockTolerance: skewS,
        ...(opts.now !== undefined ? { currentDate: new Date(opts.now()) } : {}),
      }));
    } catch {
      throw new InvalidTokenError(REJECTION_MESSAGE);
    }

    if (!isAccessToken(header, payload)) {
      throw new InvalidTokenError(REJECTION_MESSAGE);
    }

    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    if (opts.requiredScope !== undefined && !scopes.includes(opts.requiredScope)) {
      throw new InsufficientScopeError(`token is missing the required scope`);
    }

    if (!this.passesIdentityGates(payload)) {
      throw new InvalidTokenError(REJECTION_MESSAGE);
    }

    const clientId =
      (typeof payload.azp === 'string' && payload.azp) ||
      (typeof payload.client_id === 'string' && payload.client_id) ||
      'oidc-client';

    return {
      token,
      clientId,
      scopes,
      // Report the expiry INCLUDING the tolerance, so that requireBearerAuth — which re-checks this
      // field against wall-clock with no tolerance of its own — cannot 401 a token this verifier
      // just accepted, silently undoing the configured skew.
      ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp + skewS } : {}),
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

function isAccessToken(header: JWTHeaderParameters, payload: JWTPayload): boolean {
  const declared = [header.typ, payload.typ]
    .filter((typ): typ is string => typeof typ === 'string')
    .map((typ) => typ.toLowerCase());
  if (declared.some((typ) => NON_ACCESS_TOKEN_TYPES.has(typ))) return false;
  if (declared.some((typ) => ACCESS_TOKEN_TYPES.has(typ))) return true;
  return ID_TOKEN_ONLY_CLAIMS.every((claim) => payload[claim] === undefined);
}

function asUrl(s: string): URL | undefined {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}
