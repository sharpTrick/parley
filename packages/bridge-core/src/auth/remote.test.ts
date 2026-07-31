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
async function runOAuthFlow(scope = 'mcp') {
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
    scope,
  });
  const consentHtml = await (await fetch(authorizeUrl.href)).text();
  const consentId = /name="consent_id" value="([^"]+)"/.exec(consentHtml)?.[1];
  expect(consentId).toBeTruthy();

  // (e) Owner approves consent → redirect back with code + state.
  const consentRes = await fetch(`${origin}/parley/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ consent_id: consentId!, passphrase: OWNER_PASS }),
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
  const tokens = await jget(tokRes.clone());
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return { client, tokens, asMeta: as, tokenRes: tokRes };
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
 * A client with exactly ONE registered redirect URI may legally omit `redirect_uri` at both hops
 * (RFC 6749 §4.1.3 requires it at /token only if it was present at /authorize). The SDK defaults it
 * at /authorize and forwards `undefined` at /token, so a provider that binds it unconditionally
 * refuses the exchange AFTER the owner has consented and the code is spent — with a generic
 * invalid_grant as the whole diagnostic. Driven over HTTP because the flag distinguishing the two
 * cases is only readable from the real request.
 */
describe('a conformant client that never names its redirect_uri', () => {
  it('completes the flow with redirect_uri omitted at /authorize and at /token', async () => {
    const as = await jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));
    const reg = await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(reg.status).toBe(201);
    const client = await jget(reg);

    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString('hex');
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.search = form({
      response_type: 'code',
      client_id: client.client_id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: `${origin}/mcp`,
      scope: 'mcp',
    });
    const consentHtml = await (await fetch(authorizeUrl.href)).text();
    const consentId = /name="consent_id" value="([^"]+)"/.exec(consentHtml)?.[1];
    expect(consentId).toBeTruthy();

    const consentRes = await fetch(`${origin}/parley/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ consent_id: consentId!, passphrase: OWNER_PASS }),
      redirect: 'manual',
    });
    expect(consentRes.status).toBe(302);
    const back = new URL(consentRes.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    const code = back.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokRes = await fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code: code!,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    });
    expect(tokRes.status).toBe(200);
    expect((await jget(tokRes)).access_token).toBeTruthy();
  });
});

/** Register a client by DCR, returning the parsed body and the raw response. */
async function dcr(
  as: Record<string, any>,
  metadata: Record<string, unknown> = {},
): Promise<{ res: Response; body: Record<string, any> }> {
  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      ...metadata,
    }),
  });
  return { res, body: await jget(res) };
}

const asMetadata = async (): Promise<Record<string, any>> =>
  jget(await fetch(`${origin}/.well-known/oauth-authorization-server`));

function authorizeRequest(
  as: Record<string, any>,
  clientId: string,
  overrides: Record<string, string | undefined> = {},
): Promise<Response> {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    resource: `${origin}/mcp`,
    scope: 'mcp',
    ...overrides,
  };
  const url = new URL(as.authorization_endpoint);
  url.search = form(
    Object.fromEntries(
      Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
    ),
  );
  return fetch(url.href, { redirect: 'manual' });
}

/** The OAuth error code the AS answered with — from the error redirect or the JSON body. */
async function oauthErrorOf(res: Response): Promise<{ code: string | number; body: string }> {
  const body = await res.text();
  const location = res.headers.get('location');
  if (location !== null) {
    const code = new URL(location, origin).searchParams.get('error');
    if (code !== null) return { code, body };
  }
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    const code = (JSON.parse(body) as { error?: string }).error;
    if (code !== undefined) return { code, body };
  }
  return { code: res.status, body };
}

/**
 * Every value this AS advertises in its metadata is a promise about what it will accept, and a
 * promise it does not enforce is worse than one it never made: `scopes_supported: ["mcp"]` beside an
 * /authorize that grants `bogus-admin` puts an unadvertised scope in the token response AND renders
 * the attacker's string as prose on the owner's approval page. Each row reads the advertised set out
 * of the LIVE document, so a value added there tomorrow is covered the day it lands.
 */
interface MetadataPromise {
  name: string;
  metadataKey: string;
  unadvertised: string;
  drive: (as: Record<string, any>, clientId: string, value: string) => Promise<Response>;
  /** The OAuth error code this AS answers with — asserted so a silent acceptance cannot pass. */
  refusal: string;
}

