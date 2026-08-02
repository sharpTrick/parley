import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type OidcAuthConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startFakeOidc, type FakeOidc, type FakeOidcClaims } from '../testing/fake-oidc.js';
import { createOidcRemoteApp, type OidcRemoteServer } from './oidc-remote.js';
import { OidcTokenVerifier } from './oidc-verifier.js';
import { createRemoteAuthApp } from './remote-auth.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

const jget = async (res: Response): Promise<Record<string, any>> =>
  (await res.json()) as Record<string, any>;

let idp: FakeOidc;
let remote: OidcRemoteServer;
let plugin: FakePlugin;
let origin: string;

function baseCfg(): ParleyConfig {
  return parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
}

/**
 * Delegated OIDC refuses to boot without an identity gate, so supply one matching the fake IdP's
 * default subject unless the case under test brings its own.
 */
function withGate(oidcExtras: Record<string, unknown> = {}): OidcAuthConfig {
  const gated =
    'allowed_subjects' in oidcExtras ||
    'allowed_usernames' in oidcExtras ||
    'required_role' in oidcExtras;
  return {
    clock_skew_s: 30,
    ...(gated ? {} : { allowed_subjects: ['owner-sub'] }),
    ...oidcExtras,
  } as unknown as OidcAuthConfig;
}

/**
 * The oidc config `boot()` will actually pass, with a check that no default survives on top of a
 * key the caller varied: a fixture that re-sets the parameter under test after the spread turns
 * every case that varies it into a case that asserts the default.
 */
function oidcConfigFor(oidcExtras: Record<string, unknown>): OidcAuthConfig {
  const defaults: Record<string, unknown> = { issuer: idp.issuer };
  const effective = { ...defaults, ...(withGate(oidcExtras) as unknown as Record<string, unknown>) };
  for (const key of Object.keys(oidcExtras)) {
    expect(effective[key], `boot() discarded the caller's oidc.${key}`).toEqual(oidcExtras[key]);
  }
  return effective as unknown as OidcAuthConfig;
}

/** Boot a delegated-RS remote app on a free port with the given oidc config extras. */
async function boot(oidcExtras: Record<string, unknown> = {}): Promise<void> {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  plugin = new FakePlugin();
  await plugin.connect({});
  remote = await createOidcRemoteApp(plugin, baseCfg(), {
    publicUrl: new URL(origin),
    oidc: oidcConfigFor(oidcExtras),
  });
  await remote.listen(port);
}

