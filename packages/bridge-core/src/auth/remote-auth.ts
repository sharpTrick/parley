import type { ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { createOidcRemoteApp, type OidcRemoteServer } from './oidc-remote.js';
import { createOAuthRemoteApp, type OAuthRemoteServer } from './remote.js';

export interface RemoteAuthOptions {
  /** Public base URL of this server. builtin mode: issuer = AS = RS. oidc mode: RS only
   *  (the issuer is the external IdP from cfg.auth.oidc). */
  publicUrl: URL;
  /** Owner-consent verifier (async: scrypt runs off the event loop) — required iff cfg.auth.mode === 'builtin'. */
  verifyOwner?: (passphrase: string) => Promise<boolean>;
  /** MCP endpoint path. Default `/mcp`. */
  mcpPath?: string;
  /** builtin mode only. */
  scopesSupported?: string[];
  /** Injectable clock for tests. */
  now?: () => number;
  /** oidc mode only: injectable fetch for the boot-time discovery request. */
  fetchFn?: typeof fetch;
}

export type RemoteAuthServer = OAuthRemoteServer | OidcRemoteServer;

/**
 * The remote-mode front-door selector (DESIGN §10): dispatch on `cfg.auth.mode` between the
 * built-in single-tenant OAuth AS (default; owner-passphrase consent) and the delegated
 * resource-server mode where an external OIDC IdP (e.g. Keycloak) authorizes the connector.
 */
export async function createRemoteAuthApp(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  opts: RemoteAuthOptions,
): Promise<RemoteAuthServer> {
  if (cfg.auth.mode === 'oidc') {
    // ConfigSchema guarantees the block exists when mode === 'oidc'.
    const oidc = cfg.auth.oidc;
    if (oidc === undefined) throw new Error('auth.mode "oidc" requires an auth.oidc block');
    return createOidcRemoteApp(plugin, cfg, {
      publicUrl: opts.publicUrl,
      oidc,
      ...(opts.mcpPath !== undefined ? { mcpPath: opts.mcpPath } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    });
  }

  if (opts.verifyOwner === undefined) {
    throw new Error(
      'auth.mode "builtin" requires an owner secret (verifyOwner) — set it locally, never over the network',
    );
  }
  return createOAuthRemoteApp(plugin, cfg, {
    issuerUrl: opts.publicUrl,
    verifyOwner: opts.verifyOwner,
    ...(opts.mcpPath !== undefined ? { mcpPath: opts.mcpPath } : {}),
    ...(opts.scopesSupported !== undefined ? { scopesSupported: opts.scopesSupported } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
