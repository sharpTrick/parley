import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { ConsentError } from './oauth-provider.js';
import { ownerVerifierFromPassphrase } from './owner.js';
import { createOAuthRemoteApp, type OAuthRemoteServer } from './remote.js';

const OWNER_PASS = 'correct horse battery staple';
const CLIENT_REDIRECT = 'http://127.0.0.1:9999/callback';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

const b64url = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
// Response.json() is typed `unknown` under our strict tsconfig; this test only reads loose fields.
const jget = async (res: Response): Promise<Record<string, any>> =>
  (await res.json()) as Record<string, any>;

let remote: OAuthRemoteServer;
let plugin: FakePlugin;
let origin: string;

beforeEach(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  plugin = new FakePlugin();
  await plugin.connect({});
  const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
  remote = createOAuthRemoteApp(plugin, cfg, {
    issuerUrl: new URL(origin),
    verifyOwner: ownerVerifierFromPassphrase(OWNER_PASS),
  });
  await remote.listen(port);
});

afterEach(async () => {
  await remote.close();
  await plugin.disconnect();
});

/** Drive the full connector OAuth flow and return tokens. */
async function runOAuthFlow(passphrase = OWNER_PASS) {
  // (a) Protected Resource Metadata (RFC 9728) — note the /mcp suffix on the well-known path.
  const prm = await jget(await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`));
  expect(prm.resource).toBe(`${origin}/mcp`);
  const asUrl = prm.authorization_servers[0] as string;

  // (b) Authorization Server metadata (RFC 8414).
  const as = await jget(await fetch(new URL('/.well-known/oauth-authorization-server', asUrl).href));
  expect(as.code_challenge_methods_supported).toContain('S256');

  // (c) Dynamic Client Registration (RFC 7591) — what Claude's connector uses.
  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Claude (test)',
    }),
  });
  expect(reg.status).toBe(201);
  const client = await jget(reg);
  expect(client.client_id).toBeTruthy();

  // (d) Authorize with PKCE S256 → owner-consent page.
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const authorizeUrl = new URL(as.authorization_endpoint);
  authorizeUrl.search = form({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: `${origin}/mcp`,
    scope: 'mcp',
  });
  const consentHtml = await (await fetch(authorizeUrl.href)).text();
  const consentId = /name="consent_id" value="([^"]+)"/.exec(consentHtml)?.[1];
  expect(consentId).toBeTruthy();

  // (e) Owner approves consent → redirect back with code + state.
  const consentRes = await fetch(`${origin}/parley/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ consent_id: consentId!, passphrase }),
    redirect: 'manual',
  });
  expect(consentRes.status).toBe(302);
  const back = new URL(consentRes.headers.get('location')!);
  expect(back.searchParams.get('state')).toBe(state);
  const code = back.searchParams.get('code');
  expect(code).toBeTruthy();

  // (f) Token exchange (SDK verifies PKCE S256).
  const tokRes = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: CLIENT_REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  expect(tokRes.status).toBe(200);
  const tokens = await jget(tokRes);
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return { client, tokens, asMeta: as };
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

/** Drive DCR + /authorize and scrape the pending consent_id from the rendered consent page. */
async function authorizeToConsentId(): Promise<string> {
  const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
  const reg = await jget(
    await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
    }),
  );
  const { challenge } = pkce();
  const authorizeUrl = new URL(as.authorization_endpoint);
  authorizeUrl.search = form({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${origin}/mcp`,
  });
  const html = await (await fetch(authorizeUrl.href)).text();
  const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
  expect(consentId).toBeTruthy();
  return consentId!;
}

const postConsent = (consentId: string, passphrase: string) =>
  fetch(`${origin}/parley/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ consent_id: consentId, passphrase }),
    redirect: 'manual',
  });