async function mcpClientWithToken(accessToken: string): Promise<Client> {
  const client = new Client({ name: 'claude-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

function postMcp(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Streamable HTTP requires this Accept pair once past the auth middleware.
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

beforeEach(async () => {
  idp = await startFakeOidc();
});

afterEach(async () => {
  await remote.close();
  await plugin.disconnect();
  await idp.close();
});

describe('remote OIDC front door (delegated resource server)', () => {
  it('serves PRM pointing at the EXTERNAL issuer and mirrors its AS metadata', async () => {
    await boot();
    const prm = await jget(await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.resource).toBe(`${origin}/mcp`);
    expect(prm.authorization_servers).toEqual([idp.issuer]);

    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    expect(as.issuer).toBe(idp.issuer);
    expect(as.token_endpoint).toBe(`${idp.issuer}/token`);
  });

  /**
   * A mirror is only useful if it is complete for what it claims to mirror. Parsing the IdP's
   * document through a strict schema STRIPPED `revocation_endpoint` and `introspection_endpoint`
   * before the mirror was built, so a pre-RFC-9728 client discovering the AS through Parley's
   * origin had no revocation endpoint to call — and no way to tell truncation from absence, which
   * is what makes a lossy mirror worse than none.
   *
   * Grade it by SET DIFFERENCE over the RFC 8414 field names, read out of the SDK's own schema, so
   * the assertion covers every field the standard defines rather than the two a spot check names.
   */
  it('mirrors every RFC 8414 field the IdP publishes, not the subset one schema names', async () => {
    await boot();
    const published = await jget(await fetch(`${idp.issuer}/.well-known/openid-configuration`));
    const mirrored = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));

    const rfc8414 = Object.keys(OAuthMetadataSchema.shape);
    const expected = rfc8414.filter((key) => published[key] !== undefined);
    // The fake IdP has to publish more than the required minimum, or this grades nothing.
    expect(expected).toContain('revocation_endpoint');
    expect(expected).toContain('introspection_endpoint');
    expect(expected.length).toBeGreaterThan(8);

    const dropped = expected.filter((key) => mirrored[key] === undefined);
    expect(dropped, 'fields the IdP advertises that Parley silently drops from its mirror').toEqual([]);
    for (const key of expected) expect([key, mirrored[key]]).toEqual([key, published[key]]);
  });

  it('hosts no local AS endpoints (/register and /authorize are 404)', async () => {
    await boot();
    const reg = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'] }),
    });
    expect(reg.status).toBe(404);
    expect((await fetch(`${origin}/authorize?client_id=x`)).status).toBe(404);
  });

  it('rejects unauthenticated /mcp with 401 + WWW-Authenticate → PRM (discovery)', async () => {
    await boot();
    const res = await postMcp();
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www.toLowerCase()).toContain('bearer');
    expect(www).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  it('accepts an IdP-minted token and round-trips post/fetch over MCP', async () => {
    await boot();
    const token = await idp.mint({ aud: `${origin}/mcp` }); // default audience = resource id
    const client = await mcpClientWithToken(token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'parley_fetch_recent',
        'parley_list_users',
        'parley_post',
        'parley_reply',
      ]);
      await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'hi via keycloak' } });
      const res = (await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx' },
      })) as { content: Array<{ text: string }> };
      const out = JSON.parse(res.content[0]!.text) as { messages: Array<{ content: string }> };
      expect(out.messages.map((m) => m.content)).toEqual(['hi via keycloak']);
    } finally {
      await client.close();
    }
  });

  /**
   * A 401 is only half the promise: the SDK echoes `error_description` verbatim into the header and
   * the body, so a refusal that carries its own wording tells the caller how far up the chain it
   * got — that its signature, `iss`, `aud` and the identity gate all passed, and only the last check
   * stopped it. That is a differential oracle over the gate policy. So sweep every deficient bearer
   * the fake can mint, INCLUDING the ones that merely OMIT a claim (a check jose runs only when the
   * claim is present is a check an omission skips, and the 401 then comes from a different layer
   * with a different message), and assert every one of them is refused in exactly the same words.
   */
  it('every rejected bearer gets the same 401 and the same error_description', async () => {
    await boot();
    const aud = `${origin}/mcp`;
    const bad: Array<[string, FakeOidcClaims | string]> = [
      ['expired past the skew', { aud, expiresInS: -120 }],
      ['not yet valid', { aud, notBeforeInS: 600 }],
      ['wrong audience', { aud: 'someone-else' }],
      ['wrong issuer', { aud, issuerOverride: 'http://evil.example' }],
      ['a rogue signature', { aud, signWithRogueKey: true }],
      ['a subject outside the gate', { aud, sub: 'stranger' }],
      ['no exp', { aud, omit: ['exp'] }],
      ['no iat', { aud, omit: ['iat'], sub: 'stranger' }],
      ['no aud', { aud, omit: ['aud'] }],
      ['no iss', { aud, omit: ['iss'] }],
      ['no sub', { aud, omit: ['sub'] }],
      ['not a JWT at all', 'garbage'],
    ];

    const descriptions = new Set<string>();
    for (const [label, claims] of bad) {
      const bearer = typeof claims === 'string' ? claims : await idp.mint(claims);
      const res = await postMcp({ Authorization: `Bearer ${bearer}` });
      expect(res.status, `${label} was not refused`).toBe(401);
      const www = res.headers.get('www-authenticate') ?? '';
      descriptions.add(/error_description="([^"]*)"/.exec(www)?.[1] ?? www);
    }
    expect(bad.length).toBeGreaterThan(8);
    expect([...descriptions]).toHaveLength(1);
  });

  it('enforces required_role end to end (401 without the realm role)', async () => {
    await boot({ required_role: 'parley-owner' });
    const aud = `${origin}/mcp`;
    const noRole = await postMcp({ Authorization: `Bearer ${await idp.mint({ aud })}` });
    expect(noRole.status).toBe(401);
    const withRole = await postMcp({
      Authorization: `Bearer ${await idp.mint({ aud, realm_access: { roles: ['parley-owner'] } })}`,
    });
    expect(withRole.status).toBe(200);
  });

  it('enforces required_scope end to end (403 insufficient_scope) and lists it in PRM', async () => {
    await boot({ required_scope: 'mcp' });
    const aud = `${origin}/mcp`;
    const prm = await jget(await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.scopes_supported).toEqual(['mcp']);
    const noScope = await postMcp({ Authorization: `Bearer ${await idp.mint({ aud })}` });
    expect(noScope.status).toBe(403);
    const withScope = await postMcp({
      Authorization: `Bearer ${await idp.mint({ aud, scope: 'mcp' })}`,
    });
    expect(withScope.status).toBe(200);
  });

  it('honors a fixed-string audience override (the Keycloak mapper pattern)', async () => {
    await boot({ audience: 'parley-mcp' });
    const fixed = await postMcp({ Authorization: `Bearer ${await idp.mint({ aud: 'parley-mcp' })}` });
    expect(fixed.status).toBe(200);
    // A token minted for the resource URL no longer matches the pinned audience.
    const urlAud = await postMcp({ Authorization: `Bearer ${await idp.mint({ aud: `${origin}/mcp` })}` });
    expect(urlAud.status).toBe(401);
  });

  // The IdP mints `iss` in exactly one spelling. Every spelling of the CONFIGURED issuer that this
  // server agrees to boot on must therefore still authorize that token: building the verifier from
  // the configured string instead of the discovery document's canonical issuer is a healthy boot
  // followed by 100% token rejection, which no boot-time check can see.
  const ISSUER_SPELLINGS: Array<[string, string, 'boots' | 'refuses']> = [
    ['exactly as the IdP publishes it', '', 'boots'],
    ['with a trailing slash', '/', 'boots'],
    ['with a doubled trailing slash', '//', 'refuses'],
  ];

  it.each(ISSUER_SPELLINGS)(
    'an issuer configured %s %s',
    async (_label: string, suffix: string, verdict: 'boots' | 'refuses') => {
      const configured = `${idp.issuer}${suffix}`;
      if (verdict === 'refuses') {
        const port = await freePort();
        plugin = new FakePlugin();
        await plugin.connect({});
        await expect(
          createOidcRemoteApp(plugin, baseCfg(), {
            publicUrl: new URL(`http://127.0.0.1:${port}`),
            oidc: { ...withGate(), issuer: configured },
          }),
        ).rejects.toThrow(/OIDC discovery failed/);
        await boot(); // satisfy afterEach
        return;
      }
      await boot({ issuer: configured });
      const res = await postMcp({
        Authorization: `Bearer ${await idp.mint({ aud: `${origin}/mcp` })}`,
      });
      expect(res.status).toBe(200);
    },
  );

  it('enforces the identity gate end to end: a mismatched subject is 401', async () => {
    await boot({ allowed_subjects: ['owner-sub'] });
    const aud = `${origin}/mcp`;
    // Default mint uses sub 'owner-sub' → allowed.
    const ok = await postMcp({ Authorization: `Bearer ${await idp.mint({ aud })}` });
    expect(ok.status).toBe(200);
    // A different realm subject with an otherwise-valid token is rejected.
    const denied = await postMcp({
      Authorization: `Bearer ${await idp.mint({ aud, sub: 'intruder-sub' })}`,
    });
    expect(denied.status).toBe(401);
  });

  it('rejects a discovery jwks_uri off the issuer origin, unless explicitly pinned', async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    plugin = new FakePlugin();
    await plugin.connect({});
    const offOrigin = 'https://cdn.example.com/jwks';
    const discovery = {
      issuer: idp.issuer,
      authorization_endpoint: `${idp.issuer}/authorize`,
      token_endpoint: `${idp.issuer}/token`,
      jwks_uri: offOrigin, // different origin than the issuer
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify(discovery), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    // Discovery-supplied off-origin JWKS → fail closed at boot.
    await expect(
      createOidcRemoteApp(plugin, baseCfg(), {
        publicUrl: new URL(origin),
        oidc: { ...withGate(), issuer: idp.issuer },
        fetchFn,
      }),
    ).rejects.toThrow(/jwks_uri origin/);

    // Explicit config override is the trusted pin (e.g. a CDN-hosted JWKS) → accepted.
    remote = await createOidcRemoteApp(plugin, baseCfg(), {
      publicUrl: new URL(origin),
      oidc: { ...withGate({ jwks_uri: offOrigin }), issuer: idp.issuer },
      fetchFn,
    });
    await remote.listen(port);
    expect(remote.authorizationServer.href).toBe(new URL(idp.issuer).href);
  });

  it('fails fast at boot when the issuer is unreachable', async () => {
    const port = await freePort();
    plugin = new FakePlugin();
    await plugin.connect({});
    const dead = `http://127.0.0.1:${port}`; // nothing listening
    await expect(
      createOidcRemoteApp(plugin, baseCfg(), {
        publicUrl: new URL(`http://127.0.0.1:${port}`),
        oidc: { ...withGate(), issuer: dead },
      }),
    ).rejects.toThrow(/OIDC discovery failed/);
    // Satisfy afterEach.
    remote = await createOidcRemoteApp(plugin, baseCfg(), {
      publicUrl: new URL(`http://127.0.0.1:${await freePort()}`),
      oidc: { ...withGate(), issuer: idp.issuer },
    });
  });
});

