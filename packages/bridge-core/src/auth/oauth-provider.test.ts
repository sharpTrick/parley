import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParleyOAuthProvider, type ParleyOAuthProviderOptions } from './oauth-provider.js';

const RESOURCE = new URL('https://bridge.example/mcp');
const REDIRECT = 'https://app.example/cb';
const GOOD_PASS = 'open sesame';

// Private-state peek for white-box assertions (map sizes / keys, driving the private sweep). The
// provider keeps all OAuth state in-memory and private; tests observe it via this narrow cast.
interface Internals {
  clients: Map<string, unknown>;
  codes: Map<string, unknown>;
  access: Map<string, unknown>;
  refresh: Map<string, unknown>;
  pending: Map<string, unknown>;
  sweep(): void;
  issue(clientId: string, scopes: string[], resource: string): OAuthTokens;
}
const peek = (p: ParleyOAuthProvider): Internals => p as unknown as Internals;

/** Fake express Response — authorize() only calls status().type().send(). */
function fakeRes(): Response {
  const r: Record<string, unknown> = {};
  r.status = () => r;
  r.type = () => r;
  r.send = () => r;
  return r as unknown as Response;
}

function makeClient(id = 'client-1'): OAuthClientInformationFull {
  return { client_id: id, redirect_uris: [REDIRECT] } as OAuthClientInformationFull;
}

function makeParams(overrides: Partial<AuthorizationParams> = {}): AuthorizationParams {
  return { redirectUri: REDIRECT, codeChallenge: 'challenge-abc', scopes: ['mcp'], state: 'st', ...overrides };
}

// Track providers so their background sweep timers are always cleared, even on assertion failure.
const live: ParleyOAuthProvider[] = [];
function makeProvider(now: () => number, opts: Partial<ParleyOAuthProviderOptions> = {}): ParleyOAuthProvider {
  const p = new ParleyOAuthProvider({
    resource: RESOURCE,
    verifyOwner: async (pass) => pass === GOOD_PASS,
    consentPath: '/parley/consent',
    now,
    ...opts,
  });
  live.push(p);
  return p;
}
afterEach(() => {
  while (live.length > 0) live.pop()?.stop();
  vi.restoreAllMocks();
});

/** Drive authorize → completeConsent to mint a live authorization code, returning it. */
async function mintCode(p: ParleyOAuthProvider, client: OAuthClientInformationFull, params: AuthorizationParams): Promise<string> {
  await p.authorize(client, params, fakeRes());
  const consentId = [...peek(p).pending.keys()].at(-1);
  if (consentId === undefined) throw new Error('no pending consent seeded');
  const { redirectUrl } = await p.completeConsent(consentId, GOOD_PASS);
  const code = new URL(redirectUrl).searchParams.get('code');
  if (code === null) throw new Error('no code minted');
  return code;
}

