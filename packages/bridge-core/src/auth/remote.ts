import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { createRemoteHttpApp, type RemoteHttpServer } from '../transport/http.js';
import { escapeHtml } from './html.js';
import { ConsentError, ParleyOAuthProvider } from './oauth-provider.js';

export interface OAuthRemoteOptions {
  /** Public origin = issuer = base URL (AS = RS, single tenant). HTTPS in production; localhost ok in dev. */
  issuerUrl: URL;
  /** Verify the owner's consent secret (timing-safe, off the event loop). See ./owner.ts. */
  verifyOwner: (passphrase: string) => Promise<boolean>;
  /** MCP endpoint path. Default `/mcp`. The canonical resource id is `issuerUrl + mcpPath` (no trailing slash). */
  mcpPath?: string;
  scopesSupported?: string[];
  /** Injectable clock for tests. */
  now?: () => number;
}

const CONSENT_PATH = '/parley/consent';

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
  const resource = new URL(mcpPath, oauth.issuerUrl); // canonical resource id (no trailing slash)

  const provider = new ParleyOAuthProvider({
    resource,
    verifyOwner: oauth.verifyOwner,
    consentPath: CONSENT_PATH,
    ...(oauth.now !== undefined ? { now: oauth.now } : {}),
  });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  // Strict rate limit on the hand-mounted consent route, mirroring how the SDK guards its own auth
  // endpoints (/register|/authorize|/token). A legit owner needs one attempt; brute force needs
  // thousands, so keep the ceiling low and return 429 on exceed. Per-app instance (its own store)
  // so the counter is scoped to this server, not shared process-wide.
  //
  // Trust-proxy note: the limiter keys on req.ip. Behind the documented reverse proxy (Caddy) all
  // requests would otherwise share the proxy's IP, so per-IP throttling is defense-in-depth here —
  // the load-bearing brute-force defense is the one-shot consent invalidation in completeConsent
  // (each guess costs a fresh /authorize). We deliberately do NOT reconfigure the global `trust
  // proxy` setting from this route (an app-wide change with its own security implications).
  const consentLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const remote = createRemoteHttpApp(plugin, cfg, {
    mcpPath,
    protect: bearer,
    configureApp: (app) => {
      // OAuth AS endpoints + AS metadata + Protected Resource Metadata, mounted at the root.
      // (Do NOT add json/urlencoded parsers in front — these handlers install their own.)
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl: oauth.issuerUrl,
          baseUrl: oauth.issuerUrl,
          resourceServerUrl: resource,
          scopesSupported: oauth.scopesSupported ?? ['mcp'],
          resourceName: 'Parley',
        }),
      );

      // Owner-consent submit (browser-driven). The /authorize handler renders a consent page that
      // POSTs here; on the correct owner passphrase we mint the code and redirect back to Claude.
      app.post(CONSENT_PATH, consentLimiter, express.urlencoded({ extended: false }), async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const consentId = String(body.consent_id ?? '');
        const passphrase = String(body.passphrase ?? '');
        try {
          const { redirectUrl } = await provider.completeConsent(consentId, passphrase);
          res.redirect(302, redirectUrl);
        } catch (err) {
          if (err instanceof ConsentError) {
            res.status(403).type('html').send(
              `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:32rem;margin:3rem auto">` +
                `<h1>Not authorized</h1><p>${escapeHtml(err.message)}.</p><p><a href="javascript:history.back()">Go back</a></p></body>`,
            );
            return;
          }
          throw err;
        }
      });
    },
  });

  return Object.assign(remote, { provider, resource });
}