/**
 * docs/keycloak-integration.md promises that "every 401 this server emits carries the same error
 * message — an unauthorized caller learns nothing about which check failed or what the gate policy
 * is", and oidc-verifier.ts chooses 401 over 403 for the identity gate for that reason. That is a
 * property of the SET of responses, which no test comparing one rejection to an expected status can
 * see: a distinct gate message told any realm user that their signature, iss, aud and exp all
 * passed and only the policy stopped them. Widen this generator with a new rejection reason and it
 * either shares the surface or fails.
 */
const ALL_GATES = {
  allowed_subjects: ['owner-sub'],
  allowed_usernames: ['alice'],
  required_role: 'parley-owner',
};

const GOOD_CLAIMS = (): FakeOidcClaims => ({
  aud: `${origin}/mcp`,
  sub: 'owner-sub',
  preferred_username: 'alice',
  realm_access: { roles: ['parley-owner'] },
});

/** Each row is the accepted token with exactly ONE thing wrong, so no row can pass on a second
 *  defect it did not mean to introduce. */
const REJECTIONS: Array<[string, () => FakeOidcClaims | string]> = [
  ['a rogue signature', () => ({ ...GOOD_CLAIMS(), signWithRogueKey: true })],
  ['a wrong issuer', () => ({ ...GOOD_CLAIMS(), issuerOverride: 'http://evil.example' })],
  ['a wrong audience', () => ({ ...GOOD_CLAIMS(), aud: 'someone-else' })],
  ['an expired token', () => ({ ...GOOD_CLAIMS(), expiresInS: -600 })],
  ['a not-yet-valid token', () => ({ ...GOOD_CLAIMS(), notBeforeInS: 600 })],
  ['a subject outside allowed_subjects', () => ({ ...GOOD_CLAIMS(), sub: 'stranger-sub' })],
  ['a username outside allowed_usernames', () => ({ ...GOOD_CLAIMS(), preferred_username: 'mallory' })],
  ['a token without required_role', () => ({ ...GOOD_CLAIMS(), realm_access: { roles: ['user'] } })],
  ['a token that is not a JWT at all', () => 'not-a-jwt'],
];

