import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeOidc, type FakeOidc } from '../testing/fake-oidc.js';
import { ACCEPTED_SIGNING_ALGORITHMS, OidcTokenVerifier } from './oidc-verifier.js';

/**
 * A policy the verifier expresses as a constant is only a policy if it reaches jose. Behavioural
 * rows cannot see this one: jose already declines to hand a symmetric key out of a remote JWKS, so
 * every HS* case stays green with the allowlist deleted from the call. Capture the options the
 * verifier actually hands to `jwtVerify` and assert the whole set, so that a dropped, widened or
 * newly added option is a failure rather than a silent policy change.
 */
const spy = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: (token: never, key: never, options: Record<string, unknown>) => {
      spy.calls.push(options);
      return actual.jwtVerify(token, key, options as never);
    },
  };
});

const AUD = 'https://parley.example.com/mcp';
const FIXED_NOW_MS = 1_800_000_000_000;

let idp: FakeOidc;

beforeAll(async () => {
  idp = await startFakeOidc();
});
afterAll(async () => {
  await idp.close();
});
beforeEach(() => {
  spy.calls.length = 0;
});

interface WiringCase {
  name: string;
  extras: Record<string, unknown>;
  /** Every option expected alongside `issuer`, which is only known once the fake IdP is bound. */
  expected: Record<string, unknown>;
}

const WIRING_CASES: WiringCase[] = [
  {
    name: 'the defaults',
    extras: {},
    expected: {
      audience: AUD,
      algorithms: ACCEPTED_SIGNING_ALGORITHMS,
      requiredClaims: ['exp'],
      clockTolerance: 30,
    },
  },
  {
    name: 'an explicit skew and an injected clock',
    extras: { clockSkewS: 120, now: () => FIXED_NOW_MS },
    expected: {
      audience: AUD,
      algorithms: ACCEPTED_SIGNING_ALGORITHMS,
      requiredClaims: ['exp'],
      clockTolerance: 120,
      currentDate: new Date(FIXED_NOW_MS),
    },
  },
];

describe('OidcTokenVerifier — the options handed to jose are exactly the declared policy', () => {
  it.each(WIRING_CASES.map((c) => [c.name, c]))('under %s', async (_name: string, c: WiringCase) => {
    const verifier = new OidcTokenVerifier({
      issuer: idp.issuer,
      audience: AUD,
      jwksUri: idp.jwksUri,
      ...c.extras,
    });
    // A clock injected far from the token's validity window rejects, which is beside the point
    // here: the assertion is on what was asked of jose, not on the answer.
    await verifier.verifyAccessToken(await idp.mint({ aud: AUD })).catch(() => undefined);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toEqual({ ...c.expected, issuer: idp.issuer });
  });
});
