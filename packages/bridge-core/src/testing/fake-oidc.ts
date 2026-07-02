import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/** Claim/shape knobs for minting test tokens; defaults produce a fully valid token. */
export interface FakeOidcClaims {
  sub?: string;
  aud?: string | string[];
  scope?: string;
  preferred_username?: string;
  realm_access?: { roles: string[] };
  azp?: string;
  /** Seconds until expiry (negative = already expired). Default 300. */
  expiresInS?: number;
  /** Seconds until the token becomes valid (`nbf`). Default: valid now. */
  notBeforeInS?: number;
  /** Mint with a different `iss` (wrong-issuer case). */
  issuerOverride?: string;
  /** Sign with a keypair NOT in the published JWKS (bad-signature case). */
  signWithRogueKey?: boolean;
}

export interface FakeOidc {
  issuer: string;
  jwksUri: string;
  mint(claims?: FakeOidcClaims): Promise<string>;
  close(): Promise<void>;
}

/**
 * A minimal in-process OIDC IdP for testing the delegated-resource-server auth mode without
 * Docker: serves `/.well-known/openid-configuration` + a JWKS, and mints real RS256-signed JWTs.
 * The discovery document carries just enough fields to satisfy the SDK's OAuthMetadataSchema —
 * the authorization/token endpoints are advertised but not implemented (the resource server
 * never calls them).
 */
export async function startFakeOidc(): Promise<FakeOidc> {
  const [signing, rogue] = await Promise.all([
    generateKeyPair('RS256', { extractable: true }),
    generateKeyPair('RS256', { extractable: true }),
  ]);
  const kid = randomUUID();
  const publicJwk: JWK = { ...(await exportJWK(signing.publicKey)), kid, alg: 'RS256', use: 'sig' };

  const app = express();
  let issuer = ''; // known once listening
  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });
  app.get('/jwks', (_req, res) => {
    res.json({ keys: [publicJwk] });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake-oidc: no bound port');
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    async mint(claims: FakeOidcClaims = {}): Promise<string> {
      const nowS = Math.floor(Date.now() / 1000);
      const key = claims.signWithRogueKey === true ? rogue.privateKey : signing.privateKey;
      const jwt = new SignJWT({
        ...(claims.scope !== undefined ? { scope: claims.scope } : {}),
        ...(claims.preferred_username !== undefined
          ? { preferred_username: claims.preferred_username }
          : {}),
        ...(claims.realm_access !== undefined ? { realm_access: claims.realm_access } : {}),
        azp: claims.azp ?? 'fake-client',
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(claims.issuerOverride ?? issuer)
        .setSubject(claims.sub ?? 'owner-sub')
        .setAudience(claims.aud ?? 'parley-mcp')
        .setIssuedAt(nowS)
        .setExpirationTime(nowS + (claims.expiresInS ?? 300));
      if (claims.notBeforeInS !== undefined) jwt.setNotBefore(nowS + claims.notBeforeInS);
      return jwt.sign(key);
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