describe('a 401 either tells an unauthorized caller which check failed, or tells them nothing', () => {
  it('emits one and only one response surface across every rejection reason', async () => {
    await boot(ALL_GATES);
    // The rows are one claim away from a token this server ACCEPTS, so each isolates its own check.
    expect((await postMcp({ Authorization: `Bearer ${await idp.mint(GOOD_CLAIMS())}` })).status).toBe(200);

    const surfaces = new Map<string, string[]>();
    for (const [name, claims] of REJECTIONS) {
      const bad = claims();
      const token = typeof bad === 'string' ? bad : await idp.mint(bad);
      const res = await postMcp({ Authorization: `Bearer ${token}` });
      expect(res.status, name).toBe(401);
      const surface = JSON.stringify([
        res.status,
        res.headers.get('www-authenticate'),
        await res.text(),
      ]);
      surfaces.set(surface, [...(surfaces.get(surface) ?? []), name]);
    }
    expect(surfaces.size, `distinguishable 401s: ${JSON.stringify([...surfaces.values()])}`).toBe(1);
  });
});

/**
 * A policy knob is only real where a caller can observe it. `clock_skew_s` is applied inside the
 * verifier, but the SDK's requireBearerAuth re-checks `AuthInfo.expiresAt` against wall-clock with
 * no tolerance of its own — so a verifier-only assertion pins a property no HTTP caller ever sees,
 * and the exp half of the knob can be dead while that assertion stays green. Every row states the
 * verifier's verdict AND the status the wire returns, and the two must agree.
 */
