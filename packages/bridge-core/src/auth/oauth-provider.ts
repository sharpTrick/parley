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
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { renderConsentPage } from './consent-page.js';
import {
  type ClientState,
  MAX_CLIENTS,
  MAX_PENDING,
  evictionCandidate,
  shedCrowdedest,
} from './eviction.js';
import {
  assertResource,
  assertScopes,
  namedScopes,
  redirectUriWasSupplied,
} from './grant-params.js';

const ACCESS_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 60_000; // 1 minute, single-use
const CONSENT_TTL_MS = 5 * 60_000; // 5 minutes to approve
const SWEEP_INTERVAL_MS = 60_000;

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  redirectUriSupplied: boolean;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAtMs: number;
}
interface AccessRecord extends AuthInfo {
  expiresAt: number; // seconds since epoch (required by requireBearerAuth)
  grantId: string;
}
interface RefreshRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAtMs: number;
  grantId: string;
}
interface PendingConsent {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  redirectUriSupplied: boolean;
  expiresAtMs: number;
}

export interface ParleyOAuthProviderOptions {
  /** Canonical resource (RS) identifier = the public /mcp URL (no trailing slash). Audience for tokens. */
  resource: URL;
  /** Verify the owner's consent secret (timing-safe, off the event loop). Single-tenant gate (DESIGN §10/§14). */
  verifyOwner: (passphrase: string) => Promise<boolean>;
  /** Path the consent form POSTs to (mounted by the remote app). */
  consentPath: string;
  /**
   * Scopes this AS advertises in its metadata. A request for anything outside the set is refused
   * with `invalid_scope`; pass the SAME array the metadata document is built from, so the advertised
   * set and the enforced one cannot drift.
   */
  scopesSupported?: string[];
  /** Clock injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Single-tenant OAuth 2.1 + PKCE provider (DESIGN §10/§14). It is the authorization server for
 * exactly one owner: any client may dynamically register (DCR — Claude uses this), but issuing a
 * token requires the OWNER to consent with their secret. The SDK's handlers do PKCE S256
 * verification, DCR, and metadata; this provider supplies the issuing/verifying logic, gates
 * `authorize()` on owner consent, and binds tokens to the `/mcp` resource (RFC 8707 audience).
 *
 * Every store below is PROCESS-LOCAL and unpersisted — `clients` (DCR registrations), `codes` and
 * `redeeming` (authorization codes), `access`, `refresh`, `pending` (consents). Two deployment
 * constraints follow, and examples/self-host-remote/README.md states both: a restart or crash
 * invalidates the connector's registration and its tokens, so the owner must re-consent; and the
 * process cannot be replicated, because a code minted in one replica is unredeemable in another.
 */
export class ParleyOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly redeeming = new Map<string, CodeRecord>();
  private readonly access = new Map<string, AccessRecord>();
  private readonly refresh = new Map<string, RefreshRecord>();
  private readonly pending = new Map<string, PendingConsent>();
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: ParleyOAuthProviderOptions) {
    this.now = opts.now ?? Date.now;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Keep the .unref(), so that an un-stopped provider can never hold the process open.
    this.sweepTimer.unref?.();
  }

  /** Evict every expired code/refresh/pending/access record. Uses the injectable clock (test-friendly). */
  private sweep(): void {
    const nowMs = this.now();
    const nowSec = nowMs / 1000;
    for (const [k, r] of this.codes) if (r.expiresAtMs < nowMs) this.codes.delete(k);
    for (const [k, r] of this.redeeming) if (r.expiresAtMs < nowMs) this.redeeming.delete(k);
    for (const [k, r] of this.refresh) if (r.expiresAtMs < nowMs) this.refresh.delete(k);
    for (const [k, r] of this.pending) if (r.expiresAtMs < nowMs) this.pending.delete(k);
    for (const [k, r] of this.access) if (r.expiresAt < nowSec) this.access.delete(k);
  }

  /** Stop the background sweeper and drop all issued state (graceful shutdown / tests). */
  stop(): void {
    clearInterval(this.sweepTimer);
    this.codes.clear();
    this.redeeming.clear();
    this.access.clear();
    this.refresh.clear();
    this.pending.clear();
    this.clients.clear();
  }

  // Keep every client-keyed store listed here, and keep `ownerApproved` honest: a state the owner
  // holds BEFORE any token exists — an approved code not yet exchanged — still protects its
  // registration from the eviction below, while a state an anonymous caller can create for itself
  // does not.
  private *clientStates(): Iterable<ClientState> {
    for (const r of this.access.values()) {
      yield { clientId: r.clientId, expiresAtMs: r.expiresAt * 1000, ownerApproved: true };
    }
    for (const store of [this.refresh, this.codes, this.redeeming]) {
      for (const r of store.values()) {
        yield { clientId: r.clientId, expiresAtMs: r.expiresAtMs, ownerApproved: true };
      }
    }
    for (const r of this.pending.values()) {
      yield { clientId: r.client.client_id, expiresAtMs: r.expiresAtMs, ownerApproved: false };
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      // DCR: the SDK has already set client_id on the object before calling this.
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        if (!this.clients.has(full.client_id) && this.clients.size >= MAX_CLIENTS) {
          const evictable = evictionCandidate(this.clients.keys(), this.clientStates(), this.now());
          if (evictable === undefined) {
            throw new TemporarilyUnavailableError('client registration capacity reached');
          }
          this.clients.delete(evictable);
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
    assertResource(params.resource, this.opts.resource);
    const consented =
      params.scopes === undefined ? params : { ...params, scopes: namedScopes(params.scopes) };
    assertScopes(consented.scopes, this.opts.scopesSupported);
    const consentId = randomUUID();
    this.pending.set(consentId, {
      client,
      params: consented,
      redirectUriSupplied: redirectUriWasSupplied(res),
      expiresAtMs: this.now() + CONSENT_TTL_MS,
    });
    shedCrowdedest(this.pending, MAX_PENDING, (p) => p.client.client_id);
    const page = renderConsentPage(consentId, client, consented, this.opts.consentPath);
    res.status(200).type('html').send(page);
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
    // Consume before verifying, so that a wrong guess costs a fresh (rate-limited) /authorize
    // round-trip instead of an unlimited retry against the same consent_id.
    this.pending.delete(consentId);
    if (!(await this.opts.verifyOwner(passphrase))) {
      throw new ConsentError('incorrect owner passphrase');
    }

    const code = randomUUID();
    this.codes.set(code, {
      clientId: pend.client.client_id,
      redirectUri: pend.params.redirectUri,
      redirectUriSupplied: pend.redirectUriSupplied,
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
    if (rec !== undefined && rec.expiresAtMs < this.now()) this.codes.delete(authorizationCode);
    if (rec === undefined || rec.clientId !== client.client_id || rec.expiresAtMs < this.now()) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    // Move the code out of `codes` before handing the challenge over, so that the SDK's PKCE check
    // — which runs between this call and exchangeAuthorizationCode, out of this class's reach — can
    // fail without leaving a code a second attempt could redeem. Only exchange reads `redeeming`,
    // and a foreign client is refused above, so a stranger still cannot burn someone else's code.
    this.codes.delete(authorizationCode);
    this.redeeming.set(authorizationCode, rec);
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // SDK already verified PKCE S256 before calling us
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode) ?? this.redeeming.get(authorizationCode);
    // Evict only on expiry, so that a foreign client presenting someone else's code cannot burn it.
    if (rec !== undefined && rec.expiresAtMs < this.now()) this.forgetCode(authorizationCode);
    if (rec === undefined || rec.clientId !== client.client_id || rec.expiresAtMs < this.now()) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    // Consume before every remaining check, so that a failed exchange leaves nothing replayable.
    this.forgetCode(authorizationCode);
    // Keep the exchange unbound when the client never wrote redirect_uri at /authorize, so that a
    // single-registered-URI client the SDK defaulted for is not refused here — after the owner's
    // consent is already spent and the code burned, with only a generic invalid_grant to go on.
    if ((rec.redirectUriSupplied || redirectUri !== undefined) && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    assertResource(resource, this.opts.resource);
    return this.issue(client.client_id, rec.scopes, resource?.href ?? rec.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.refresh.get(refreshToken);
    // Evict only on expiry, so that a foreign client presenting someone else's token cannot burn it.
    if (rec !== undefined && rec.expiresAtMs < this.now()) this.refresh.delete(refreshToken);
    if (rec === undefined || rec.clientId !== client.client_id || rec.expiresAtMs < this.now()) {
      throw new InvalidGrantError('authorization grant is invalid or expired');
    }
    const requested = scopes === undefined ? undefined : namedScopes(scopes);
    if (requested !== undefined && !requested.every((s) => rec.scopes.includes(s))) {
      throw new InvalidScopeError('requested scope exceeds the original grant');
    }
    assertResource(resource, this.opts.resource);
    // Rotation is revocation plus re-issue under the same grant: the presented refresh token and
    // the access token it minted both die here.
    this.revokeGrant(rec.grantId);
    return this.issue(
      client.client_id,
      requested ?? rec.scopes,
      resource?.href ?? rec.resource,
      rec.grantId,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.access.get(token);
    if (rec === undefined || rec.expiresAt < this.now() / 1000) {
      if (rec !== undefined) this.access.delete(token);
      throw new InvalidTokenError('access token is invalid or expired');
    }
    // RFC 8707 audience binding: the token must have been minted for THIS resource.
    if (rec.resource !== undefined && rec.resource.href !== this.opts.resource.href) {
      throw new InvalidTokenError('access token is invalid or expired');
    }
    // Copy every mutable field out, so that a consumer mutating req.auth cannot widen the stored
    // grant — the refresh-narrowing check reads the same array on every later rotation.
    return {
      ...rec,
      scopes: [...rec.scopes],
      ...(rec.resource !== undefined ? { resource: new URL(rec.resource.href) } : {}),
    };
  }

  /**
   * RFC 7009 revocation. Revoking any credential kills the whole grant — every access and refresh
   * token of every rotation generation — and only the client the grant was issued to may do it.
   * An unknown or foreign token is a silent no-op so the endpoint is not a token oracle.
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const rec = this.access.get(request.token) ?? this.refresh.get(request.token);
    if (rec === undefined || rec.clientId !== client.client_id) return;
    this.revokeGrant(rec.grantId);
  }

  private forgetCode(code: string): void {
    this.codes.delete(code);
    this.redeeming.delete(code);
  }

  private revokeGrant(grantId: string): void {
    for (const [k, r] of this.access) if (r.grantId === grantId) this.access.delete(k);
    for (const [k, r] of this.refresh) if (r.grantId === grantId) this.refresh.delete(k);
  }

  private issue(
    clientId: string,
    scopes: string[],
    resource: string,
    grantId: string = randomUUID(),
  ): OAuthTokens {
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const resourceUrl = new URL(resource);
    this.access.set(accessToken, {
      token: accessToken,
      clientId,
      scopes: [...scopes],
      expiresAt: Math.floor(this.now() / 1000) + ACCESS_TTL_SEC,
      resource: resourceUrl,
      grantId,
    });
    this.refresh.set(refreshToken, {
      clientId,
      scopes: [...scopes],
      resource,
      expiresAtMs: this.now() + REFRESH_TTL_SEC * 1000,
      grantId,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}

/** Raised by completeConsent on owner-secret failure or unknown/expired consent. */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}