describe('remote OAuth front door (single-tenant)', () => {
  it('rejects unauthenticated /mcp with 401 + WWW-Authenticate → PRM (discovery)', async () => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www.toLowerCase()).toContain('bearer');
    expect(www).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  // The browser-facing OAuth front door must carry anti-clickjacking / hardening headers on
  // EVERY response (app-wide middleware covers /authorize + /parley/consent), and the consent page
  // must lead with the trustworthy redirect ORIGIN, demoting the attacker-controlled client_name to
  // a muted line so a spoofed name ("Claude Desktop") is less convincing.
  it('sets security headers and de-emphasizes client_name on the /authorize consent page', async () => {
    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    const reg = await jget(
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: 'none',
          client_name: 'Claude Desktop',
        }),
      }),
    );
    const { challenge } = pkce();
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.search = form({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      scope: 'mcp',
    });
    const res = await fetch(authorizeUrl.href);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
    const html = await res.text();
    // Leads with the redirect ORIGIN prominently; the client-supplied name is demoted to the muted line.
    const redirectOrigin = new URL(CLIENT_REDIRECT).origin;
    expect(html).toContain(`<strong>${redirectOrigin}</strong>`);
    expect(html).toContain('class="muted">Client-supplied name: Claude Desktop');
  });

  it('completes discovery → DCR → PKCE → owner consent → token, then post/fetch over MCP', async () => {
    const { tokens } = await runOAuthFlow();
    const client = await mcpClientWithToken(tokens.access_token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'parley_fetch_recent',
        'parley_list_users',
        'parley_post',
        'parley_reply',
      ]);
      await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'hi via oauth' } });
      const res = (await client.callTool({
        name: 'parley_fetch_recent',
        arguments: { topic: 'ctx' },
      })) as { content: Array<{ text: string }> };
      const out = JSON.parse(res.content[0]!.text) as { messages: Array<{ content: string }> };
      expect(out.messages.map((m) => m.content)).toEqual(['hi via oauth']);
    } finally {
      await client.close();
    }
  });

  it('rejects a bad bearer token (401)', async () => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses consent with the wrong owner passphrase (403)', async () => {
    // Drive up to the consent POST with a wrong passphrase.
    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    const reg = await jget(
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
      }),
    );
    const { challenge } = pkce();
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.search = form({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
    });
    const html = await (await fetch(authorizeUrl.href)).text();
    const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
    const res = await fetch(`${origin}/parley/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ consent_id: consentId!, passphrase: 'wrong' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  // A wrong guess must CONSUME the pending consent — one-shot consent_id. A second POST
  // with the same consent_id and the CORRECT passphrase must be rejected (not a 302 with a code).
  // Pre-fix, the correct second guess would 302 back with a code; this pins the one-shot delete.
  it('consumes the pending consent on a wrong guess (consent_id is one-shot)', async () => {
    const consentId = await authorizeToConsentId();
    const first = await postConsent(consentId, 'wrong');
    expect(first.status).toBe(403);
    // Retry the SAME consent_id with the correct passphrase — must be rejected, not redirected.
    const second = await postConsent(consentId, OWNER_PASS);
    expect(second.status).toBe(403);
    expect(second.status).not.toBe(302);
    const back = second.headers.get('location');
    expect(back === null || !new URL(back, origin).searchParams.has('code')).toBe(true);
  });

  // The hand-mounted consent route carries its own strict express-rate-limit. Firing
  // limit + 1 POSTs from the same client returns 429 on the final one (per-test app ⇒ fresh counter).
  it('rate-limits /parley/consent (429 past the limit)', async () => {
    const LIMIT = 10;
    let last: Response | undefined;
    for (let i = 0; i < LIMIT + 1; i++) {
      last = await postConsent('nonexistent', 'wrong');
    }
    expect(last!.status).toBe(429);
  });

  // The shared escapeHtml is wired at BOTH consent-flow render sites (the /authorize consent
  // page and the /parley/consent 403 error page). Drive each with a hostile string and assert the
  // served HTML carries escaped entities and no raw markup.
  const HOSTILE = '<script>a&"\'';
  const ESCAPED = '&lt;script&gt;a&amp;&quot;&#39;';

  it('escapes a hostile client_name in the rendered consent page', async () => {
    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    const reg = await jget(
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: 'none',
          client_name: HOSTILE,
        }),
      }),
    );
    const { challenge } = pkce();
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.search = form({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      scope: 'mcp',
    });
    const html = await (await fetch(authorizeUrl.href)).text();
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain('<script>');
  });

  it('escapes a hostile ConsentError message in the 403 owner-consent error page', async () => {
    // Force the consent handler down its ConsentError branch with an attacker-shaped message
    // (the real messages are fixed strings; this proves the 403 render escapes through the shared
    // escapeHtml, not that the message is user-controlled today). Same stub pattern the tools tests
    // use for backend failures.
    remote.provider.completeConsent = () => {
      throw new ConsentError(HOSTILE);
    };
    const res = await fetch(`${origin}/parley/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ consent_id: 'x', passphrase: 'y' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain('<script>');
  });

  it('refresh_token rotation issues a new access token and one-time-uses the old refresh', async () => {
    const { client, tokens, asMeta } = await runOAuthFlow();
    const refreshOnce = () =>
      fetch(asMeta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
          resource: `${origin}/mcp`,
        }),
      });
    const first = await refreshOnce();
    expect(first.status).toBe(200);
    const refreshed = await jget(first);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    // Reusing the now-rotated refresh token must fail.
    const second = await refreshOnce();
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});

