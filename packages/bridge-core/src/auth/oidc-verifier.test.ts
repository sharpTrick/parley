import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * A claim this class's contract says it enforces, ABSENT from the token, is a check that never runs:
 * jose validates `exp`/`nbf`/`iss`/`aud` only when the claim is present, so an omission is a
 * different code path from a wrong value and no wrong-value row can reach it. Grade every registered
 * claim the fake can stamp — the row set is DERIVED from a minted token, so a claim the fake starts
 * carrying arrives as a missing row rather than as silence — and then grade the second half of the
 * defect: whatever refuses must refuse with the ONE message, or the refusal tells a caller how far
 * up the chain it got.
 */
describe('OidcTokenVerifier — a claim that is absent is still a claim that is checked', () => {
  /** RFC 7519's registered claim names — the ones a token carries as protocol, not as payload. */
  const REGISTERED = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'] as const;
  /** What the shared fake can be told to leave out. A registered claim it stamps but cannot omit
   *  fails the coverage row below, which is the signal to widen the knob rather than to skip it. */
  type Omittable = NonNullable<FakeOidcClaims['omit']>[number];

  /** The single-tenant posture the delegated mode is documented for: an identity gate is configured. */
  const GATED: Partial<OidcVerifierOptions> = { allowedSubjects: ['owner-sub'] };
  /** Every registered claim the fake stamps, so `nbf` is present and can be omitted from something. */
  const FULL: FakeOidcClaims = { aud: AUD, notBeforeInS: -60 };

  const ABSENT: ReadonlyArray<readonly [Omittable, 'accepted' | 'refused']> = [
    ['iss', 'refused'],
    ['sub', 'refused'],
    ['aud', 'refused'],
    ['exp', 'refused'],
    ['nbf', 'accepted'],
    ['iat', 'accepted'],
  ] as const;

  const claimsOf = (jwt: string): string[] =>
    Object.keys(
      JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as object,
    );

  it('has a row for every registered claim a full token carries', async () => {
    const carried = claimsOf(await idp.mint(FULL)).filter((c) =>
      (REGISTERED as readonly string[]).includes(c),
    );
    expect(carried.length).toBeGreaterThan(3);
    expect(ABSENT.map(([claim]) => claim).sort()).toEqual(carried.sort());
  });

  it.each(ABSENT.map(([claim, verdict]) => [claim, verdict] as const))(
    'a token carrying no %s is %s',
    async (claim: Omittable, verdict: string) => {
      const token = await idp.mint({ ...FULL, omit: [claim] });
      expect(claimsOf(token)).not.toContain(claim);
      const attempt = verifier(GATED).verifyAccessToken(token);
      if (verdict === 'accepted') await expect(attempt).resolves.toBeTruthy();
      else await expect(attempt).rejects.toBeInstanceOf(InvalidTokenError);
    },
  );

  it('every refusal — absent claim, wrong value or garbage — is byte-identical', async () => {
    const deficient: ReadonlyArray<readonly [string, () => Promise<string>]> = [
      ...ABSENT.filter(([, verdict]) => verdict === 'refused').map(
        ([claim]) => [`no ${claim}`, () => idp.mint({ ...FULL, omit: [claim] })] as const,
      ),
      ['expired past the skew', () => idp.mint({ aud: AUD, expiresInS: -120 })],
      ['not yet valid', () => idp.mint({ aud: AUD, notBeforeInS: 120 })],
      ['wrong audience', () => idp.mint({ aud: 'someone-else' })],
      ['wrong issuer', () => idp.mint({ aud: AUD, issuerOverride: 'http://evil.example' })],
      ['a rogue signature', () => idp.mint({ aud: AUD, signWithRogueKey: true })],
      ['a subject outside the gate', () => idp.mint({ aud: AUD, sub: 'stranger' })],
      ['not a JWT at all', () => Promise.resolve('garbage')],
    ] as const;

    const messages = new Set<string>();
    for (const [label, mint] of deficient) {
      const err: unknown = await verifier(GATED)
        .verifyAccessToken(await mint())
        .then(() => null, (e: unknown) => e);
      expect(err, `${label} was accepted`).toBeInstanceOf(InvalidTokenError);
      messages.add((err as Error).message);
    }
    expect(deficient.length).toBeGreaterThan(6);
    expect([...messages]).toHaveLength(1);
  });
});

/**
 * The HTTP-level cardinality check in oidc-remote.test.ts can only reach rejection reasons the
 * shared fake IdP can mint — the ID-token/`typ` branch is not one of them. Reading the source
 * covers every branch there is, including one added tomorrow to a check nothing here can drive.
 */
describe('OidcTokenVerifier — no rejection branch may invent its own message', () => {
  const source = readFileSync(fileURLToPath(new URL('./oidc-verifier.ts', import.meta.url)), 'utf8');

  it('throws InvalidTokenError from more than one place', () => {
    expect([...source.matchAll(/new InvalidTokenError\(/g)].length).toBeGreaterThan(1);
  });

  it('constructs every InvalidTokenError from the single shared message constant', () => {
    const args = [...source.matchAll(/new InvalidTokenError\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(args.length).toBeGreaterThan(0);
    expect([...new Set(args)]).toEqual(['REJECTION_MESSAGE']);
  });
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
