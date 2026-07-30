import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  OAuthError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
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
  redeeming: Map<string, unknown>;
  access: Map<string, unknown>;
  refresh: Map<string, unknown>;
  pending: Map<string, unknown>;
  sweepTimer: { hasRef?: () => boolean };
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

/**
 * Every lifetime this provider grants is a policy number, and a sweep that advances past all of
 * them at once cannot tell one from another: an inflated constant leaves the artefact usable a
 * thousand times as long with nothing red. Each row pins its own TTL from BOTH sides.
 */
interface TtlCase {
  name: string;
  ttlMs: number;
  /** Seed the artefact at the current clock; the probe exercises it at whatever the clock then reads. */
  seed: (
    p: ParleyOAuthProvider,
    client: OAuthClientInformationFull,
  ) => Promise<() => Promise<unknown>>;
}

const TTL_CASES: TtlCase[] = [
  {
    name: 'a pending owner consent',
    ttlMs: 5 * 60_000,
    seed: async (p, client) => {
      await p.authorize(client, makeParams(), fakeRes());
      const consentId = [...peek(p).pending.keys()].at(-1);
      if (consentId === undefined) throw new Error('no pending consent seeded');
      return () => p.completeConsent(consentId, GOOD_PASS);
    },
  },
  {
    name: 'an authorization code',
    ttlMs: 60_000,
    seed: async (p, client) => {
      const code = await mintCode(p, client, makeParams());
      return () => p.challengeForAuthorizationCode(client, code);
    },
  },
  {
    name: 'an access token',
    ttlMs: 60 * 60_000,
    seed: async (p, client) => {
      const { access_token } = peek(p).issue(client.client_id, ['mcp'], RESOURCE.href);
      return () => p.verifyAccessToken(access_token);
    },
  },
  {
    name: 'a refresh token',
    ttlMs: 30 * 24 * 60 * 60_000,
    seed: async (p, client) => {
      const { refresh_token } = peek(p).issue(client.client_id, ['mcp'], RESOURCE.href);
      if (refresh_token === undefined) throw new Error('no refresh token issued');
      return () => p.exchangeRefreshToken(client, refresh_token);
    },
  },
];

describe('ParleyOAuthProvider — every TTL is bounded from both sides', () => {
  async function probeAt(c: TtlCase, offsetMs: number): Promise<'usable' | 'refused'> {
    let clock = 1_000_000;
    const p = makeProvider(() => clock);
    const client = makeClient();
    peek(p).clients.set(client.client_id, client);
    const probe = await c.seed(p, client);
    clock += c.ttlMs + offsetMs;
    try {
      await probe();
      return 'usable';
    } catch {
      return 'refused';
    }
  }

  it.each(TTL_CASES.map((c) => [c.name, c]))(
    '%s is usable just before its TTL and refused just after',
    async (_name: string, c: TtlCase) => {
      expect(await probeAt(c, -1000)).toBe('usable');
      expect(await probeAt(c, 1000)).toBe('refused');
    },
  );
});

/**
 * The background sweeper is the only thing bounding these maps in a long-running server, and
 * `pending` is the one an unauthenticated caller can grow. Driving the private `sweep()` directly
 * cannot tell an armed timer from a dead one, so every row here advances a FAKE CLOCK and asserts
 * the store emptied on its own. A store added to the provider should add a row.
 */
interface SweptStore {
  name: string;
  store: keyof Pick<Internals, 'pending' | 'codes' | 'redeeming' | 'access' | 'refresh'>;
  ttlMs: number;
  seed: (p: ParleyOAuthProvider, client: OAuthClientInformationFull) => Promise<void>;
}

const SWEEP_CADENCE_MS = 60_000;

const SWEPT_STORES: SweptStore[] = [
  {
    name: 'a pending owner consent',
    store: 'pending',
    ttlMs: 5 * 60_000,
    seed: async (p, client) => {
      await p.authorize(client, makeParams(), fakeRes());
    },
  },
  {
    name: 'an unredeemed authorization code',
    store: 'codes',
    ttlMs: 60_000,
    seed: async (p, client) => {
      await mintCode(p, client, makeParams());
    },
  },
  {
    name: 'a code whose PKCE challenge was handed out but never redeemed',
    store: 'redeeming',
    ttlMs: 60_000,
    seed: async (p, client) => {
      const code = await mintCode(p, client, makeParams());
      await p.challengeForAuthorizationCode(client, code);
    },
  },
  {
    name: 'an access token',
    store: 'access',
    ttlMs: 60 * 60_000,
    seed: async (p, client) => {
      peek(p).issue(client.client_id, ['mcp'], RESOURCE.href);
    },
  },
  {
    name: 'a refresh token',
    store: 'refresh',
    ttlMs: 30 * 24 * 60 * 60_000,
    seed: async (p, client) => {
      peek(p).issue(client.client_id, ['mcp'], RESOURCE.href);
    },
  },
];

