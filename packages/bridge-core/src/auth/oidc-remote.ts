import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OidcAuthConfig, ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { createRemoteHttpApp, type RemoteHttpServer } from '../transport/http.js';
import { fetchOidcDiscovery } from './oidc-discovery.js';
import { OidcTokenVerifier } from './oidc-verifier.js';

export interface OidcRemoteOptions {
  /** Public base URL of THIS resource server (what Claude reaches) — NOT the OAuth issuer;
   *  the issuer is the external IdP. Canonical resource id = publicUrl + mcpPath. */
  publicUrl: URL;
  oidc: OidcAuthConfig;
  /** MCP endpoint path. Default `/mcp`. */
  mcpPath?: string;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable fetch for the boot-time discovery request. */
  fetchFn?: typeof fetch;
}

export interface OidcRemoteServer extends RemoteHttpServer {
  verifier: OidcTokenVerifier;
  /** The canonical RFC 8707 resource identifier. */
  resource: URL;
  /** The external issuer this server delegates authorization to. */
  authorizationServer: URL;
}

/**
 * Compose the remote/chat front door in delegated-resource-server form (DESIGN §10, external-IdP
 * variant; RFC 9728): Parley hosts NO /authorize, /token, /register — Protected Resource Metadata
 * points Claude at the external OIDC issuer (e.g. a Keycloak realm), the IdP's AS metadata is
 * mirrored for pre-RFC-9728 clients that probe this origin, and the bearer middleware validates
 * IdP-issued JWTs locally via OidcTokenVerifier. Seam, tools, and backend are identical to the
 * built-in-OAuth and stdio modes — only who hosts the authorization server differs.
 *
 * Async because it fetches the IdP's discovery document once at boot (issuer sanity check +
 * JWKS location); the IdP must therefore be reachable at startup.
 */
export async function createOidcRemoteApp(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  opts: OidcRemoteOptions,
): Promise<OidcRemoteServer> {
  const mcpPath = opts.mcpPath ?? '/mcp';
  const resource = new URL(mcpPath, opts.publicUrl); // canonical resource id (no trailing slash)
  const oidc = opts.oidc;

  const metadata = await fetchOidcDiscovery(oidc.issuer, opts.fetchFn ?? fetch);
  const jwksUri = oidc.jwks_uri ?? metadata.jwks_uri;
  if (oidc.jwks_uri === undefined) {
    // Defense-in-depth: a discovery-supplied JWKS must share the issuer's origin. An explicit
    // `auth.oidc.jwks_uri` config override is the trusted pin (e.g. a CDN-hosted JWKS).
    const jwksOrigin = new URL(jwksUri).origin;
    const issuerOrigin = new URL(metadata.issuer).origin;
    if (jwksOrigin !== issuerOrigin) {
      throw new Error(
        `OIDC discovery: jwks_uri origin ${jwksOrigin} does not match issuer origin ` +
          `${issuerOrigin}. Pin it explicitly via auth.oidc.jwks_uri if this is intentional ` +
          `(e.g. a CDN-hosted JWKS).`,
      );
    }
  }
  // Keycloak ignores RFC 8707 `resource`, so deployments typically pin a fixed-string audience
  // via a mapper; default to the canonical resource id for IdPs that do bind audiences to it.
  const audience = oidc.audience ?? resource.href;

  const verifier = new OidcTokenVerifier({
    // Use the discovery document's canonical issuer (already validated to equal oidc.issuer
    // modulo a trailing slash) — it is exactly what the IdP stamps in `iss`, so jose's exact
    // match lines up in both slash directions (BUG-24).
    issuer: metadata.issuer,
    audience,
    jwksUri,
    clockSkewS: oidc.clock_skew_s,
    ...(oidc.required_scope !== undefined ? { requiredScope: oidc.required_scope } : {}),
    ...(oidc.allowed_subjects !== undefined ? { allowedSubjects: oidc.allowed_subjects } : {}),
    ...(oidc.allowed_usernames !== undefined ? { allowedUsernames: oidc.allowed_usernames } : {}),
    ...(oidc.required_role !== undefined ? { requiredRole: oidc.required_role } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });

  const remote = createRemoteHttpApp(plugin, cfg, {
    mcpPath,
    protect: bearer,
    configureApp: (app) => {
      // Protected Resource Metadata (authorization_servers → the external issuer) + a mirror of
      // the IdP's AS metadata at this origin. No AS endpoints are mounted here.
      app.use(
        mcpAuthMetadataRouter({
          // OIDC discovery metadata is a superset of the RFC 8414 shape the router mirrors.
          oauthMetadata: OAuthMetadataSchema.parse(metadata),
          resourceServerUrl: resource,
          resourceName: 'Parley',
          ...(oidc.required_scope !== undefined ? { scopesSupported: [oidc.required_scope] } : {}),
        }),
      );
    },
  });

  return Object.assign(remote, {
    verifier,
    resource,
    authorizationServer: new URL(oidc.issuer),
  });
}