const METADATA_PROMISES: MetadataPromise[] = [
  {
    name: 'a scope outside scopes_supported',
    metadataKey: 'scopes_supported',
    unadvertised: 'bogus-admin',
    drive: (as, clientId, value) => authorizeRequest(as, clientId, { scope: `mcp ${value}` }),
    refusal: 'invalid_scope',
  },
  {
    name: 'a PKCE method outside code_challenge_methods_supported',
    metadataKey: 'code_challenge_methods_supported',
    unadvertised: 'plain',
    drive: (as, clientId, value) =>
      authorizeRequest(as, clientId, { code_challenge_method: value }),
    refusal: 'invalid_request',
  },
  {
    name: 'a response_type outside response_types_supported',
    metadataKey: 'response_types_supported',
    unadvertised: 'token',
    drive: (as, clientId, value) => authorizeRequest(as, clientId, { response_type: value }),
    refusal: 'invalid_request',
  },
  {
    name: 'a grant_type outside grant_types_supported',
    metadataKey: 'grant_types_supported',
    unadvertised: 'password',
    drive: (as, clientId, value) =>
      fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: value, client_id: clientId }),
      }),
    refusal: 'unsupported_grant_type',
  },
];

describe('a value this AS advertises is a value it enforces', () => {
  it.each(METADATA_PROMISES.map((p) => [p.name, p]))(
    '%s is refused with an OAuth error, never honoured',
    async (_name: string, promise: MetadataPromise) => {
      const as = await asMetadata();
      const advertised = as[promise.metadataKey] as string[];
      expect(advertised, `${promise.metadataKey} is not advertised at all`).toBeInstanceOf(Array);
      // A row whose value has since been advertised is testing nothing; fail loudly rather than pass.
      expect(advertised).not.toContain(promise.unadvertised);

      const { body: client } = await dcr(as);
      const res = await promise.drive(as, client.client_id, promise.unadvertised);

      const { code, body } = await oauthErrorOf(res);
      expect(code).toBe(promise.refusal);
      expect(body).not.toContain('consent_id');
    },
  );
});

/**
 * The consent page leads with the redirect target because it is the one thing on it the client
 * cannot choose freely — so it must stay readable for every redirect_uri that can reach it.
 * `new URL(uri).origin` is the literal string 'null' for every non-special scheme, which collapses
 * that signal exactly where the owner needs it and leaves the attacker-supplied client_name as the
 * only identity on the page.
 */
interface RedirectRendering {
  name: string;
  redirectUri: string;
  /** A substring uniquely derived from the URI that the identity line must carry. */
  identity: string;
  /** Material the URI carries that must NOT reach the page. */
  absent?: string;
}

const REDIRECT_CORPUS: RedirectRendering[] = [
  { name: 'an https URL', redirectUri: 'https://app.example/cb', identity: 'https://app.example' },
  {
    name: 'an http loopback URL',
    redirectUri: 'http://127.0.0.1:9999/callback',
    identity: 'http://127.0.0.1:9999',
  },
  { name: 'a native-app custom scheme', redirectUri: 'myapp://cb', identity: 'myapp://cb' },
  {
    name: 'a javascript: URI',
    redirectUri: 'javascript:alert(1)',
    identity: 'javascript:alert(1)',
  },
  { name: 'a data: URI', redirectUri: 'data:text/plain,hi', identity: 'data:text/plain,hi' },
  {
    name: 'an IPv6 literal host',
    redirectUri: 'http://[::1]:8080/cb',
    identity: 'http://[::1]:8080',
  },
  {
    name: 'a userinfo-bearing URL',
    redirectUri: 'https://user:hunter2@app.example/cb',
    identity: 'https://app.example',
    absent: 'hunter2',
  },
  {
    name: 'a unicode host',
    redirectUri: 'https://exämple.test/cb',
    identity: 'https://xn--exmple-cua.test',
  },
  // The scheme denylist stops javascript:/data:, but any other opaque scheme registers, and WHATWG
  // URL leaves < > " & ' untouched in an opaque path — so this line is a stored-XSS sink on the very
  // page the owner types the passphrase into unless it is escaped.
  {
    name: 'a custom scheme carrying a tag breakout',
    redirectUri: 'myapp:"><script>alert(1)</script>',
    identity: 'myapp:&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    absent: '<script>alert(1)</script>',
  },
  {
    name: 'a custom scheme carrying an ampersand and a quote',
    redirectUri: "myapp:cb?a=1&b='2",
    identity: 'myapp:cb?a=1&amp;b=&#39;2',
    absent: "b='2",
  },
  {
    name: 'a custom scheme carrying a closing tag',
    redirectUri: 'myapp:</strong><img/src=x/onerror=alert(1)>',
    identity: 'myapp:&lt;/strong&gt;&lt;img/src=x/onerror=alert(1)&gt;',
    absent: '<img/src=x',
  },
];

