import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startFakeOidc, type FakeOidc, type FakeOidcClaims } from '../testing/fake-oidc.js';
import { createOidcRemoteApp, type OidcRemoteServer } from './oidc-remote.js';
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

/** Boot a delegated-RS remote app on a free port with the given oidc config extras. */
async function boot(oidcExtras: Record<string, unknown> = {}): Promise<void> {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  plugin = new FakePlugin();
  await plugin.connect({});
  remote = await createOidcRemoteApp(plugin, baseCfg(), {
    publicUrl: new URL(origin),
    oidc: { issuer: idp.issuer, clock_skew_s: 30, ...oidcExtras },
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

  it('rejects expired / wrong-aud / wrong-iss / rogue-signature tokens over HTTP (401)', async () => {
    await boot();
    const bad: FakeOidcClaims[] = [
      { aud: `${origin}/mcp`, expiresInS: -120 },
      { aud: 'someone-else' },
      { aud: `${origin}/mcp`, issuerOverride: 'http://evil.example' },
      { aud: `${origin}/mcp`, signWithRogueKey: true },
    ];
    for (const claims of bad) {
      const res = await postMcp({ Authorization: `Bearer ${await idp.mint(claims)}` });
      expect(res.status).toBe(401);
    }
    expect((await postMcp({ Authorization: 'Bearer garbage' })).status).toBe(401);
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

  it('authorizes valid tokens when the configured issuer has a trailing slash (BUG-24)', async () => {
    // Issuer configured WITH a trailing slash; the fake IdP mints `iss` WITHOUT one. The verifier
    // must be built from the discovery document's canonical issuer, or jose's exact `iss` match
    // rejects every token (healthy boot, 100% token rejection).
    await boot({ issuer: `${idp.issuer}/` });
    const res = await postMcp({ Authorization: `Bearer ${await idp.mint({ aud: `${origin}/mcp` })}` });
    expect(res.status).toBe(200);
  });

  it('enforces the identity gate end to end: a mismatched subject is 401 (SEC-05)', async () => {
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

  it('rejects a discovery jwks_uri off the issuer origin, unless explicitly pinned (SEC-19)', async () => {
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
        oidc: { issuer: idp.issuer, clock_skew_s: 30 },
        fetchFn,
      }),
    ).rejects.toThrow(/jwks_uri origin/);

    // Explicit config override is the trusted pin (e.g. a CDN-hosted JWKS) → accepted.
    remote = await createOidcRemoteApp(plugin, baseCfg(), {
      publicUrl: new URL(origin),
      oidc: { issuer: idp.issuer, clock_skew_s: 30, jwks_uri: offOrigin },
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
        oidc: { issuer: dead, clock_skew_s: 30 },
      }),
    ).rejects.toThrow(/OIDC discovery failed/);
    // Satisfy afterEach.
    remote = await createOidcRemoteApp(plugin, baseCfg(), {
      publicUrl: new URL(`http://127.0.0.1:${await freePort()}`),
      oidc: { issuer: idp.issuer, clock_skew_s: 30 },
    });
  });
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
      // SEC-05: an identity gate is now mandatory for oidc mode. owner-sub matches the fake
      // IdP's default subject; this test only checks PRM, so the gate value is otherwise inert.
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