describe('ParleyOAuthProvider — the sweeper is armed, not merely present', () => {
  it.each(SWEPT_STORES.map((s) => [s.name, s]))(
    '%s is evicted by the timer alone, with nothing calling sweep()',
    async (_name: string, s: SweptStore) => {
      vi.useFakeTimers();
      try {
        const p = new ParleyOAuthProvider({
          resource: RESOURCE,
          verifyOwner: async (pass) => pass === GOOD_PASS,
          consentPath: '/parley/consent',
        });
        try {
          const client = makeClient();
          peek(p).clients.set(client.client_id, client);
          await s.seed(p, client);
          expect(peek(p)[s.store].size).toBe(1);

          vi.advanceTimersByTime(s.ttlMs + 2 * SWEEP_CADENCE_MS);

          expect(peek(p)[s.store].size).toBe(0);
        } finally {
          p.stop();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not hold the event loop open while it waits for the next sweep', () => {
    const p = makeProvider(() => 1);
    expect(peek(p).sweepTimer.hasRef?.()).toBe(false);
  });
});

describe('ParleyOAuthProvider — expired state is swept, not left to accumulate', () => {
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

/**
 * Every way an exchange can fail once the code's own client is presenting it. The rule is not
 * "any failure burns the code" — a stranger's failed attempt deliberately does NOT, or anyone who
 * learned a code could deny the owner the token it stands for — so each row states which it is and
 * why, and the ONE surviving row is the foreign-client case. The PKCE step is invisible here: the
 * SDK runs it between challengeForAuthorizationCode and exchangeAuthorizationCode, so remote.test.ts
 * drives the same table over HTTP where that step is inside the system under test.
 */
interface ExchangeFailure {
  name: string;
  attempt: (
    p: ParleyOAuthProvider,
    code: string,
    owner: OAuthClientInformationFull,
  ) => Promise<unknown>;
  codeSurvives: boolean;
}

const EXCHANGE_FAILURES: ExchangeFailure[] = [
  {
    name: 'a redirect_uri that does not match the one consented to',
    attempt: (p, code, owner) =>
      p.exchangeAuthorizationCode(owner, code, undefined, 'https://evil.example/cb'),
    codeSurvives: false,
  },
  {
    name: 'an absent redirect_uri',
    attempt: (p, code, owner) => p.exchangeAuthorizationCode(owner, code, undefined, undefined),
    codeSurvives: false,
  },
  {
    name: 'a resource this AS does not serve',
    attempt: (p, code, owner) =>
      p.exchangeAuthorizationCode(owner, code, undefined, REDIRECT, new URL('https://evil.example/mcp')),
    codeSurvives: false,
  },
  {
    name: 'a foreign client presenting it',
    attempt: (p, code) =>
      p.exchangeAuthorizationCode(makeClient('attacker-client'), code, undefined, REDIRECT),
    codeSurvives: true,
  },
];

describe("ParleyOAuthProvider — a failed exchange by the code's own client leaves nothing replayable", () => {
  it.each(EXCHANGE_FAILURES.map((f) => [f.name, f]))(
    '%s',
    async (_name: string, f: ExchangeFailure) => {
      const p = makeProvider(() => 2_000_000);
      const client = makeClient();
      const code = await mintCode(p, client, makeParams());

      await expect(f.attempt(p, code, client)).rejects.toBeInstanceOf(Error);

      const replay = p.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
      if (f.codeSurvives) {
        await expect(replay).resolves.toMatchObject({ token_type: 'bearer' });
      } else {
        await expect(replay).rejects.toBeInstanceOf(InvalidGrantError);
      }
    },
  );

  it('closes the code once its PKCE challenge has been handed out', async () => {
    const p = makeProvider(() => 2_100_000);
    const client = makeClient();
    const code = await mintCode(p, client, makeParams());

    await expect(p.challengeForAuthorizationCode(client, code)).resolves.toBe('challenge-abc');
    // A second hand-out is how a caller would retry after failing the challenge it was given.
    await expect(p.challengeForAuthorizationCode(client, code)).rejects.toBeInstanceOf(
      InvalidGrantError,
    );
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
    expect(tokens.access_token).toBeTruthy();
  });
});

/**
 * Acceptance is not the whole contract: a credential this AS mints is only as good as its own
 * properties. Nothing else in the suite looks past truthiness, so a minting path shortened to three
 * random bytes, or one that quietly widens the consented scope set, would leave every other row
 * green while handing out a token guessable in seconds or one the owner never approved.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bits of randomness the value actually carries: a v4 UUID spends 6 of its 128, base64url is raw. */
function entropyBits(value: string): number {
  if (UUID_SHAPE.test(value)) return 122;
  return Buffer.from(value, 'base64url').byteLength * 8;
}

interface CredentialKindShape {
  name: string;
  minBits: number;
  mint: (p: ParleyOAuthProvider, client: OAuthClientInformationFull) => Promise<string>;
}

const MINTED_CREDENTIALS: CredentialKindShape[] = [
  {
    name: 'an authorization code',
    minBits: 122,
    mint: (p, client) => mintCode(p, client, makeParams()),
  },
  {
    name: 'an access token',
    minBits: 256,
    mint: async (p, client) => peek(p).issue(client.client_id, ['mcp'], RESOURCE.href).access_token,
  },
  {
    name: 'a refresh token',
    minBits: 256,
    mint: async (p, client) => {
      const rt = peek(p).issue(client.client_id, ['mcp'], RESOURCE.href).refresh_token;
      if (rt === undefined) throw new Error('missing refresh token');
      return rt;
    },
  },
];

describe('ParleyOAuthProvider — every credential this AS mints is unguessable', () => {
  const MINTS = 200;

  it.each(MINTED_CREDENTIALS.map((c) => [c.name, c]))(
    '%s carries its full width of randomness and never repeats',
    async (_name: string, c: CredentialKindShape) => {
      const p = makeProvider(() => 1_100_000);
      const client = makeClient();
      peek(p).clients.set(client.client_id, client);
      const seen = new Set<string>();
      for (let i = 0; i < MINTS; i++) {
        const value = await c.mint(p, client);
        expect(entropyBits(value)).toBeGreaterThanOrEqual(c.minBits);
        seen.add(value);
      }
      expect(seen.size).toBe(MINTS);
    },
  );
});

/**
 * The scope set on the minted token is what the owner was shown on the consent page. The refresh
 * path already pins "may narrow, never widen"; the authorization-code path had no scope assertion
 * at all, so a grant that silently added one would have been invisible.
 */
const CONSENTED_SCOPES: string[][] = [[], ['mcp'], ['mcp', 'parley:read']];

describe('ParleyOAuthProvider — a token carries exactly the scopes that were consented to', () => {
  it.each(CONSENTED_SCOPES.map((s) => [JSON.stringify(s), s]))(
    'code exchange of a consent for %s grants exactly those',
    async (_label: string, scopes: string[]) => {
      const p = makeProvider(() => 1_200_000);
      const client = makeClient();
      const code = await mintCode(p, client, makeParams({ scopes }));

      const tokens = await p.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
      expect(tokens.scope).toBe(scopes.join(' '));
      const info = await p.verifyAccessToken(tokens.access_token);
      expect(info.scopes).toEqual(scopes);
    },
  );

  it.each(CONSENTED_SCOPES.map((s) => [JSON.stringify(s), s]))(
    'refresh rotation of a grant for %s grants exactly those',
    async (_label: string, scopes: string[]) => {
      const p = makeProvider(() => 1_300_000);
      const client = makeClient();
      const rt = peek(p).issue(client.client_id, scopes, RESOURCE.href).refresh_token;
      if (rt === undefined) throw new Error('missing refresh token');

      const tokens = await p.exchangeRefreshToken(client, rt);
      expect(tokens.scope).toBe(scopes.join(' '));
      const info = await p.verifyAccessToken(tokens.access_token);
      expect(info.scopes).toEqual(scopes);
    },
  );
});

/**
 * A deployment constraint that exists only in the implementation is one an operator meets as an
 * outage. Every store here is process-local, which makes the front door single-process and makes a
 * restart a re-consent; the class doc is where that is stated, so adding a sixth store has to
 * update it.
 */
describe('ParleyOAuthProvider — its process-local stores are documented where they are declared', () => {
  const source = readFileSync(fileURLToPath(new URL('oauth-provider.ts', import.meta.url)), 'utf8');
  const classDoc = source.slice(0, source.indexOf('export class ParleyOAuthProvider'));
  const stores = [...source.matchAll(/private readonly (\w+) = new Map/g)].map((m) => m[1]!);

  it('finds the stores to check', () => {
    expect(stores.length).toBeGreaterThanOrEqual(5);
  });

  it.each(stores.map((s) => [s]))('the class doc names %s', (store: string) => {
    expect(classDoc).toContain(`\`${store}\``);
  });

  it.each([
    ['a restart or crash costs the owner a re-consent', /re-?consent/i],
    ['the process cannot be replicated', /replicat/i],
  ])('the class doc states that %s', (_label: string, pattern: RegExp) => {
    expect(classDoc).toMatch(pattern);
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

/**
 * `verifyAccessToken`'s return value becomes `req.auth` on every protected request, so anything
 * mutable in it is a handle on the token store. Pushing a scope onto `info.scopes` used to widen the
 * stored grant permanently — and the refresh-narrowing check reads the same array, so every later
 * rotation carried the injected scope too. One row per mutable field, asserting a second read of the
 * same credential AND a rotation of its grant are unchanged.
 */
interface MutableField {
  name: string;
  mutate: (info: AuthInfo) => void;
}

const MUTABLE_FIELDS: MutableField[] = [
  { name: 'scopes (push)', mutate: (info) => void info.scopes.push('admin') },
  { name: 'scopes (splice)', mutate: (info) => void info.scopes.splice(0, info.scopes.length) },
  {
    name: 'resource (pathname)',
    mutate: (info) => {
      if (info.resource !== undefined) info.resource.pathname = '/elsewhere';
    },
  },
];

describe('ParleyOAuthProvider — nothing it hands out is a handle on its own store', () => {
  it.each(MUTABLE_FIELDS.map((f): [string, MutableField] => [f.name, f]))(
    'mutating %s of an AuthInfo changes neither a re-read nor a rotation',
    async (_name: string, field: MutableField) => {
      const p = makeProvider(() => 5_000_000);
      const client = makeClient();
      const pair = issuePair(p, client);

      const before = await p.verifyAccessToken(pair.access);
      const snapshot = { scopes: [...before.scopes], resource: before.resource?.href };
      expect(snapshot.scopes.length).toBeGreaterThan(0);
      expect(snapshot.resource).toBeTypeOf('string');
      field.mutate(before);

      const after = await p.verifyAccessToken(pair.access);
      expect(after.scopes).toEqual(snapshot.scopes);
      expect(after.resource?.href).toBe(snapshot.resource);

      const rotated = await p.exchangeRefreshToken(client, pair.refresh);
      expect(rotated.scope).toBe(snapshot.scopes.join(' '));
      const info = await p.verifyAccessToken(rotated.access_token);
      expect(info.scopes).toEqual(snapshot.scopes);
      expect(info.resource?.href).toBe(snapshot.resource);
    },
  );

  // The other direction: an array the CALLER still holds. The SDK owns the scopes it passes to
  // exchangeRefreshToken, so storing that array by reference lets the caller edit the grant after
  // the fact — a defect reachable with no access to the provider's internals at all.
  it('an array the caller keeps after exchangeRefreshToken is not the stored grant', async () => {
    const p = makeProvider(() => 5_200_000);
    const client = makeClient();
    const pair = issuePair(p, client);

    const requested = ['mcp'];
    const tokens = await p.exchangeRefreshToken(client, pair.refresh, requested);
    requested.push('admin');

    expect((await p.verifyAccessToken(tokens.access_token)).scopes).toEqual(['mcp']);
    if (tokens.refresh_token === undefined) throw new Error('missing refresh token');
    expect((await p.exchangeRefreshToken(client, tokens.refresh_token)).scope).toBe('mcp');
  });

  it('a widened AuthInfo cannot be laundered through the refresh narrowing check', async () => {
    const p = makeProvider(() => 5_100_000);
    const client = makeClient();
    const pair = issuePair(p, client);

    const info = await p.verifyAccessToken(pair.access);
    info.scopes.push('admin');

    await expect(p.exchangeRefreshToken(client, pair.refresh, ['admin'])).rejects.toBeInstanceOf(
      InvalidScopeError,
    );
  });
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