describe('remote OAuth front door — credential lifecycle over HTTP', () => {
  const revoke = (endpoint: string, token: string, clientId: string) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token, client_id: clientId }),
    });

  it.each([['access_token'], ['refresh_token']])(
    'revoking the %s at /revoke kills the whole grant, not just the string presented',
    async (kind: string) => {
      const { client, tokens, asMeta } = await runOAuthFlow();
      const mcpClient = await mcpClientWithToken(tokens.access_token);
      await mcpClient.close(); // the token works before revocation

      const res = await revoke(asMeta.revocation_endpoint, tokens[kind], client.client_id);
      expect(res.status).toBe(200);

      const afterAccess = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(afterAccess.status).toBe(401);

      const afterRefresh = await fetch(asMeta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
          resource: `${origin}/mcp`,
        }),
      });
      expect(afterRefresh.status).toBeGreaterThanOrEqual(400);
    },
  );

  it('ignores a revocation from a client the grant was not issued to', async () => {
    const { client, tokens, asMeta } = await runOAuthFlow();
    const attacker = await jget(
      await fetch(asMeta.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    expect(attacker.client_id).not.toBe(client.client_id);

    // RFC 7009: answer 200 regardless, so the endpoint is not a token oracle...
    const res = await revoke(asMeta.revocation_endpoint, tokens.access_token, attacker.client_id);
    expect(res.status).toBe(200);

    // ...but the victim's token is untouched.
    const still = await mcpClientWithToken(tokens.access_token);
    await still.close();
  });

  it('refuses an /authorize for a resource this AS does not serve, before rendering consent', async () => {
    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    const reg = await jget(
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    const { challenge } = pkce();
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.search = form({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://evil.example/mcp',
    });
    const res = await fetch(authorizeUrl.href, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('invalid_target');
    expect(await res.text()).not.toContain('consent_id');
  });

  it('401s a bearer token bound to a different resource (RFC 8707 audience)', async () => {
    const peek = remote.provider as unknown as {
      issue(clientId: string, scopes: string[], resource: string): { access_token: string };
    };
    const foreign = peek.issue('some-client', ['mcp'], 'https://evil.example/mcp').access_token;
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${foreign}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});

/**
 * The same "a failed exchange leaves nothing replayable" table as oauth-provider.test.ts, driven
 * over HTTP so the SDK's PKCE verification — which runs BETWEEN the provider's two code methods and
 * is invisible to a provider-level test — is inside the system under test. Each row states whether
 * a subsequent fully-correct exchange of the same code still works; the one row where it does is the
 * foreign client, because otherwise anyone who learned a code could deny the owner the token it
 * stands for.
 */
interface FailedExchange {
  name: string;
  /** Mutate the otherwise-correct token request. `foreignClientId` is substituted when present. */
  corrupt: (body: Record<string, string>, foreignClientId: string) => Record<string, string>;
  replayable: boolean;
}

const FAILED_EXCHANGES: FailedExchange[] = [
  {
    name: 'a redirect_uri that does not match the one consented to',
    corrupt: (b) => ({ ...b, redirect_uri: 'http://127.0.0.1:9999/other' }),
    replayable: false,
  },
  {
    name: 'an absent redirect_uri',
    corrupt: ({ redirect_uri: _drop, ...b }) => b,
    replayable: false,
  },
  {
    name: 'a code_verifier that does not match the challenge',
    corrupt: (b) => ({ ...b, code_verifier: b64url(randomBytes(32)) }),
    replayable: false,
  },
  {
    name: 'a resource this AS does not serve',
    corrupt: (b) => ({ ...b, resource: 'https://evil.example/mcp' }),
    replayable: false,
  },
  {
    name: 'a foreign client presenting the code',
    corrupt: (b, foreignClientId) => ({ ...b, client_id: foreignClientId }),
    replayable: true,
  },
];

describe('remote OAuth front door — a failed token exchange closes the code', () => {
  it.each(FAILED_EXCHANGES.map((f) => [f.name, f]))(
    '%s',
    async (_name: string, f: FailedExchange) => {
      const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
      const register = async (): Promise<Record<string, any>> =>
        jget(
          await fetch(as.registration_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              redirect_uris: [CLIENT_REDIRECT],
              token_endpoint_auth_method: 'none',
            }),
          }),
        );
      const client = await register();
      const stranger = await register();

      const { verifier, challenge } = pkce();
      const authorizeUrl = new URL(as.authorization_endpoint);
      authorizeUrl.search = form({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: CLIENT_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${origin}/mcp`,
        scope: 'mcp',
      });
      const html = await (await fetch(authorizeUrl.href)).text();
      const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
      const consentRes = await postConsent(consentId!, OWNER_PASS);
      const code = new URL(consentRes.headers.get('location')!).searchParams.get('code')!;

      const correct: Record<string, string> = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLIENT_REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      };
      const exchange = (body: Record<string, string>): Promise<Response> =>
        fetch(as.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form(body),
        });

      const failed = await exchange(f.corrupt({ ...correct }, stranger.client_id));
      expect(failed.status).toBeGreaterThanOrEqual(400);

      const replay = await exchange(correct);
      if (f.replayable) {
        expect(replay.status).toBe(200);
      } else {
        expect(replay.status).toBeGreaterThanOrEqual(400);
        expect((await jget(replay)).error).toBe('invalid_grant');
      }
    },
  );
});

/**
 * Every endpoint of this front door is rate-limited per client address, so the limiter is only a
 * defence if that address is the CLIENT's. Under the shipped recipe (examples/self-host-remote
 * terminates TLS at a reverse proxy) an unconfigured app sees only the proxy's loopback address:
 * one bucket for everyone, which an anonymous attacker can exhaust to lock the owner out of the
 * only path that authorizes the bridge. Assert the keying itself, on every limited route, under
 * both topologies — the single-client 429 case above cannot tell "limited the attacker" from
 * "limited everyone".
 */
interface LimitedRoute {
  name: string;
  hit: (base: string, client: string) => Promise<Response>;
}

const xff = (client: string): Record<string, string> => ({ 'x-forwarded-for': client });

const LIMITED_ROUTES: LimitedRoute[] = [
  {
    name: '/parley/consent',
    hit: (base, client) =>
      fetch(`${base}/parley/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...xff(client) },
        body: form({ consent_id: 'nonexistent', passphrase: 'wrong' }),
        redirect: 'manual',
      }),
  },
  {
    name: '/authorize',
    hit: (base, client) =>
      fetch(`${base}/authorize?client_id=nobody`, { headers: xff(client), redirect: 'manual' }),
  },
  {
    name: '/token',
    hit: (base, client) =>
      fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...xff(client) },
        body: form({ grant_type: 'authorization_code', client_id: 'nobody' }),
      }),
  },
  {
    name: '/register',
    hit: (base, client) =>
      fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...xff(client) },
        body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT] }),
      }),
  },
  {
    name: '/revoke',
    hit: (base, client) =>
      fetch(`${base}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...xff(client) },
        body: form({ token: 'nothing', client_id: 'nobody' }),
      }),
  },
];

interface Topology {
  name: string;
  trustProxy: boolean | string;
  /** Whether two X-Forwarded-For values must land in the SAME bucket under this topology. */
  sharesBucket: boolean;
}

const TOPOLOGIES: Topology[] = [
  // Direct exposure: the header is attacker-controlled noise and must not mint a fresh bucket.
  { name: 'directly exposed', trustProxy: false, sharesBucket: true },
  { name: 'behind one reverse-proxy hop', trustProxy: 'loopback', sharesBucket: false },
];

const ATTACKER = '203.0.113.9';
const OWNER = '198.51.100.4';

describe('a rate limiter must key on the client the operator actually deploys behind', () => {
  let app: OAuthRemoteServer;
  let base: string;

  async function boot(trustProxy?: boolean | string): Promise<void> {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = createOAuthRemoteApp(plugin, parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] }), {
      issuerUrl: new URL(base),
      verifyOwner: ownerVerifierFromPassphrase(OWNER_PASS),
      ...(trustProxy !== undefined ? { trustProxy } : {}),
    });
    await app.listen(port);
  }

  afterEach(async () => {
    await app.close();
  });

  const remaining = (res: Response): number => Number(res.headers.get('ratelimit-remaining'));

  const ROWS = TOPOLOGIES.flatMap((t) =>
    LIMITED_ROUTES.map((r): [string, Topology, LimitedRoute] => [
      `${r.name} when ${t.name}`,
      t,
      r,
    ]),
  );

  it.each(ROWS)('%s', async (_name: string, t: Topology, route: LimitedRoute) => {
    await boot(t.trustProxy);
    const first = remaining(await route.hit(base, ATTACKER));
    const second = remaining(await route.hit(base, OWNER));
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(t.sharesBucket ? first - 1 : first);
  });

  // An operator who never names a topology gets the safe one: an app that took the header on
  // trust by default would be exploitable in exactly the deployment that never configured it.
  it('treats an unconfigured app as directly exposed, not as trusting the header', async () => {
    await boot();
    const first = remaining(await LIMITED_ROUTES[0]!.hit(base, ATTACKER));
    const second = remaining(await LIMITED_ROUTES[0]!.hit(base, OWNER));
    expect(second).toBe(first - 1);
  });

  it('leaves the owner a way in after an anonymous flood, once the proxy hop is declared', async () => {
    await boot('loopback');
    const CONSENT_LIMIT = 10;
    let last: Response | undefined;
    for (let i = 0; i < CONSENT_LIMIT + 1; i++) {
      last = await LIMITED_ROUTES[0]!.hit(base, ATTACKER);
    }
    expect(last!.status).toBe(429);
    expect((await LIMITED_ROUTES[0]!.hit(base, OWNER)).status).toBe(403);
  });
});
