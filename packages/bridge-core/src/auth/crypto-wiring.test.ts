import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashOwnerSecret, makeOwnerVerifier, type ScryptParams } from './owner.js';
import { ParleyOAuthProvider } from './oauth-provider.js';

/**
 * A security property the code states by CHOOSING a primitive is only that property if the primitive
 * is the one that runs. Behavioural rows cannot see the choice: `actual.equals(expected)` answers
 * every accept and reject exactly as `timingSafeEqual` does and differs only in what it leaks through
 * timing, and a 32-byte value off a non-cryptographic PRNG measures the same width as one off the
 * CSPRNG. So capture what the auth layer asks of node:crypto and assert the call itself — one row per
 * delegation, the same shape oidc-verifier-wiring.test.ts uses for the options handed to jose.
 */
const calls = vi.hoisted(() => ({
  timingSafeEqual: [] as Array<[Buffer, Buffer]>,
  scrypt: [] as Array<{ keylen: number; options: Record<string, unknown> }>,
  randomBytes: [] as number[],
  randomUUID: 0,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Buffer, b: Buffer) => {
      calls.timingSafeEqual.push([a, b]);
      return actual.timingSafeEqual(a, b);
    },
    scrypt: (
      passphrase: string,
      salt: Buffer,
      keylen: number,
      options: Record<string, unknown>,
      cb: unknown,
    ) => {
      calls.scrypt.push({ keylen, options });
      return (actual.scrypt as unknown as (...args: unknown[]) => void)(
        passphrase,
        salt,
        keylen,
        options,
        cb,
      );
    },
    randomBytes: (size: number) => {
      calls.randomBytes.push(size);
      return actual.randomBytes(size);
    },
    randomUUID: () => {
      calls.randomUUID += 1;
      return actual.randomUUID();
    },
  };
});

beforeEach(() => {
  calls.timingSafeEqual.length = 0;
  calls.scrypt.length = 0;
  calls.randomBytes.length = 0;
  calls.randomUUID = 0;
});

const PASS = 'correct horse battery staple';
const RESOURCE = new URL('https://bridge.example/mcp');
const REDIRECT = 'https://app.example/cb';

const CHEAP: ScryptParams = { N: 1024, r: 8, p: 1 };
const maxmemFor = (p: ScryptParams): number => 256 * p.N * p.r + 1024 * 1024;

function fakeRes(): Response {
  const r: Record<string, unknown> = { req: { method: 'GET', query: { redirect_uri: REDIRECT }, body: {} } };
  r.status = () => r;
  r.type = () => r;
  r.send = () => r;
  return r as unknown as Response;
}

/** Mint one grant end to end through the provider's public API. */
async function mintAGrant(): Promise<void> {
  const provider = new ParleyOAuthProvider({
    resource: RESOURCE,
    verifyOwner: async () => true,
    consentPath: '/parley/consent',
    now: () => 1_000_000,
  });
  try {
    const client = { client_id: 'c', redirect_uris: [REDIRECT] } as OAuthClientInformationFull;
    await provider.authorize(
      client,
      { redirectUri: REDIRECT, codeChallenge: 'challenge-abc', scopes: ['mcp'] },
      fakeRes(),
    );
    const consentId = [...(provider as unknown as { pending: Map<string, unknown> }).pending.keys()].at(-1);
    if (consentId === undefined) throw new Error('no pending consent seeded');
    const { redirectUrl } = await provider.completeConsent(consentId, PASS);
    const code = new URL(redirectUrl).searchParams.get('code');
    if (code === null) throw new Error('no code minted');
    await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  } finally {
    provider.stop();
  }
}

interface CryptoDelegation {
  name: string;
  /** Drive the path once. */
  run: () => Promise<void>;
  /** What node:crypto must have been asked for while it ran. */
  assert: () => void;
}

const DELEGATIONS: CryptoDelegation[] = [
  {
    name: 'the owner verifier compares a matching hash with timingSafeEqual, not with an ordinary equality',
    run: async () => {
      expect(await makeOwnerVerifier(hashOwnerSecret(PASS, CHEAP))(PASS)).toBe(true);
    },
    assert: () => {
      expect(calls.timingSafeEqual).toHaveLength(1);
      const [actual, expected] = calls.timingSafeEqual[0]!;
      expect(actual).toHaveLength(32);
      expect(expected).toHaveLength(32);
      expect(actual.equals(expected)).toBe(true);
    },
  },
  {
    name: 'the owner verifier compares a MISMATCHING hash with timingSafeEqual too',
    run: async () => {
      expect(await makeOwnerVerifier(hashOwnerSecret(PASS, CHEAP))('wrong')).toBe(false);
    },
    assert: () => {
      expect(calls.timingSafeEqual).toHaveLength(1);
      const [actual, expected] = calls.timingSafeEqual[0]!;
      expect(actual).toHaveLength(32);
      expect(expected).toHaveLength(32);
      expect(actual.equals(expected)).toBe(false);
    },
  },
  {
    name: 'the owner verifier derives off the event loop, at the cost the stored record names',
    run: async () => {
      const stored = hashOwnerSecret(PASS, CHEAP);
      calls.scrypt.length = 0; // the write above derives too; only the verify path is under test
      await makeOwnerVerifier(stored)(PASS);
    },
    assert: () => {
      expect(calls.scrypt).toEqual([{ keylen: 32, options: { ...CHEAP, maxmem: maxmemFor(CHEAP) } }]);
    },
  },
  {
    name: 'the provider mints its bearer tokens from randomBytes(32), not from a bare PRNG',
    run: mintAGrant,
    assert: () => {
      expect(calls.randomBytes).toEqual([32, 32]);
    },
  },
  {
    name: 'the provider mints its consent id, authorization code and grant id from randomUUID',
    run: mintAGrant,
    assert: () => {
      expect(calls.randomUUID).toBe(3);
    },
  },
];

describe('the auth layer reaches the crypto primitive its policy names', () => {
  it.each(DELEGATIONS.map((d) => [d.name, d]))(
    '%s',
    async (_name: string, delegation: CryptoDelegation) => {
      await delegation.run();
      delegation.assert();
    },
  );
});
