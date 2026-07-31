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
  InvalidTargetError,
  InvalidTokenError,
  TemporarilyUnavailableError,
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
const SWEEP_INTERVAL_MS = 60_000;
const MAX_CLIENTS = 100;
const MAX_PENDING = 100;

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
interface ClientState {
  clientId: string;
  expiresAtMs: number;
  /** Whether reaching this state cost the owner's passphrase, or any anonymous caller can create it. */
  ownerApproved: boolean;
}

/**
 * Whether the client itself wrote `redirect_uri` on the authorization request. The SDK's handler
 * defaults `params.redirectUri` to the client's single registered URI when it was absent, so by the
 * time the provider sees the params the two cases are indistinguishable — and RFC 6749 §4.1.3 makes
 * the parameter REQUIRED at /token only in the first of them. Reading both containers keeps the
 * answer "supplied" whenever it might have been, which is the strict side.
 */
function redirectUriWasSupplied(res: Response): boolean {
  const req = (res as { req?: { body?: unknown; query?: unknown } }).req;
  if (req === undefined) return true;
  const body = req.body as Record<string, unknown> | undefined;
  const query = req.query as Record<string, unknown> | undefined;
  return (body?.redirect_uri ?? query?.redirect_uri) !== undefined;
}

// Keep this filter, so that `scope=` or a doubled space cannot be refused as an unsupported scope
// whose name is the empty string — an error_description naming nothing, on a flow the client cannot
// recover from. RFC 6749 §3.3 spells a scope token `1*NQCHAR`: an empty one never names one.
function namedScopes(scopes: string[]): string[] {
  return scopes.filter((s) => s.length > 0);
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

const DEFAULT_SCOPES_SUPPORTED = ['mcp'];

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

  private hasLiveState(clientId: string, accept: (state: ClientState) => boolean): boolean {
    const nowMs = this.now();
    for (const state of this.clientStates()) {
      if (state.clientId === clientId && state.expiresAtMs >= nowMs && accept(state)) return true;
    }
    return false;
  }

  /**
   * Who to shed when the map is full, in order of what the owner has invested: an idle registration
   * first, then one holding nothing but a consent nobody has approved yet. A pending consent is
   * state any anonymous caller can create by calling /authorize, so counting it as "in use" would
   * let registration spam pin every slot and refuse the owner's connector outright — the very
   * lock-out the cap exists to prevent. Only owner-approved state, which costs the passphrase, is
   * unevictable.
   */
  private evictionCandidate(): string | undefined {
    const ids = [...this.clients.keys()];
    return (
      ids.find((id) => !this.hasLiveState(id, () => true)) ??
      ids.find((id) => !this.hasLiveState(id, (state) => state.ownerApproved))
    );
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      // DCR: the SDK has already set client_id on the object before calling this.
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        if (!this.clients.has(full.client_id) && this.clients.size >= MAX_CLIENTS) {
          const evictable = this.evictionCandidate();
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

  private assertScopes(scopes: string[] | undefined): void {
    const supported = this.opts.scopesSupported ?? DEFAULT_SCOPES_SUPPORTED;
    const unsupported = (scopes ?? []).filter((s) => !supported.includes(s));
    if (unsupported.length > 0) {
      throw new InvalidScopeError(
        `this server does not issue the scope(s) ${unsupported.join(' ')}; it supports ${supported.join(' ')}`,
      );
    }
  }

  private assertResource(resource: URL | undefined): void {
    if (resource !== undefined && resource.href !== this.opts.resource.href) {
      throw new InvalidTargetError(
        `this server only issues tokens for ${this.opts.resource.href}`,
      );
    }
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
    this.assertResource(params.resource);
    const consented =
      params.scopes === undefined ? params : { ...params, scopes: namedScopes(params.scopes) };
    this.assertScopes(consented.scopes);
    const consentId = randomUUID();
    this.pending.set(consentId, {
      client,
      params: consented,
      redirectUriSupplied: redirectUriWasSupplied(res),
      expiresAtMs: this.now() + CONSENT_TTL_MS,
    });
    this.capPending();
    res.status(200).type('html').send(this.consentPage(consentId, client, consented));
  }

  /**
   * The 60s sweeper and the 5-minute TTL are a rate, not a bound, and every entry here is state an
   * anonymous caller created by calling /authorize — so shed the oldest once the map is full, the
   * same honest ordering {@link evictionCandidate} sheds registrations by. Refusing instead would
   * hand the same anonymous caller a way to lock the owner out of the only path that authorizes
   * the bridge.
   */
  private capPending(): void {
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) return;
      this.pending.delete(oldest);
    }
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
    this.assertResource(resource);
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
    this.assertResource(resource);
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

  private consentPage(
    consentId: string,
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
  ): string {
    const name = escapeHtml(client.client_name ?? client.client_id);
    const scopeList = (params.scopes ?? []).map(escapeHtml).join(', ') || '(none requested)';
    const redirect = escapeHtml(identifyingRedirect(params.redirectUri));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parley — authorize</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:1.5rem}label{display:block;margin:1rem 0 .25rem}
input[type=password]{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;font-size:1rem}
button{margin-top:1.25rem;padding:.6rem 1.25rem;border:0;border-radius:8px;background:#111;color:#fff;font-size:1rem;cursor:pointer}
.muted{color:#666;font-size:.9rem}</style></head>
<body><div class="box"><h1>Authorize access to Parley</h1>
<p>A client at <strong>${redirect}</strong> wants to connect to your Parley bridge.</p>
<p class="muted">Client-supplied name: ${name}<br>Scopes: ${scopeList}</p>
<p>Enter your owner passphrase to approve. This is the only party that can authorize this bridge.</p>
<form method="POST" action="${escapeHtml(this.opts.consentPath)}">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<label for="passphrase">Owner passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus required>
<button type="submit">Approve</button></form></div></body></html>`;
  }
}

/**
 * The consent page leads with the redirect target because it is the one thing on the page the
 * client cannot choose freely. `URL.origin` is the opaque string `'null'` for every non-special
 * scheme (`myapp://cb`), so taking it unconditionally would print a literal `null` as the client's
 * identity and leave the attacker-supplied `client_name` as the only thing the owner can read. Fall
 * back to the whole URI, which at least names the scheme and host the code would be handed to.
 */
function identifyingRedirect(redirectUri: string): string {
  try {
    const { origin } = new URL(redirectUri);
    return origin === 'null' ? redirectUri : origin;
  } catch {
    return redirectUri;
  }
}

/** Raised by completeConsent on owner-secret failure or unknown/expired consent. */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}
