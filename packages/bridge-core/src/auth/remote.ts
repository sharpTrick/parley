import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import type { ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { createRemoteHttpApp, type RemoteHttpServer } from '../transport/http.js';
import { renderConsentRefusal } from './consent-page.js';
import { DEFAULT_SCOPES_SUPPORTED } from './grant-params.js';
import { ConsentError, ParleyOAuthProvider } from './oauth-provider.js';
import { hardenErrorSurface } from './error-surface.js';
import { assertPublicBaseUrl, assertTrustProxy, canonicalResourceId } from './invariants.js';

export interface OAuthRemoteOptions {
  /** Public origin = issuer = base URL (AS = RS, single tenant). HTTPS in production; localhost ok in dev. */
  issuerUrl: URL;
  /** Verify the owner's consent secret (timing-safe, off the event loop). See ./owner.ts. */
  verifyOwner: (passphrase: string) => Promise<boolean>;
  /** MCP endpoint path. Default `/mcp`. The canonical resource id is `issuerUrl + mcpPath` (no trailing slash). */
  mcpPath?: string;
  scopesSupported?: string[];
  /**
   * Express `trust proxy` value, describing the real deployment: the default `false` is correct
   * only when the socket peer IS the client, and behind the TLS terminator of
   * examples/self-host-remote it is `'loopback'` (or the hop count). Every endpoint below is
   * rate-limited on the `req.ip` this decides, so anything that trusts the whole address space is
   * refused at boot with a message naming the value and the exposure.
   */
  trustProxy?: boolean | number | string | string[];
  /** Injectable clock for tests. */
  now?: () => number;
}

const CONSENT_PATH = '/parley/consent';

/**
 * The built-in OAuth front door. Its `close()` is TERMINAL, unlike the idempotent and re-listenable
 * one on {@link RemoteHttpServer} it extends: it drops every issued credential and shuts down the
 * provider's sweeper and the rate limiters' stores, none of which are re-armed. A later `listen()`
 * is refused rather than serving a complete authorization server whose background eviction is dead.
 */
export interface OAuthRemoteServer extends RemoteHttpServer {
  provider: ParleyOAuthProvider;
  /** The canonical RFC 8707 resource identifier (token audience). */
  resource: URL;
}

/**
 * Compose the full remote/chat front door (DESIGN §10): the SDK's OAuth 2.1 + PKCE authorization
 * server (mcpAuthRouter — DCR, /authorize, /token, /revoke, AS metadata + Protected Resource
 * Metadata), an owner-consent submit endpoint, and a bearer-protected stateless Streamable-HTTP
 * MCP endpoint. AS = RS on one origin. The seam, tools, and backend are identical to stdio mode —
 * only this transport/auth layer differs.
 */
export function createOAuthRemoteApp(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  oauth: OAuthRemoteOptions,
): OAuthRemoteServer {
  const mcpPath = oauth.mcpPath ?? '/mcp';
  assertPublicBaseUrl(oauth.issuerUrl, 'issuerUrl');
  assertTrustProxy(oauth.trustProxy, 'trustProxy');
  const resource = canonicalResourceId(oauth.issuerUrl, mcpPath, 'mcpPath');
  const scopesSupported = oauth.scopesSupported ?? DEFAULT_SCOPES_SUPPORTED;

  const provider = new ParleyOAuthProvider({
    resource,
    verifyOwner: oauth.verifyOwner,
    consentPath: CONSENT_PATH,
    scopesSupported,
    ...(oauth.now !== undefined ? { now: oauth.now } : {}),
  });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  // Every limiter gets a store this app owns, so that its counters stay scoped to this server
  // rather than shared process-wide, and so that close() can stop their sweep timers.
  const stores: MemoryStore[] = [];
  const ownedStore = (): MemoryStore => {
    const store = new MemoryStore();
    stores.push(store);
    return store;
  };

  const consentLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    store: ownedStore(),
  });

  const remote = createRemoteHttpApp(plugin, cfg, {
    mcpPath,
    protect: bearer,
    configureApp: (app) => {
      app.set('trust proxy', oauth.trustProxy ?? false);

      // (Do NOT add json/urlencoded parsers in front — these handlers install their own.)
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl: oauth.issuerUrl,
          baseUrl: oauth.issuerUrl,
          resourceServerUrl: resource,
          scopesSupported,
          resourceName: 'Parley',
          authorizationOptions: { rateLimit: { store: ownedStore() } },
          clientRegistrationOptions: { rateLimit: { store: ownedStore() } },
          revocationOptions: { rateLimit: { store: ownedStore() } },
          tokenOptions: { rateLimit: { store: ownedStore() } },
        }),
      );

      app.post(CONSENT_PATH, consentLimiter, express.urlencoded({ extended: false }), async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const body = (req.body ?? {}) as Record<string, unknown>;
        const consentId = String(body.consent_id ?? '');
        const passphrase = String(body.passphrase ?? '');
        try {
          const { redirectUrl } = await provider.completeConsent(consentId, passphrase);
          res.redirect(302, redirectUrl);
        } catch (err) {
          if (err instanceof ConsentError) {
            res.status(403).type('html').send(renderConsentRefusal(err.message));
            return;
          }
          throw err;
        }
      });
    },
  });

  hardenErrorSurface(remote.app);

  const closeHttp = remote.close.bind(remote);
  const listenHttp = remote.listen.bind(remote);
  let closed = false;
  return Object.assign(remote, {
    provider,
    resource,
    listen: async (port: number, host?: string) => {
      if (closed) {
        throw new Error('this remote auth app has been closed and cannot listen again');
      }
      return listenHttp(port, host);
    },
    close: async (): Promise<void> => {
      closed = true;
      provider.stop();
      for (const store of stores) store.shutdown();
      await closeHttp();
    },
  });
}
