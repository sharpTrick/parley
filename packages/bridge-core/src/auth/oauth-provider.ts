import { randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const ACCESS_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 60_000; // 1 minute, single-use
const CONSENT_TTL_MS = 5 * 60_000; // 5 minutes to approve

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAtMs: number;
}
interface AccessRecord extends AuthInfo {
  expiresAt: number; // seconds since epoch (required by requireBearerAuth)
}
interface RefreshRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAtMs: number;
}
interface PendingConsent {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAtMs: number;
}

export interface ParleyOAuthProviderOptions {
  /** Canonical resource (RS) identifier = the public /mcp URL (no trailing slash). Audience for tokens. */
  resource: URL;
  /** Verify the owner's consent secret (timing-safe). Single-tenant gate (DESIGN §10/§14). */
  verifyOwner: (passphrase: string) => boolean;
  /** Path the consent form POSTs to (mounted by the remote app). */
  consentPath: string;
  /** Clock injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Single-tenant OAuth 2.1 + PKCE provider (DESIGN §10/§14). It is the authorization server for
 * exactly one owner: any client may dynamically register (DCR — Claude uses this), but issuing a
 * token requires the OWNER to consent with their secret. The SDK's handlers do PKCE S256
 * verification, DCR, and metadata; this provider supplies the issuing/verifying logic, gates
 * `authorize()` on owner consent, and binds tokens to the `/mcp` resource (RFC 8707 audience).
 */
export class ParleyOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly access = new Map<string, AccessRecord>();
  private readonly refresh = new Map<string, RefreshRecord>();
  private readonly pending = new Map<string, PendingConsent>();
  private readonly now: () => number;

  constructor(private readonly opts: ParleyOAuthProviderOptions) {
    this.now = opts.now ?? Date.now;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      // DCR: the SDK has already set client_id on the object before calling this.
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  /**
   * Owner-consent gate. Instead of redirecting straight back, render a consent page; the owner
   * approves with their secret, and {@link completeConsent} issues the code + redirect.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const consentId = randomUUID();
    this.pending.set(consentId, { client, params, expiresAtMs: this.now() + CONSENT_TTL_MS });
    res.status(200).type('html').send(this.consentPage(consentId, client, params));
  }

  /**
   * Complete an owner-approved consent: validate the secret, mint a single-use auth code bound to
   * the client/redirect/PKCE-challenge, and return the redirect URL (code + state).
   * @throws on bad secret, unknown/expired consent.
   */
  completeConsent(consentId: string, passphrase: string): { redirectUrl: string } {
    const pend = this.pending.get(consentId);
    if (pend === undefined || pend.expiresAtMs < this.now()) {
      this.pending.delete(consentId);
      throw new ConsentError('consent request expired or unknown');
    }
    if (!this.opts.verifyOwner(passphrase)) {
      throw new ConsentError('incorrect owner passphrase');
    }
    this.pending.delete(consentId);

    const code = randomUUID();
    this.codes.set(code, {
      clientId: pend.client.client_id,
      redirectUri: pend.params.redirectUri,
      codeChallenge: pend.params.codeChallenge, // stored; SDK verifies S256 at /token
      scopes: pend.params.scopes ?? [],
      resource: pend.params.resource?.href ?? this.opts.resource.href,
      expiresAtMs: this.now() + CODE_TTL_MS,
    });

    const url = new URL(pend.params.redirectUri);
    url.searchParams.set('code', code);
    if (pend.params.state !== undefined) url.searchParams.set('state', pend.params.state);
    return { redirectUrl: url.href };
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (rec === undefined || rec.clientId !== client.client_id || rec.expiresAtMs < this.now()) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // SDK already verified PKCE S256 before calling us
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    if (rec === undefined || rec.clientId !== client.client_id || rec.expiresAtMs < this.now()) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    this.codes.delete(authorizationCode); // single-use
    return this.issue(client.client_id, rec.scopes, resource?.href ?? rec.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.refresh.get(refreshToken);
    if (rec === undefined || rec.clientId !== client.client_id || rec.expiresAtMs < this.now()) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    this.refresh.delete(refreshToken); // rotate: invalidate the used refresh token
    return this.issue(client.client_id, scopes ?? rec.scopes, resource?.href ?? rec.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.access.get(token);
    if (rec === undefined || rec.expiresAt < this.now() / 1000) {
      throw new InvalidTokenError('access token is invalid or expired');
    }
    // RFC 8707 audience binding: the token must have been minted for THIS resource.
    if (rec.resource !== undefined && rec.resource.href !== this.opts.resource.href) {
      throw new InvalidTokenError('access token is invalid or expired');
    }
    return rec;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.access.delete(request.token);
    this.refresh.delete(request.token);
  }

  private issue(clientId: string, scopes: string[], resource: string): OAuthTokens {
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const resourceUrl = new URL(resource);
    this.access.set(accessToken, {
      token: accessToken,
      clientId,
      scopes,
      expiresAt: Math.floor(this.now() / 1000) + ACCESS_TTL_SEC,
      resource: resourceUrl,
    });
    this.refresh.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAtMs: this.now() + REFRESH_TTL_SEC * 1000,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  private consentPage(
    consentId: string,
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
  ): string {
    const name = escapeHtml(client.client_name ?? client.client_id);
    const scopeList = (params.scopes ?? []).map(escapeHtml).join(', ') || '(none requested)';
    const redirect = escapeHtml(new URL(params.redirectUri).origin);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parley — authorize</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:1.5rem}label{display:block;margin:1rem 0 .25rem}
input[type=password]{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;font-size:1rem}
button{margin-top:1.25rem;padding:.6rem 1.25rem;border:0;border-radius:8px;background:#111;color:#fff;font-size:1rem;cursor:pointer}
.muted{color:#666;font-size:.9rem}</style></head>
<body><div class="box"><h1>Authorize access to Parley</h1>
<p><strong>${name}</strong> wants to connect to your Parley bridge.</p>
<p class="muted">Redirect: ${redirect}<br>Scopes: ${scopeList}</p>
<p>Enter your owner passphrase to approve. This is the only party that can authorize this bridge.</p>
<form method="POST" action="${escapeHtml(this.opts.consentPath)}">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<label for="passphrase">Owner passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus required>
<button type="submit">Approve</button></form></div></body></html>`;
  }
}

/** Raised by completeConsent on owner-secret failure or unknown/expired consent. */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
