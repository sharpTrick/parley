import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import type { ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { createRemoteHttpApp, type RemoteHttpServer } from '../transport/http.js';
import { ConsentError, ParleyOAuthProvider } from './oauth-provider.js';

export interface OAuthRemoteOptions {
  /** Public origin = issuer = base URL (AS = RS, single tenant). HTTPS in production; localhost ok in dev. */
  issuerUrl: URL;
  /** Verify the owner's consent secret (timing-safe). See ./owner.ts. */
  verifyOwner: (passphrase: string) => boolean;
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
      app.post(CONSENT_PATH, express.urlencoded({ extended: false }), (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const consentId = String(body.consent_id ?? '');
        const passphrase = String(body.passphrase ?? '');
        try {
          const { redirectUrl } = provider.completeConsent(consentId, passphrase);
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
