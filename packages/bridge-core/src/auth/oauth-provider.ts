import { randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { escapeHtml } from './html.js';

const ACCESS_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 60_000; // 1 minute, single-use
const CONSENT_TTL_MS = 5 * 60_000; // 5 minutes to approve
const SWEEP_INTERVAL_MS = 60_000; // periodic GC of expired OAuth state so maps can't grow unbounded (SEC-02)
const MAX_CLIENTS = 100; // cap DCR clients — a single-tenant bridge only ever needs a handful (SEC-02)

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
  accessToken: string; // back-link to the access token issued alongside; freed on rotation (SEC-02)
}
interface PendingConsent {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAtMs: number;
}

export interface ParleyOAuthProviderOptions {
  /** Canonical resource (RS) identifier = the public /mcp URL (no trailing slash). Audience for tokens. */
  resource: URL;
  /** Verify the owner's consent secret (timing-safe, off the event loop). Single-tenant gate (DESIGN §10/§14). */
  verifyOwner: (passphrase: string) => Promise<boolean>;
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
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: ParleyOAuthProviderOptions) {
    this.now = opts.now ?? Date.now;
    // Periodic GC (SEC-02): abandoned/expired code/pending/access/refresh entries would otherwise
    // accumulate for the whole process lifetime. .unref() so the timer never keeps the event loop
    // alive; stop() clears it for graceful shutdown and tests.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Evict every expired code/refresh/pending/access record. Uses the injectable clock (test-friendly). */
  private sweep(): void {
    const nowMs = this.now();
    const nowSec = nowMs / 1000;
    for (const [k, r] of this.codes) if (r.expiresAtMs < nowMs) this.codes.delete(k);
    for (const [k, r] of this.refresh) if (r.expiresAtMs < nowMs) this.refresh.delete(k);
    for (const [k, r] of this.pending) if (r.expiresAtMs < nowMs) this.pending.delete(k);
    for (const [k, r] of this.access) if (r.expiresAt < nowSec) this.access.delete(k);
  }

  /** Stop the background sweeper (graceful shutdown / tests) so no timer is left dangling. */
  stop(): void {
    clearInterval(this.sweepTimer);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      // DCR: the SDK has already set client_id on the object before calling this.
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        // Bound the DCR client map (SEC-02): DCR is reachable pre-owner-auth, and clients were
        // never freed. A single-tenant bridge only ever has a handful of live clients, so once we
        // hit MAX_CLIENTS evict the oldest registration (Map insertion order = FIFO).
        if (!this.clients.has(full.client_id) && this.clients.size >= MAX_CLIENTS) {
          const oldest = this.clients.keys().next().value;
          if (oldest !== undefined) this.clients.delete(oldest);
        }
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
  async completeConsent(consentId: string, passphrase: string): Promise<{ redirectUrl: string }> {
    const pend = this.pending.get(consentId);
    if (pend === undefined || pend.expiresAtMs < this.now()) {
      this.pending.delete(consentId);
      throw new ConsentError('consent request expired or unknown');
    }
    // One-shot: consume the pending consent BEFORE verifying, so a wrong guess invalidates the
    // consent_id regardless of outcome. Each guess then costs a fresh (SDK-rate-limited) /authorize
    // round-trip, dropping brute force to the /authorize cap. Owner typo ⇒ restart the flow.
    this.pending.delete(consentId);
    if (!(await this.opts.verifyOwner(passphrase))) {
      throw new ConsentError('incorrect owner passphrase');
    }

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
    // Delete-on-lazy-expiry (SEC-02): evict a found-but-expired code instead of leaving it to rot.
    // (A valid code is intentionally NOT deleted here — the SDK verifies PKCE between this read-only
    // call and exchangeAuthorizationCode, which is where the single-use consume happens.)
    if (rec !== undefined && rec.expiresAtMs < this.now()) this.codes.delete(authorizationCode);
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
      if (rec !== undefined) this.codes.delete(authorizationCode); // expired/mismatched: evict (SEC-02)
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    // Single-use: consume the code on ANY exchange attempt, BEFORE the redirect_uri compare, so a
    // failed exchange leaves nothing replayable (SEC-10). Residual: the PKCE-failure path can't be
    // consumed here — the SDK verifies PKCE via the read-only challengeForAuthorizationCode call
    // just before this one, and deleting the code there would break the happy path.
    this.codes.delete(authorizationCode);
    // Unconditional redirect_uri binding per OAuth 2.1 (SEC-12): a token request that omits it must
    // be rejected, not silently skip the check. A real MCP client (Claude/SDK) always sends it.
    if (redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
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
      if (rec !== undefined) this.refresh.delete(refreshToken); // stale/mismatched: evict (SEC-02)
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    // Scope subset check (SEC-11): a refresh MUST NOT widen scope beyond the original grant. Checked
    // BEFORE consuming the token so a bad-scope request is retryable (does not burn the refresh
    // token). Latent defense-in-depth today — no Parley capability is scope-gated (the allowlist is
    // topic-based) — but any future scope gate would otherwise be bypassable via refresh.
    if (scopes !== undefined && !scopes.every((s) => rec.scopes.includes(s))) {
      throw new InvalidScopeError('requested scope exceeds the original grant');
    }
    this.refresh.delete(refreshToken); // rotate: invalidate the used refresh token
    this.access.delete(rec.accessToken); // free the access token orphaned by this rotation (SEC-02)
    return this.issue(client.client_id, scopes ?? rec.scopes, resource?.href ?? rec.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.access.get(token);
    if (rec === undefined || rec.expiresAt < this.now() / 1000) {
      if (rec !== undefined) this.access.delete(token); // delete-on-lazy-expiry (SEC-02)
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
      accessToken, // back-link so refresh rotation can free the access token it replaces (SEC-02)
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