const SKEW_ROWS: Array<[string, number, FakeOidcClaims, number]> = [
  ['exp 10 s ago at the default 30 s tolerance', 30, { expiresInS: -10 }, 200],
  ['exp 120 s ago at 30 s tolerance', 30, { expiresInS: -120 }, 401],
  ['exp 60 s ago at 120 s tolerance', 120, { expiresInS: -60 }, 200],
  ['exp 10 s ago at zero tolerance', 0, { expiresInS: -10 }, 401],
  ['exp 120 s ago at the maximum 300 s tolerance', 300, { expiresInS: -120 }, 200],
  ['nbf 10 s away at the default 30 s tolerance', 30, { notBeforeInS: 10 }, 200],
  ['nbf 120 s away at 30 s tolerance', 30, { notBeforeInS: 120 }, 401],
  ['nbf 60 s away at 120 s tolerance', 120, { notBeforeInS: 60 }, 200],
  ['nbf 10 s away at zero tolerance', 0, { notBeforeInS: 10 }, 401],
  ['nbf 120 s away at the maximum 300 s tolerance', 300, { notBeforeInS: 120 }, 200],
];

describe('clock_skew_s reaches the wire, not just the verifier', () => {
  it.each(SKEW_ROWS)(
    '%s: the verifier and the HTTP front door agree',
    async (_name: string, skewS: number, claims: FakeOidcClaims, status: number) => {
      await boot({ clock_skew_s: skewS });
      const aud = `${origin}/mcp`;
      const token = await idp.mint({ aud, ...claims });

      const verifier = new OidcTokenVerifier({
        issuer: idp.issuer,
        audience: aud,
        jwksUri: idp.jwksUri,
        clockSkewS: skewS,
      });
      const acceptedByVerifier = await verifier.verifyAccessToken(token).then(
        () => true,
        () => false,
      );
      expect(acceptedByVerifier).toBe(status === 200);

      expect((await postMcp({ Authorization: `Bearer ${token}` })).status).toBe(status);
    },
  );
});

describe('createRemoteAuthApp selector', () => {
  it('dispatches auth.mode oidc to the delegated-RS app (no verifyOwner needed)', async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    plugin = new FakePlugin();
    await plugin.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      // An identity gate is mandatory in oidc mode; owner-sub matches the fake IdP's default
      // subject, and this case only checks PRM, so the gate value is otherwise inert.
      auth: { mode: 'oidc', oidc: { issuer: idp.issuer, allowed_subjects: ['owner-sub'] } },
    });
    remote = (await createRemoteAuthApp(plugin, cfg, {
      publicUrl: new URL(origin),
    })) as OidcRemoteServer;
    await remote.listen(port);
    expect(remote.authorizationServer.href).toBe(new URL(idp.issuer).href);
    const prm = await jget(await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.authorization_servers).toEqual([idp.issuer]);
  });

  it('dispatches auth.mode builtin to the built-in AS and requires verifyOwner', async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    plugin = new FakePlugin();
    await plugin.connect({});
    const cfg = baseCfg(); // auth defaults to builtin
    await expect(createRemoteAuthApp(plugin, cfg, { publicUrl: new URL(origin) })).rejects.toThrow(
      /verifyOwner/,
    );
    remote = (await createRemoteAuthApp(plugin, cfg, {
      publicUrl: new URL(origin),
      verifyOwner: async () => true,
    })) as OidcRemoteServer;
    await remote.listen(port);
    // The built-in AS hosts its own registration endpoint — the delegated mode never does.
    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    expect(as.issuer.replace(/\/$/, '')).toBe(origin);
    expect(as.registration_endpoint).toContain(origin);
  });
});
