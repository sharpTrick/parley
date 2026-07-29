import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  OAuthError,
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
  issue(clientId: string, scopes: string[], resource: string, grantId?: string): OAuthTokens;
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

describe('ParleyOAuthProvider — expired state is swept, not left to accumulate', () => {
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

describe('ParleyOAuthProvider — an authorization code is single-use on any failed exchange', () => {
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

describe('ParleyOAuthProvider — a refresh may narrow scope but never widen it', () => {
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

describe('ParleyOAuthProvider — redirect_uri is bound unconditionally, not only when present', () => {
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

/** Mint an access+refresh pair directly, asserting both halves exist. */
function issuePair(
  p: ParleyOAuthProvider,
  client: OAuthClientInformationFull,
  resource = RESOURCE.href,
): { access: string; refresh: string } {
  const t = peek(p).issue(client.client_id, ['mcp'], resource);
  if (t.refresh_token === undefined) throw new Error('missing refresh token');
  return { access: t.access_token, refresh: t.refresh_token };
}

/** Every credential kind a grant hands out. Adding one should force a row here. */
const CREDENTIAL_KINDS = ['access', 'refresh'] as const;
type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

async function assertGrantIsDead(
  p: ParleyOAuthProvider,
  client: OAuthClientInformationFull,
  pair: { access: string; refresh: string },
): Promise<void> {
  await expect(p.verifyAccessToken(pair.access)).rejects.toBeInstanceOf(InvalidTokenError);
  await expect(p.exchangeRefreshToken(client, pair.refresh)).rejects.toBeInstanceOf(
    InvalidGrantError,
  );
}

describe('ParleyOAuthProvider — revoking any credential revokes the whole grant', () => {
  it.each(CREDENTIAL_KINDS.map((k) => [k]))(
    'revoking the %s token kills both halves of the pair',
    async (kind: CredentialKind) => {
      const p = makeProvider(() => 1_000_000);
      const client = makeClient();
      const pair = issuePair(p, client);

      await p.revokeToken(client, { token: pair[kind] });

      await assertGrantIsDead(p, client, pair);
    },
  );

  const CHAIN_LENGTHS = [0, 1, 5];
  const CHAINS: Array<[number, CredentialKind]> = CHAIN_LENGTHS.flatMap((n) =>
    CREDENTIAL_KINDS.map((k): [number, CredentialKind] => [n, k]),
  );
  it.each(CHAINS)(
    'after %i rotations, revoking the live %s token kills every generation of the chain',
    async (rotations, kind) => {
      const p = makeProvider(() => 1_500_000);
      const client = makeClient();
      let live = issuePair(p, client);
      const generations = [live];

      for (let i = 0; i < rotations; i++) {
        const t = await p.exchangeRefreshToken(client, live.refresh);
        if (t.refresh_token === undefined) throw new Error('rotation dropped the refresh token');
        live = { access: t.access_token, refresh: t.refresh_token };
        generations.push(live);
      }

      await p.revokeToken(client, { token: live[kind] });

      for (const gen of generations) await assertGrantIsDead(p, client, gen);
      expect(peek(p).access.size).toBe(0);
      expect(peek(p).refresh.size).toBe(0);
    },
  );

  it('leaves an unrelated grant of the same client untouched', async () => {
    const p = makeProvider(() => 1_700_000);
    const client = makeClient();
    const doomed = issuePair(p, client);
    const other = issuePair(p, client);

    await p.revokeToken(client, { token: doomed.access });

    await assertGrantIsDead(p, client, doomed);
    await expect(p.verifyAccessToken(other.access)).resolves.toBeTruthy();
  });

  it('is a silent no-op for an unknown token (RFC 7009: no token oracle)', async () => {
    const p = makeProvider(() => 1_800_000);
    await expect(p.revokeToken(makeClient(), { token: 'never-issued' })).resolves.toBeUndefined();
  });
});

/**
 * Every entry point that acts on a grant artefact. A new grant type or endpoint should add a row;
 * the class under test is "an artefact is only ever actionable by the client it was issued to".
 */
interface RedemptionCase {
  name: string;
  /** Seed an artefact belonging to `owner`. */
  seed: (p: ParleyOAuthProvider, owner: OAuthClientInformationFull) => Promise<string>;
  /** Drive the entry point as `caller`. */
  attempt: (
    p: ParleyOAuthProvider,
    caller: OAuthClientInformationFull,
    artefact: string,
  ) => Promise<unknown>;
  /** revokeToken answers 200 either way per RFC 7009; the others must raise invalid_grant. */
  foreignCallerThrows: boolean;
  /**
   * Prove the failed foreign attempt left the artefact alive. For revokeToken this cannot be
   * "call it again" — revocation resolves either way — so each row states its own evidence.
   */
  assertIntact: (
    p: ParleyOAuthProvider,
    owner: OAuthClientInformationFull,
    artefact: string,
  ) => Promise<unknown>;
}

const REDEMPTIONS: RedemptionCase[] = [
  {
    name: 'challengeForAuthorizationCode',
    seed: (p, owner) => mintCode(p, owner, makeParams()),
    attempt: (p, caller, code) => p.challengeForAuthorizationCode(caller, code),
    foreignCallerThrows: true,
    assertIntact: (p, owner, code) =>
      expect(p.challengeForAuthorizationCode(owner, code)).resolves.toBeTypeOf('string'),
  },
  {
    name: 'exchangeAuthorizationCode',
    seed: (p, owner) => mintCode(p, owner, makeParams()),
    attempt: (p, caller, code) => p.exchangeAuthorizationCode(caller, code, undefined, REDIRECT),
    foreignCallerThrows: true,
    assertIntact: async (p, owner, code) => {
      const tokens = await p.exchangeAuthorizationCode(owner, code, undefined, REDIRECT);
      expect(tokens.access_token).toBeTruthy();
    },
  },
  {
    name: 'exchangeRefreshToken',
    seed: async (p, owner) => issuePair(p, owner).refresh,
    attempt: (p, caller, rt) => p.exchangeRefreshToken(caller, rt),
    foreignCallerThrows: true,
    assertIntact: async (p, owner, rt) => {
      const tokens = await p.exchangeRefreshToken(owner, rt);
      expect(tokens.access_token).toBeTruthy();
    },
  },
  {
    name: 'revokeToken',
    seed: async (p, owner) => issuePair(p, owner).access,
    attempt: (p, caller, token) => p.revokeToken(caller, { token }),
    foreignCallerThrows: false,
    assertIntact: (p, _owner, token) => expect(p.verifyAccessToken(token)).resolves.toBeTruthy(),
  },
];

describe('ParleyOAuthProvider — a grant artefact is only actionable by its own client', () => {
  it.each(REDEMPTIONS.map((c) => [c.name, c]))(
    '%s rejects a foreign client and leaves the artefact usable by its owner',
    async (_name: string, c: RedemptionCase) => {
      const p = makeProvider(() => 6_000_000);
      const owner = makeClient('victim-client');
      const attacker = makeClient('attacker-client');
      const artefact = await c.seed(p, owner);

      const foreign = c.attempt(p, attacker, artefact);
      if (c.foreignCallerThrows) {
        await expect(foreign).rejects.toBeInstanceOf(InvalidGrantError);
      } else {
        await expect(foreign).resolves.toBeUndefined();
      }

      // The failed foreign attempt must not have consumed or destroyed the victim's artefact.
      await c.assertIntact(p, owner, artefact);
    },
  );
});

const NEAR_MISS_RESOURCES: Array<[string, string, 'accept' | 'reject']> = [
  ['exact match', 'https://bridge.example/mcp', 'accept'],
  ['host case difference (URL-normalised)', 'https://BRIDGE.example/mcp', 'accept'],
  ['explicit default port (URL-normalised)', 'https://bridge.example:443/mcp', 'accept'],
  ['foreign host', 'https://evil.example/mcp', 'reject'],
  ['foreign path', 'https://bridge.example/other', 'reject'],
  ['path case difference', 'https://bridge.example/MCP', 'reject'],
  ['trailing slash', 'https://bridge.example/mcp/', 'reject'],
  ['foreign scheme', 'http://bridge.example/mcp', 'reject'],
  ['foreign port', 'https://bridge.example:8443/mcp', 'reject'],
  ['sub-path of the resource', 'https://bridge.example/mcp/v2', 'reject'],
  ['userinfo prefix', 'https://user@bridge.example/mcp', 'reject'],
];

describe('ParleyOAuthProvider — RFC 8707 audience binding on verifyAccessToken', () => {
  it.each(NEAR_MISS_RESOURCES)(
    'a token minted for %s (%s) is %s-ed',
    async (_label: string, resource: string, verdict: 'accept' | 'reject') => {
      const p = makeProvider(() => 8_000_000);
      const { access } = issuePair(p, makeClient(), resource);
      const result = p.verifyAccessToken(access);
      if (verdict === 'accept') {
        await expect(result).resolves.toBeTruthy();
      } else {
        await expect(result).rejects.toBeInstanceOf(InvalidTokenError);
      }
    },
  );

  it('rejects a token that was never issued', async () => {
    const p = makeProvider(() => 8_100_000);
    await expect(p.verifyAccessToken('never-issued')).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('ParleyOAuthProvider — a resource this AS does not serve is refused up front', () => {
  it.each(NEAR_MISS_RESOURCES)(
    'authorize() with resource %s (%s): %s',
    async (_label: string, resource: string, verdict: 'accept' | 'reject') => {
      const p = makeProvider(() => 9_100_000);
      const attempt = p.authorize(
        makeClient(),
        makeParams({ resource: new URL(resource) }),
        fakeRes(),
      );
      if (verdict === 'accept') {
        await expect(attempt).resolves.toBeUndefined();
      } else {
        await expect(attempt).rejects.toBeInstanceOf(InvalidTargetError);
        expect(peek(p).pending.size).toBe(0); // no consent page rendered, no owner secret spent
      }
    },
  );

  it.each(NEAR_MISS_RESOURCES.filter(([, , v]) => v === 'reject'))(
    'exchangeAuthorizationCode with resource %s (%s) is refused without minting',
    async (_label: string, resource: string) => {
      const p = makeProvider(() => 9_200_000);
      const client = makeClient();
      const code = await mintCode(p, client, makeParams());
      await expect(
        p.exchangeAuthorizationCode(client, code, undefined, REDIRECT, new URL(resource)),
      ).rejects.toBeInstanceOf(InvalidTargetError);
      expect(peek(p).access.size).toBe(0);
    },
  );

  it.each(NEAR_MISS_RESOURCES.filter(([, , v]) => v === 'reject'))(
    'exchangeRefreshToken with resource %s (%s) is refused without minting or burning the token',
    async (_label: string, resource: string) => {
      const p = makeProvider(() => 9_300_000);
      const client = makeClient();
      const { refresh } = issuePair(p, client);
      await expect(
        p.exchangeRefreshToken(client, refresh, undefined, new URL(resource)),
      ).rejects.toBeInstanceOf(InvalidTargetError);
      expect(peek(p).refresh.has(refresh)).toBe(true);
    },
  );

  it.each(NEAR_MISS_RESOURCES)(
    'every token this AS returns for resource %s (%s) verifies immediately',
    async (_label: string, resource: string, verdict: 'accept' | 'reject') => {
      const p = makeProvider(() => 9_400_000);
      const client = makeClient();
      const params = makeParams({ resource: new URL(resource) });

      let tokens: OAuthTokens;
      try {
        const code = await mintCode(p, client, params);
        tokens = await p.exchangeAuthorizationCode(
          client,
          code,
          undefined,
          REDIRECT,
          new URL(resource),
        );
      } catch (err) {
        expect(verdict).toBe('reject');
        expect(err).toBeInstanceOf(OAuthError);
        return;
      }
      await expect(p.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();
    },
  );
});

describe('ParleyOAuthProvider — the DCR cap never evicts a client that is in use', () => {
  const ACTIVE_SHAPES = [
    ['access token only', (p: ParleyOAuthProvider, rt: string) => peek(p).refresh.delete(rt)],
    ['refresh token only', (p: ParleyOAuthProvider, _rt: string, at?: string) =>
      peek(p).access.delete(at ?? '')],
    ['both halves live', () => undefined],
  ] as const;

  it.each(ACTIVE_SHAPES.map(([label, prune]) => [label, prune]))(
    'a consented client holding %s survives unauthenticated registration spam',
    async (_label: string, prune: (p: ParleyOAuthProvider, rt: string, at?: string) => unknown) => {
      const p = makeProvider(() => 2_500_000);
      const store = p.clientsStore;
      const register = store.registerClient;
      if (register === undefined) throw new Error('registerClient not implemented');

      const owner = makeClient('legit-claude');
      register(owner);
      const pair = issuePair(p, owner);
      prune(p, pair.refresh, pair.access);

      for (let i = 0; i < 150; i++) {
        register({ client_id: `spam-${i}`, redirect_uris: [REDIRECT] } as OAuthClientInformationFull);
      }

      expect(store.getClient('legit-claude')).toBeDefined();
      expect(peek(p).clients.size).toBeLessThanOrEqual(100); // the cap still holds
      expect(store.getClient('spam-0')).toBeUndefined(); // inactive registrations are still shed
    },
  );

  it('refuses a new registration rather than evicting the last in-use client', () => {
    const p = makeProvider(() => 2_600_000);
    const register = p.clientsStore.registerClient;
    if (register === undefined) throw new Error('registerClient not implemented');
    for (let i = 0; i < 100; i++) {
      const c = { client_id: `busy-${i}`, redirect_uris: [REDIRECT] } as OAuthClientInformationFull;
      register(c);
      issuePair(p, c);
    }
    expect(() =>
      register({ client_id: 'one-too-many', redirect_uris: [REDIRECT] } as OAuthClientInformationFull),
    ).toThrow(OAuthError);
    expect(p.clientsStore.getClient('busy-0')).toBeDefined();
  });
});
