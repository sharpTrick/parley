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
  /** builtin mode only: Express `trust proxy` value for the rate limiters. See OAuthRemoteOptions. */
  trustProxy?: boolean | number | string | string[];
  /** Injectable clock for tests. */
  now?: () => number;
  /** oidc mode only: injectable fetch for the boot-time discovery request. */
  fetchFn?: typeof fetch;
}

export type RemoteAuthServer = OAuthRemoteServer | OidcRemoteServer;

export type OptionScope = 'builtin' | 'oidc' | 'shared';

/**
 * Which mode each option reaches. An option the selected mode never forwards is a silent no-op, and
 * `trustProxy` is the one standing between an anonymous flood and the owner's only way in — so a
 * caller who sets it in the wrong mode has to hear about it at boot, not from a rate limiter that
 * was never keyed the way they asked.
 *
 * Keep the `Record<keyof RemoteAuthOptions, …>` annotation, so that an option added to the interface
 * cannot ship unclassified: the compiler demands a scope for it here, which is what lets the suite
 * grade this table INSTEAD of the interface — the two can no longer disagree.
 */
export const OPTION_SCOPES: Record<keyof RemoteAuthOptions, OptionScope> = {
  publicUrl: 'shared',
  mcpPath: 'shared',
  now: 'shared',
  verifyOwner: 'builtin',
  scopesSupported: 'builtin',
  trustProxy: 'builtin',
  fetchFn: 'oidc',
};

const scopedOptions = (): Array<[keyof RemoteAuthOptions, OptionScope]> =>
  Object.entries(OPTION_SCOPES) as Array<[keyof RemoteAuthOptions, OptionScope]>;

function assertOptionsMatchMode(mode: 'builtin' | 'oidc', opts: RemoteAuthOptions): void {
  const stray = scopedOptions().filter(
    ([key, only]) => only !== 'shared' && only !== mode && opts[key] !== undefined,
  );
  if (stray.length === 0) return;
  throw new Error(
    `auth.mode "${mode}" does not use ${stray.map(([key]) => key).join(', ')} — ` +
      `${stray.length === 1 ? 'it is' : 'they are'} ` +
      `${stray.map(([, only]) => `"${only}"`).join('/')}-mode only, and would be silently ` +
      'discarded. Remove it, or switch modes.',
  );
}

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
  assertOptionsMatchMode(cfg.auth.mode, opts);
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
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