describe('the consent page names the redirect target for every URI that reaches it', () => {
  it.each(REDIRECT_CORPUS.map((r) => [r.name, r]))(
    '%s is either refused or rendered as itself, never as the literal null',
    async (_name: string, row: RedirectRendering) => {
      const as = await asMetadata();
      const { res: regRes, body: client } = await dcr(as, {
        redirect_uris: [row.redirectUri],
        client_name: 'Totally Legit',
      });
      if (regRes.status !== 201) {
        expect(regRes.status).toBeGreaterThanOrEqual(400);
        return;
      }

      // Omit redirect_uri: a client with exactly one registered URI may, and the AS then renders the
      // value IT stored rather than one the request echoed back.
      const res = await authorizeRequest(as, client.client_id, { redirect_uri: undefined });
      const html = await res.text();
      if (!html.includes('consent_id')) {
        expect(res.status).not.toBe(200);
        return;
      }

      expect(html).toContain(`<strong>${row.identity}</strong>`);
      expect(html).not.toContain('<strong>null</strong>');
      if (row.absent !== undefined) expect(html).not.toContain(row.absent);
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

/**
 * Which address the limiter ends up keyed on, under the deployment these tests actually run in:
 * the request arrives from loopback carrying `<forged>, <real client>`, the chain a proxy that
 * appends the peer it saw would produce. `forged` is the part the caller writes.
 */
type KeyedOn = 'socket' | 'client' | 'forged';

type TrustProxy = boolean | number | string | string[];

interface Topology {
  name: string;
  trustProxy: TrustProxy;
  outcome: { keyedOn: KeyedOn };
}

const TOPOLOGIES: Topology[] = [
  // Direct exposure: the header is caller-controlled noise and must not mint a fresh bucket.
  { name: 'directly exposed', trustProxy: false, outcome: { keyedOn: 'socket' } },
  { name: 'behind one reverse-proxy hop', trustProxy: 'loopback', outcome: { keyedOn: 'client' } },
  { name: 'behind one hop given as a count', trustProxy: 1, outcome: { keyedOn: 'client' } },
  { name: 'proxies named by CIDR', trustProxy: '203.0.113.0/24', outcome: { keyedOn: 'socket' } },
  // A proxy list may legitimately name PUBLIC addresses — a CDN's ranges are the common case — so
  // the refusal below must key on covering the space, not on the addresses being routable. The
  // other spellings of a legitimate public proxy are driven against the guard itself, in
  // invariants.test.ts, where they cost no port.
  { name: 'a public proxy named by address', trustProxy: '8.8.8.8', outcome: { keyedOn: 'socket' } },
  // A hop count LARGER than the real chain trusts one forged element. The guard bounds how far
  // trust can reach; it cannot check the operator's arithmetic — and this row is what proves the
  // probe below can see a forged-keyed bucket at all, so the rows above are not vacuous.
  { name: 'a hop count larger than the real chain', trustProxy: 2, outcome: { keyedOn: 'forged' } },
];

/**
 * A guard that enumerates SPELLINGS is a guard the next spelling walks past: `'0.0.0.0/0'` was the
 * only whole-space CIDR listed here, express's parser happens to reject a /0 prefix, and the class
 * therefore sat behind a locked tuple while `['0.0.0.0/1','128.0.0.0/1']` — identical in meaning to
 * `true` — booted and handed every forged X-Forwarded-For its own fresh 10-per-15-min bucket at the
 * owner passphrase. So each row states only the VALUE, and the assertion is behavioural: refuse at
 * the factory, or key the limiter on something the caller did not write. `message` is set only for
 * the ones Parley refuses by name; the rest may be refused by express's parser instead.
 *
 * Hop counts are deliberately absent: express compiles a count to a predicate that ignores the
 * address entirely, and how many hops the real chain has is not knowable at boot — that residue is
 * the `keyedOn: 'forged'` row above, stated rather than hidden.
 */
interface WholeSpaceSpelling {
  name: string;
  trustProxy: TrustProxy;
  message?: RegExp;
}

const WHOLE_SPACE_SPELLINGS: WholeSpaceSpelling[] = [
  { name: 'the boolean', trustProxy: true, message: /trustProxy must not be/ },
  { name: 'the boolean spelled as an env var', trustProxy: 'true', message: /trustProxy must not be/ },
  { name: 'a wildcard', trustProxy: '*' },
  { name: 'a /0 CIDR', trustProxy: '0.0.0.0/0' },
  { name: 'an IPv6 /0 CIDR', trustProxy: ['::/0'] },
  {
    name: 'two IPv4 halves',
    trustProxy: ['0.0.0.0/1', '128.0.0.0/1'],
    message: /trusts every IPv4 address/,
  },
  {
    name: 'two IPv4 halves in one comma-separated string',
    trustProxy: '0.0.0.0/1, 128.0.0.0/1',
    message: /trusts every IPv4 address/,
  },
  {
    name: 'two IPv6 halves, which cover the IPv4-mapped space too',
    trustProxy: ['::/1', '8000::/1'],
    message: /trusts every IPv4 and IPv6 address/,
  },
  // proxy-addr compares an IPv4 peer as ::ffff:a.b.c.d, whose top bit is 0 — so ONE IPv6 half is
  // already the whole IPv4 space, and this is the spelling that looks the least like `true`.
  {
    name: 'the lower IPv6 half alone, which is all of the IPv4-mapped space',
    trustProxy: ['::/1'],
    message: /trusts every IPv4 address/,
  },
];

const ATTACKER = '203.0.113.9';
const OWNER = '198.51.100.4';

/** `<forged>, <real client>` pairs: same client twice, then a different client. */
const PROBES: Array<[forged: string, client: string]> = [
  ['9.9.9.1', OWNER],
  ['9.9.9.2', OWNER],
  ['9.9.9.1', ATTACKER],
];

const bucketOf = (keyedOn: KeyedOn, forged: string, client: string): string =>
  keyedOn === 'socket' ? 'socket' : keyedOn === 'client' ? client : forged;

describe('a rate limiter must key on the client the operator actually deploys behind', () => {
  let app: OAuthRemoteServer | undefined;
  let base: string;

  async function boot(trustProxy?: TrustProxy): Promise<void> {
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
    const running = app;
    app = undefined;
    await running?.close();
  });

  const remaining = (res: Response): number => Number(res.headers.get('ratelimit-remaining'));
  const limitOf = (res: Response): number => Number(res.headers.get('ratelimit-limit'));

  /** Drive the three probes and read back WHICH address the limiter counted them under. */
  async function observedKeying(route: LimitedRoute): Promise<KeyedOn> {
    const spent: number[] = [];
    let limit = 0;
    for (const [forged, client] of PROBES) {
      const res = await route.hit(base, `${forged}, ${client}`);
      if (limit === 0) limit = limitOf(res);
      expect(limit).toBeGreaterThan(0);
      spent.push(limit - remaining(res));
    }
    for (const keyedOn of ['socket', 'client', 'forged'] as KeyedOn[]) {
      const counts = new Map<string, number>();
      const expected = PROBES.map(([forged, client]) => {
        const key = bucketOf(keyedOn, forged, client);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      });
      if (expected.every((n, i) => n === spent[i])) return keyedOn;
    }
    throw new Error(`bucketing matches no topology: spent ${spent.join(',')} of ${limit}`);
  }

  const ROWS = TOPOLOGIES.flatMap((t) =>
    LIMITED_ROUTES.map((r): [string, Topology, LimitedRoute] => [
      `${r.name} when ${t.name}`,
      t,
      r,
    ]),
  );

  it.each(ROWS)('%s', async (_name: string, t: Topology, route: LimitedRoute) => {
    await boot(t.trustProxy);
    expect(await observedKeying(route)).toBe(t.outcome.keyedOn);
  });

  const WHOLE_SPACE_ROWS = WHOLE_SPACE_SPELLINGS.map(
    (s): [string, WholeSpaceSpelling] => [s.name, s],
  );

  it.each(WHOLE_SPACE_ROWS)(
    'trusting the whole address space spelled as %s never keys the limiter on the header',
    async (_name: string, s: WholeSpaceSpelling) => {
      const booted = await boot(s.trustProxy).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      if (booted !== undefined) {
        if (s.message !== undefined) expect(booted.message).toMatch(s.message);
        return;
      }
      // It got past the factory, so the only remaining question is behavioural.
      expect(await observedKeying(LIMITED_ROUTES[0]!)).not.toBe('forged');
    },
  );

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

/**
 * RFC 6749 §5.1 and the OAuth 2.1 BCP make a response that conveys a credential `no-store`, and the
 * SDK sets it on every endpoint it renders. The consent redirect carries the authorization code in
 * its `Location`, and the 403 gates it — both are hand-mounted here, so the table drives the SDK's
 * endpoints and Parley's own through the same assertion rather than trusting the hand-written ones
 * to have remembered.
 */
interface CredentialResponse {
  name: string;
  status: number;
  hit: () => Promise<Response>;
}

const CREDENTIAL_RESPONSES: CredentialResponse[] = [
  {
    name: 'the /authorize consent page',
    status: 200,
    hit: async () => {
      const as = await asMetadata();
      const { body: client } = await dcr(as);
      return authorizeRequest(as, client.client_id);
    },
  },
  {
    name: 'a dynamic client registration at /register',
    status: 201,
    hit: async () => (await dcr(await asMetadata())).res,
  },
  {
    name: 'the authorization-code exchange at /token',
    status: 200,
    hit: async () => (await runOAuthFlow()).tokenRes,
  },
  {
    name: 'a revocation at /revoke',
    status: 200,
    hit: async () => {
      const { client, tokens, asMeta } = await runOAuthFlow();
      return fetch(asMeta.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ token: tokens.access_token, client_id: client.client_id }),
      });
    },
  },
  {
    name: 'the owner-approved /parley/consent redirect carrying the code',
    status: 302,
    hit: async () => postConsent(await authorizeToConsentId(), OWNER_PASS),
  },
  {
    name: 'the refused /parley/consent page',
    status: 403,
    hit: () => postConsent('nonexistent', 'wrong'),
  },
];

describe('every front-door response that carries or gates a credential is no-store', () => {
  it.each(CREDENTIAL_RESPONSES.map((r) => [r.name, r]))(
    '%s',
    async (_name: string, r: CredentialResponse) => {
      const res = await r.hit();
      expect(res.status).toBe(r.status);
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );
});

/**
 * `scope` is one space-delimited field, and the SDK tokenises it with `split(' ')` at BOTH /authorize
 * and the refresh grant — so `scope=`, a stray leading space or a doubled one each hand the provider
 * an empty token. RFC 6749's `scope-token = 1*NQCHAR` means an empty token can never name a scope, so
 * it has to be dropped rather than refused as an unsupported one: refusing it answers the client with
 * an `invalid_scope` whose description names nothing at all. Every refused row therefore states the
 * token the error must name, which a pair of happy values cannot express.
 */
interface ScopeRequest {
  name: string;
  scope: string;
  /** The scope set the AS must settle on, or undefined when the request is refused. */
  granted?: string[];
  /** Refused rows only: the token the error_description must name. */
  refuses?: string;
}

const SCOPE_REQUESTS: ScopeRequest[] = [
  { name: 'the advertised scope', scope: 'mcp', granted: ['mcp'] },
  { name: 'an empty scope parameter', scope: '', granted: [] },
  { name: 'a lone space', scope: ' ', granted: [] },
  { name: 'a trailing space', scope: 'mcp ', granted: ['mcp'] },
  { name: 'a leading space', scope: ' mcp', granted: ['mcp'] },
  { name: 'a doubled space', scope: 'mcp  mcp', granted: ['mcp'] },
  { name: 'a tab where a space belongs', scope: 'mcp\tmcp', refuses: 'mcp\tmcp' },
  { name: 'the advertised scope in the wrong case', scope: 'MCP', refuses: 'MCP' },
  { name: 'an unadvertised scope beside a good one', scope: 'mcp admin', refuses: 'admin' },
];

const scopeSet = (scope: unknown): Set<string> =>
  new Set(String(scope).split(' ').filter(Boolean));

const SCOPE_ROWS = SCOPE_REQUESTS.map((r): [string, ScopeRequest] => [r.name, r]);

describe('a degenerate scope token is dropped, and a named one is refused by name', () => {
  it.each(SCOPE_ROWS)('%s at /authorize', async (_name: string, row: ScopeRequest) => {
    if (row.granted !== undefined) {
      const { tokens } = await runOAuthFlow(row.scope);
      expect(scopeSet(tokens.scope)).toEqual(new Set(row.granted));
      return;
    }
    const as = await asMetadata();
    const { body: client } = await dcr(as);
    const res = await authorizeRequest(as, client.client_id, { scope: row.scope });

    const { code, body } = await oauthErrorOf(res);
    expect(code).toBe('invalid_scope');
    expect(body).not.toContain('consent_id');
    const description = new URL(res.headers.get('location')!, origin).searchParams.get(
      'error_description',
    );
    expect(description).toContain(row.refuses);
  });

  it.each(SCOPE_ROWS)('%s at the refresh grant', async (_name: string, row: ScopeRequest) => {
    const { client, tokens, asMeta } = await runOAuthFlow();
    const res = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        resource: `${origin}/mcp`,
        scope: row.scope,
      }),
    });

    if (row.granted === undefined) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await jget(res)).error).toBe('invalid_scope');
      return;
    }
    expect(res.status).toBe(200);
    expect(scopeSet((await jget(res)).scope)).toEqual(new Set(row.granted));
  });
});
