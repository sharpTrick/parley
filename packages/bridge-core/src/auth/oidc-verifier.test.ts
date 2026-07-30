import {
  InsufficientScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOidc, type FakeOidc, type FakeOidcClaims } from '../testing/fake-oidc.js';
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

/**
 * Every gate is an EXACT membership test, and exactness is the whole of the single-tenant posture:
 * widen any of these comparisons to a prefix, suffix, substring, case-insensitive or trimmed match
 * and a stranger who happens to share a realm gets full bridge access. A negative built from an
 * unrelated string ('intruder', 'mallory') cannot see that widening, so every negative below is
 * DERIVED from the allowed value — one candidate per way a comparison can loosen.
 */
interface Gate {
  kind: string;
  allowed: string;
  options: Partial<OidcVerifierOptions>;
  /** A token whose gated claim carries `candidate`, otherwise fully valid. */
  claims: (candidate: string) => FakeOidcClaims;
  /** A token with the gated claim absent entirely, where one is mintable. */
  absent?: FakeOidcClaims;
  rejection: typeof InvalidTokenError | typeof InsufficientScopeError;
  /**
   * Whether surrounding whitespace discriminates. `scope` is a space-separated list, so " mcp"
   * carries the scope `mcp` and must be ACCEPTED — a padded row there would assert the opposite.
   */
  paddingDiscriminates: boolean;
}

const GATES: Gate[] = [
  {
    kind: 'allowed_subjects',
    allowed: 'owner-sub',
    options: { allowedSubjects: ['owner-sub'] },
    claims: (sub) => ({ aud: AUD, sub }),
    rejection: InvalidTokenError,
    paddingDiscriminates: true,
  },
  {
    kind: 'allowed_usernames',
    allowed: 'alice',
    options: { allowedUsernames: ['alice'] },
    claims: (preferred_username) => ({ aud: AUD, preferred_username }),
    absent: { aud: AUD },
    rejection: InvalidTokenError,
    paddingDiscriminates: true,
  },
  {
    kind: 'required_role',
    allowed: 'parley-owner',
    options: { requiredRole: 'parley-owner' },
    claims: (role) => ({ aud: AUD, realm_access: { roles: [role, 'user'] } }),
    absent: { aud: AUD },
    rejection: InvalidTokenError,
    paddingDiscriminates: true,
  },
  {
    kind: 'required_scope',
    allowed: 'mcp',
    options: { requiredScope: 'mcp' },
    claims: (scope) => ({ aud: AUD, scope: `openid ${scope}`.trimEnd() }),
    absent: { aud: AUD },
    rejection: InsufficientScopeError,
    paddingDiscriminates: false,
  },
];

/** One near miss per widening a membership test can suffer, derived from the allowed value. */
function nearMisses(allowed: string, paddingDiscriminates: boolean): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['a longer value with the allowed one as its prefix', `${allowed}-attacker`],
    ['a longer value with the allowed one as its suffix', `attacker-${allowed}`],
    ['a longer value CONTAINING the allowed one', `attacker-${allowed}-x`],
    ['a value the allowed one has as its prefix', allowed.slice(0, -1)],
    ['the allowed value in another case', allowed.toUpperCase()],
    ['the empty string', ''],
  ];
  if (paddingDiscriminates) {
    rows.push(
      ['the allowed value with a leading space', ` ${allowed}`],
      ['the allowed value with a trailing space', `${allowed} `],
    );
  }
  return rows;
}

describe('OidcTokenVerifier — an identity gate is an exact match, not a resemblance', () => {
  it.each(GATES.map((g) => [g.kind, g]))(
    '%s admits exactly the configured value',
    async (_kind: string, gate: Gate) => {
      const token = await idp.mint(gate.claims(gate.allowed));
      await expect(verifier(gate.options).verifyAccessToken(token)).resolves.toBeTruthy();
    },
  );

  const NEAR_MISS_ROWS = GATES.flatMap((gate) =>
    nearMisses(gate.allowed, gate.paddingDiscriminates).map(
      ([label, candidate]): [string, Gate, string] => [
        `${gate.kind} refuses ${label} (${JSON.stringify(candidate)})`,
        gate,
        candidate,
      ],
    ),
  );

  it.each(NEAR_MISS_ROWS)('%s', async (_name: string, gate: Gate, candidate: string) => {
    expect(candidate).not.toBe(gate.allowed);
    const token = await idp.mint(gate.claims(candidate));
    await expect(verifier(gate.options).verifyAccessToken(token)).rejects.toBeInstanceOf(
      gate.rejection,
    );
  });

  const ABSENT_ROWS = GATES.filter((g) => g.absent !== undefined).map(
    (g): [string, Gate] => [g.kind, g],
  );

  it.each(ABSENT_ROWS)(
    '%s refuses a token that omits the claim entirely',
    async (_kind: string, gate: Gate) => {
      const token = await idp.mint(gate.absent!);
      await expect(verifier(gate.options).verifyAccessToken(token)).rejects.toBeInstanceOf(
        gate.rejection,
      );
    },
  );
});

describe('OidcTokenVerifier — scope + identity gates', () => {
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
