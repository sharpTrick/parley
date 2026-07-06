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

  // SEC-04: the browser-facing OAuth front door must carry anti-clickjacking / hardening headers on
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

  // SEC-01 / D2: a wrong guess must CONSUME the pending consent — one-shot consent_id. A second POST
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

  // SEC-01 / D1: the hand-mounted consent route carries its own strict express-rate-limit. Firing
  // limit + 1 POSTs from the same client returns 429 on the final one (per-test app ⇒ fresh counter).
  it('rate-limits /parley/consent (429 past the limit)', async () => {
    const LIMIT = 10;
    let last: Response | undefined;
    for (let i = 0; i < LIMIT + 1; i++) {
      last = await postConsent('nonexistent', 'wrong');
    }
    expect(last!.status).toBe(429);
  });

  // CX-04: the shared escapeHtml is wired at BOTH consent-flow render sites (the /authorize consent
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