describe('ParleyOAuthProvider — SEC-02 (state lifecycle / sweeper)', () => {
  it('sweeps every expired code/refresh/pending/access entry once the clock advances past their TTLs', async () => {
    let clock = 1_000_000;
    const p = makeProvider(() => clock);
    const client = makeClient();
    peek(p).clients.set(client.client_id, client);

    await p.authorize(client, makeParams(), fakeRes()); // seeds pending
    await mintCode(p, client, makeParams()); // seeds a code (+ a second pending, already consumed)
    peek(p).issue(client.client_id, ['mcp'], RESOURCE.href); // seeds access + refresh

    expect(peek(p).pending.size).toBeGreaterThan(0);
    expect(peek(p).codes.size).toBe(1);
    expect(peek(p).access.size).toBe(1);
    expect(peek(p).refresh.size).toBe(1);

    clock += 31 * 24 * 60 * 60 * 1000; // past every TTL (refresh is the longest at 30 days)
    peek(p).sweep();

    expect(peek(p).pending.size).toBe(0);
    expect(peek(p).codes.size).toBe(0);
    expect(peek(p).access.size).toBe(0);
    expect(peek(p).refresh.size).toBe(0);
  });

  it('deletes a found-but-expired access token lazily on verifyAccessToken', async () => {
    let clock = 5_000_000;
    const p = makeProvider(() => clock);
    const { access_token } = peek(p).issue('client-1', ['mcp'], RESOURCE.href);
    expect(peek(p).access.size).toBe(1);

    clock += 2 * 60 * 60 * 1000; // past the 1h access TTL
    await expect(p.verifyAccessToken(access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    expect(peek(p).access.has(access_token)).toBe(false); // evicted, not left to rot
  });

  it('deletes a found-but-expired code lazily on challengeForAuthorizationCode', async () => {
    let clock = 7_000_000;
    const p = makeProvider(() => clock);
    const client = makeClient();
    const code = await mintCode(p, client, makeParams());
    expect(peek(p).codes.size).toBe(1);

    clock += 2 * 60 * 1000; // past the 1m code TTL
    await expect(p.challengeForAuthorizationCode(client, code)).rejects.toBeInstanceOf(InvalidGrantError);
    expect(peek(p).codes.has(code)).toBe(false);
  });

  it('frees the orphaned access token on refresh rotation — access map does not grow per refresh', async () => {
    const p = makeProvider(() => 9_000_000);
    const client = makeClient();
    let rt = peek(p).issue(client.client_id, ['mcp'], RESOURCE.href).refresh_token;
    expect(peek(p).access.size).toBe(1);

    for (let i = 0; i < 5; i++) {
      if (rt === undefined) throw new Error('missing refresh token');
      const tokens = await p.exchangeRefreshToken(client, rt);
      rt = tokens.refresh_token;
      expect(peek(p).access.size).toBe(1); // old access token was freed alongside the rotated refresh
      expect(peek(p).refresh.size).toBe(1);
    }
  });

  it('caps the DCR clients map at MAX_CLIENTS by evicting the oldest registration', () => {
    const p = makeProvider(() => 1);
    const store = p.clientsStore;
    const register = store.registerClient;
    if (register === undefined) throw new Error('registerClient not implemented');
    for (let i = 0; i < 150; i++) {
      register({ client_id: `c-${i}`, redirect_uris: [REDIRECT] } as OAuthClientInformationFull);
    }
    expect(peek(p).clients.size).toBeLessThanOrEqual(100);
    expect(store.getClient('c-0')).toBeUndefined(); // oldest evicted
    expect(store.getClient('c-149')).toBeDefined(); // newest retained
  });

  it('stop() clears the background sweep interval (no dangling timer)', () => {
    const spy = vi.spyOn(globalThis, 'clearInterval');
    const p = new ParleyOAuthProvider({
      resource: RESOURCE,
      verifyOwner: async () => true,
      consentPath: '/parley/consent',
      now: () => 1,
    });
    p.stop();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ParleyOAuthProvider — SEC-10 (single-use code on any failed exchange)', () => {
  it('consumes the code on a redirect_uri-mismatch attempt so a later correct exchange still fails', async () => {
    const p = makeProvider(() => 2_000_000);
    const client = makeClient();
    const code = await mintCode(p, client, makeParams());

    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/cb'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(peek(p).codes.has(code)).toBe(false); // consumed despite the failure

    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, REDIRECT),
    ).rejects.toBeInstanceOf(InvalidGrantError); // replay closed
  });
});

describe('ParleyOAuthProvider — SEC-11 (refresh scope subset)', () => {
  it('rejects scope widening with invalid_scope without burning the refresh token', async () => {
    const p = makeProvider(() => 3_000_000);
    const client = makeClient();
    const rt = peek(p).issue(client.client_id, ['mcp'], RESOURCE.href).refresh_token;
    if (rt === undefined) throw new Error('missing refresh token');

    await expect(
      p.exchangeRefreshToken(client, rt, ['mcp', 'admin']),
    ).rejects.toBeInstanceOf(InvalidScopeError);
    expect(peek(p).refresh.has(rt)).toBe(true); // not consumed — request is retryable

    const subset = await p.exchangeRefreshToken(client, rt, ['mcp']);
    expect(subset.scope).toBe('mcp');
  });

  it('defaults to the granted scopes when none are requested', async () => {
    const p = makeProvider(() => 3_500_000);
    const client = makeClient();
    const rt = peek(p).issue(client.client_id, ['mcp'], RESOURCE.href).refresh_token;
    if (rt === undefined) throw new Error('missing refresh token');

    const tokens = await p.exchangeRefreshToken(client, rt, undefined);
    expect(tokens.scope).toBe('mcp');
  });
});

describe('ParleyOAuthProvider — SEC-12 (unconditional redirect_uri binding)', () => {
  it('rejects a token exchange that omits redirect_uri', async () => {
    const p = makeProvider(() => 4_000_000);
    const client = makeClient();
    const code = await mintCode(p, client, makeParams());

    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, undefined),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('still succeeds for a legitimate exchange that includes the matching redirect_uri', async () => {
    const p = makeProvider(() => 4_500_000);
    const client = makeClient();
    const code = await mintCode(p, client, makeParams());

    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe('bearer');
  });
});
