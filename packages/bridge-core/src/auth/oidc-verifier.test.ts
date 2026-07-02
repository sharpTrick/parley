import {
  InsufficientScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOidc, type FakeOidc } from '../testing/fake-oidc.js';
import { OidcTokenVerifier, type OidcVerifierOptions } from './oidc-verifier.js';

const AUD = 'https://parley.example.com/mcp';

let idp: FakeOidc;

beforeAll(async () => {
  idp = await startFakeOidc();
});
afterAll(async () => {
  await idp.close();
});

function verifier(overrides: Partial<OidcVerifierOptions> = {}): OidcTokenVerifier {
  return new OidcTokenVerifier({
    issuer: idp.issuer,
    audience: AUD,
    jwksUri: idp.jwksUri,
    ...overrides,
  });
}

describe('OidcTokenVerifier — mandatory checks', () => {
  it('accepts a valid token and maps claims into AuthInfo', async () => {
    const token = await idp.mint({
      aud: AUD,
      scope: 'mcp openid',
      azp: 'claude-connector',
      preferred_username: 'alice',
    });
    const info = await verifier().verifyAccessToken(token);
    expect(info.token).toBe(token);
    expect(info.clientId).toBe('claude-connector');
    expect(info.scopes).toEqual(['mcp', 'openid']);
    expect(info.expiresAt).toBeTypeOf('number');
    expect(info.resource?.href).toBe(new URL(AUD).href);
    expect(info.extra).toMatchObject({
      sub: 'owner-sub',
      preferred_username: 'alice',
      iss: idp.issuer,
    });
  });

  it('accepts aud as an array containing the audience', async () => {
    const token = await idp.mint({ aud: ['account', AUD] });
    await expect(verifier().verifyAccessToken(token)).resolves.toBeTruthy();
  });

  it('reports no resource for a non-URL (fixed-string) audience', async () => {
    const token = await idp.mint({ aud: 'parley-mcp' });
    const info = await verifier({ audience: 'parley-mcp' }).verifyAccessToken(token);
    expect(info.resource).toBeUndefined();
    expect(info.clientId).toBe('fake-client'); // azp default
  });

  it('rejects an expired token beyond skew but accepts one within skew', async () => {
    const expired = await idp.mint({ aud: AUD, expiresInS: -120 });
    await expect(verifier().verifyAccessToken(expired)).rejects.toBeInstanceOf(InvalidTokenError);
    const justExpired = await idp.mint({ aud: AUD, expiresInS: -10 });
    await expect(verifier({ clockSkewS: 30 }).verifyAccessToken(justExpired)).resolves.toBeTruthy();
  });

  it('rejects a not-yet-valid (future nbf) token', async () => {
    const token = await idp.mint({ aud: AUD, notBeforeInS: 120 });
    await expect(verifier().verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects wrong audience, wrong issuer, rogue signature, and garbage', async () => {
    const v = verifier();
    const wrongAud = await idp.mint({ aud: 'someone-else' });
    const wrongIss = await idp.mint({ aud: AUD, issuerOverride: 'http://evil.example' });
    const rogueSig = await idp.mint({ aud: AUD, signWithRogueKey: true });
    for (const bad of [wrongAud, wrongIss, rogueSig, 'not-a-jwt', '']) {
      await expect(v.verifyAccessToken(bad)).rejects.toBeInstanceOf(InvalidTokenError);
    }
  });
});

describe('OidcTokenVerifier — scope + identity gates', () => {
  it('403s (InsufficientScopeError) when required_scope is missing', async () => {
    const token = await idp.mint({ aud: AUD, scope: 'openid' });
    await expect(
      verifier({ requiredScope: 'mcp' }).verifyAccessToken(token),
    ).rejects.toBeInstanceOf(InsufficientScopeError);
  });

  it('passes required_scope when present', async () => {
    const token = await idp.mint({ aud: AUD, scope: 'openid mcp' });
    await expect(verifier({ requiredScope: 'mcp' }).verifyAccessToken(token)).resolves.toBeTruthy();
  });

  it('gates on allowed_subjects', async () => {
    const ok = await idp.mint({ aud: AUD, sub: 'owner-sub' });
    const bad = await idp.mint({ aud: AUD, sub: 'intruder' });
    const v = verifier({ allowedSubjects: ['owner-sub'] });
    await expect(v.verifyAccessToken(ok)).resolves.toBeTruthy();
    await expect(v.verifyAccessToken(bad)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('gates on allowed_usernames (preferred_username), including when absent', async () => {
    const ok = await idp.mint({ aud: AUD, preferred_username: 'alice' });
    const bad = await idp.mint({ aud: AUD, preferred_username: 'mallory' });
    const missing = await idp.mint({ aud: AUD });
    const v = verifier({ allowedUsernames: ['alice'] });
    await expect(v.verifyAccessToken(ok)).resolves.toBeTruthy();
    await expect(v.verifyAccessToken(bad)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(v.verifyAccessToken(missing)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('gates on required_role (realm_access.roles)', async () => {
    const ok = await idp.mint({ aud: AUD, realm_access: { roles: ['parley-owner', 'user'] } });
    const bad = await idp.mint({ aud: AUD, realm_access: { roles: ['user'] } });
    const missing = await idp.mint({ aud: AUD });
    const v = verifier({ requiredRole: 'parley-owner' });
    await expect(v.verifyAccessToken(ok)).resolves.toBeTruthy();
    await expect(v.verifyAccessToken(bad)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(v.verifyAccessToken(missing)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('ANDs multiple gates — all must pass', async () => {
    const v = verifier({
      allowedSubjects: ['owner-sub'],
      allowedUsernames: ['alice'],
      requiredRole: 'parley-owner',
    });
    const allGood = await idp.mint({
      aud: AUD,
      sub: 'owner-sub',
      preferred_username: 'alice',
      realm_access: { roles: ['parley-owner'] },
    });
    await expect(v.verifyAccessToken(allGood)).resolves.toBeTruthy();
    const roleMissing = await idp.mint({ aud: AUD, sub: 'owner-sub', preferred_username: 'alice' });
    await expect(v.verifyAccessToken(roleMissing)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
