import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair, generateSecret, type JWK, type KeyObject } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCEPTED_SIGNING_ALGORITHMS, OidcTokenVerifier } from './oidc-verifier.js';

const AUD = 'parley-mcp';

/**
 * A local IdP with full control of the JOSE header and the claim set — the shared fake-oidc mints
 * only well-formed access tokens, and the axes under test here (token KIND and signing ALGORITHM)
 * live outside its knobs.
 */
interface Signer {
  key: KeyObject | Uint8Array;
  kid: string;
}

let server: Server;
let issuer: string;
const signers = new Map<string, Signer>();

const ASYMMETRIC = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const SYMMETRIC = ['HS256', 'HS384', 'HS512'];

beforeAll(async () => {
  const jwks: JWK[] = [];
  for (const alg of ASYMMETRIC) {
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const kid = randomUUID();
    signers.set(alg, { key: privateKey as KeyObject, kid });
    jwks.push({ ...(await exportJWK(publicKey)), kid, alg, use: 'sig' });
  }
  for (const alg of SYMMETRIC) {
    const secret = (await generateSecret(alg, { extractable: true })) as KeyObject;
    const kid = randomUUID();
    signers.set(alg, { key: secret, kid });
    // Publishing the shared secret is what makes an HS* downgrade reachable at all — the point of
    // the test is that the verifier refuses the algorithm regardless.
    jwks.push({ ...(await exportJWK(secret)), kid, alg, use: 'sig' });
  }

  const app = express();
  app.get('/jwks', (_req, res) => {
    res.json({ keys: jwks });
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no bound port');
  issuer = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

async function mint(
  alg: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const signer = signers.get(alg);
  if (signer === undefined) throw new Error(`no signer for ${alg}`);
  const nowS = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: 'parley-test', preferred_username: 'alice', ...claims })
    .setProtectedHeader({ alg, kid: signer.kid, ...header })
    .setIssuer(issuer)
    .setSubject('owner-sub')
    .setAudience(AUD)
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + 300)
    .sign(signer.key as KeyObject);
}

function verifier(): OidcTokenVerifier {
  return new OidcTokenVerifier({ issuer, audience: AUD, jwksUri: `${issuer}/jwks` });
}

/**
 * Which combination of signals identifies an ID token, stated cell by cell rather than derived —
 * the whole question this predicate answers. `typ` is the normative discriminator for every IdP the
 * README names, so a declared kind decides on its own and the claim-shape signals only speak when no
 * `typ` was stamped at all. That ordering matters both ways: `nonce` is NOT forbidden in an access
 * token (RFC 9068 says nothing about it, and Keycloak put it there for authorization-code flows
 * until v25), so treating it as decisive over a `typ: Bearer` token is a permanent 401 against a
 * real IdP; while for a typ-less IdP it, `at_hash` and `c_hash` are the only thing separating a
 * login receipt from authorization to act on this resource.
 */
const NONCE = { nonce: 'n-0S6_WzA2Mj' };
const AT_HASH = { at_hash: 'kQ5-ByE0nbnI0Vh9GJP7BA' };

const TYP_VALUES: Array<[string, Record<string, unknown>]> = [
  ['no typ at all', {}],
  ['typ Bearer', { typ: 'Bearer' }],
  ['typ ID', { typ: 'ID' }],
  ['typ Refresh', { typ: 'Refresh' }],
];

/** accepted[typ index] for each (nonce, at_hash) combination. */
const KIND_MATRIX: Array<[string, Record<string, unknown>, boolean[]]> = [
  ['neither nonce nor at_hash', {}, [true, true, false, false]],
  ['a nonce', NONCE, [false, true, false, false]],
  ['an at_hash', AT_HASH, [false, true, false, false]],
  ['both nonce and at_hash', { ...NONCE, ...AT_HASH }, [false, true, false, false]],
];

const MATRIX_ROWS = KIND_MATRIX.flatMap(([shapeLabel, shape, verdicts]) =>
  TYP_VALUES.map(
    ([typLabel, typClaims], i): [string, Record<string, unknown>, Record<string, unknown>, boolean] => [
      `${typLabel} carrying ${shapeLabel}`,
      { ...typClaims, ...shape },
      {},
      verdicts[i]!,
    ],
  ),
);

/** Vocabulary the matrix does not vary: casing, the JOSE-header position, and Keycloak's other kinds. */
const KIND_VOCABULARY: Array<[string, Record<string, unknown>, Record<string, unknown>, boolean]> = [
  ['a lower-case typ claim is still an ID token', { typ: 'id' }, {}, false],
  ['a typ in the JOSE header is read too', {}, { typ: 'ID' }, false],
  ['the generic JWT header typ does not overrule the Bearer claim', { typ: 'Bearer' }, { typ: 'JWT' }, true],
  ['a deny-listed claim typ overrules a generic header typ', { typ: 'ID' }, { typ: 'JWT' }, false],
  ['an RFC 9068 header typ is a positive access-token signal', { ...NONCE }, { typ: 'at+jwt' }, true],
  ['a logout token', { typ: 'Logout' }, {}, false],
  ['a serialized ID token', { typ: 'Serialized-ID' }, {}, false],
  ['a typ-less token carrying only a c_hash', { c_hash: 'LDktKdoQak3Pk0cnXxCltA' }, {}, false],
];

describe('OidcTokenVerifier — only an access token is an access token', () => {
  it.each([...MATRIX_ROWS, ...KIND_VOCABULARY])(
    '%s',
    async (_label, claims, header, accepted) => {
      const token = await mint('RS256', claims, header);
      const result = verifier().verifyAccessToken(token);
      if (accepted) {
        await expect(result).resolves.toBeTruthy();
      } else {
        await expect(result).rejects.toBeInstanceOf(InvalidTokenError);
      }
    },
  );
});

describe('OidcTokenVerifier — signing-algorithm policy', () => {
  it.each(ASYMMETRIC.map((a) => [a]))('accepts %s (asymmetric)', async (alg: string) => {
    const token = await mint(alg);
    await expect(verifier().verifyAccessToken(token)).resolves.toBeTruthy();
  });

  it.each(SYMMETRIC.map((a) => [a]))(
    'refuses %s even when the shared secret is in the published JWKS',
    async (alg: string) => {
      const token = await mint(alg);
      await expect(verifier().verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidTokenError);
    },
  );

  // The behavioural rows above cannot tell an allowlist decision from jose declining to hand a
  // symmetric key out of a remote JWKS, so pin the policy itself.
  const ALGORITHM_POLICY: Array<[string, boolean]> = [
    ...ASYMMETRIC.map((a): [string, boolean] => [a, true]),
    ...SYMMETRIC.map((a): [string, boolean] => [a, false]),
    ['none', false],
    ['HS1', false],
    ['RSA1_5', false],
  ];

  it.each(ALGORITHM_POLICY)('the accepted-algorithm set includes %s: %s', (alg, allowed) => {
    expect(ACCEPTED_SIGNING_ALGORITHMS.includes(alg)).toBe(allowed);
  });

  it('accepts no symmetric or unsigned algorithm at all', () => {
    expect(ACCEPTED_SIGNING_ALGORITHMS.filter((a) => /^HS|^none$/i.test(a))).toEqual([]);
  });

  it('refuses an unsigned (alg none) token', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    )}.${Buffer.from(
      JSON.stringify({ iss: issuer, aud: AUD, sub: 'owner-sub', exp: nowS + 300 }),
    ).toString('base64url')}.`;
    await expect(verifier().verifyAccessToken(unsigned)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('OidcVerifierOptions — every option is reachable and load-bearing', () => {
  it('honors the injectable clock rather than wall time', async () => {
    const token = await mint('RS256');
    const wayLater = (): number => Date.now() + 3600_000;
    await expect(
      new OidcTokenVerifier({
        issuer,
        audience: AUD,
        jwksUri: `${issuer}/jwks`,
        now: wayLater,
      }).verifyAccessToken(token),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier().verifyAccessToken(token)).resolves.toBeTruthy();
  });

  it('honors clockSkewS around the injected clock', async () => {
    const token = await mint('RS256');
    const justPast = (): number => Date.now() + 310_000;
    const opts = { issuer, audience: AUD, jwksUri: `${issuer}/jwks`, now: justPast };
    await expect(
      new OidcTokenVerifier({ ...opts, clockSkewS: 1 }).verifyAccessToken(token),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      new OidcTokenVerifier({ ...opts, clockSkewS: 120 }).verifyAccessToken(token),
    ).resolves.toBeTruthy();
  });
});
