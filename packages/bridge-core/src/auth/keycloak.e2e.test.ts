import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { fetchOidcDiscovery } from './oidc-discovery.js';
import { createOidcRemoteApp, type OidcRemoteServer } from './oidc-remote.js';

// Gated against a real Keycloak from examples/dev-compose (docker compose ... up keycloak).
// The imported `parley` realm ships users parley/parleypass (has the parley-owner realm role)
// and stranger/parleypass (doesn't), plus the parley-aud audience mapper on client parley-test.
const KC_URL = process.env.PARLEY_KEYCLOAK_URL ?? 'http://127.0.0.1:8080';
const ISSUER = `${KC_URL}/realms/parley`;
const AUDIENCE = 'parley-mcp';

/**
 * Opting OUT is explicit; a realm that simply fails to answer must turn this suite RED, never
 * green. A reachability probe deciding whether to run is how an e2e file skips itself into a
 * passing run that verified nothing.
 */
const OPTED_OUT = process.env.PARLEY_E2E === '0';
const READY_TIMEOUT_MS = 30_000;

async function waitForKeycloak(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // fall through to the retry/deadline check
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Resource-owner password grant against the imported realm's parley-test client. */
async function passwordGrant(
  username: string,
  password: string,
  scope?: string,
): Promise<{ access_token: string; id_token?: string }> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'parley-test',
      username,
      password,
      ...(scope !== undefined ? { scope } : {}),
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; id_token?: string };
}

async function accessToken(username: string, password: string): Promise<string> {
  return (await passwordGrant(username, password)).access_token;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const b64 = token.split('.')[1]!;
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

function hasGate(extras: Record<string, unknown>): boolean {
  return (
    'allowed_subjects' in extras || 'allowed_usernames' in extras || 'required_role' in extras
  );
}

/** Boot the delegated-RS app against the live realm; caller closes. */
async function bootAgainstKeycloak(
  oidcExtras: Record<string, unknown> = {},
): Promise<{ remote: OidcRemoteServer; plugin: FakePlugin; origin: string }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const plugin = new FakePlugin();
  await plugin.connect({});
  const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
  const remote = await createOidcRemoteApp(plugin, cfg, {
    publicUrl: new URL(origin),
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      clock_skew_s: 30,
      ...(hasGate(oidcExtras) ? {} : { allowed_usernames: ['parley', 'stranger'] }),
      ...oidcExtras,
    },
  });
  await remote.listen(port);
  return { remote, plugin, origin };
}

function postMcp(origin: string, token?: string): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

if (OPTED_OUT) {
  describe.skip(`keycloak e2e (opted out via PARLEY_E2E=0; realm ${ISSUER})`, () => {
    it('skipped by explicit opt-out', () => undefined);
  });
} else if (!(await waitForKeycloak())) {
  describe('keycloak e2e (delegated resource server against a live realm)', () => {
    it(`reaches the realm at ${ISSUER}`, () => {
      throw new Error(
        `Keycloak did not answer at ${ISSUER} within ${READY_TIMEOUT_MS}ms. Start it with ` +
          `examples/dev-compose, point PARLEY_KEYCLOAK_URL at your own, or set PARLEY_E2E=0 to ` +
          `opt out deliberately. This suite must not skip itself into a green run.`,
      );
    });
  });
} else {
  describe('keycloak e2e (delegated resource server against a live realm)', () => {
    it('discovery returns the realm metadata with a matching issuer', async () => {
      const metadata = await fetchOidcDiscovery(ISSUER);
      expect(metadata.issuer).toBe(ISSUER);
      expect(metadata.jwks_uri).toContain(ISSUER);
    });

    it('password-grant tokens carry the mapped parley-mcp audience (the RFC 8707 workaround)', async () => {
      const token = await accessToken('parley', 'parleypass');
      const payload = decodeJwtPayload(token);
      const aud = payload.aud;
      const audList = Array.isArray(aud) ? aud : [aud];
      expect(audList).toContain(AUDIENCE);
      expect(payload.iss).toBe(ISSUER);
    });

    it('accepts the owner (parley-owner role) end to end through a real MCP tool call', async () => {
      const { remote, plugin, origin } = await bootAgainstKeycloak({
        required_role: 'parley-owner',
      });
      try {
        const token = await accessToken('parley', 'parleypass');
        const res = await postMcp(origin, token);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('parley_post');
        expect(text).toContain('parley_fetch_recent');
      } finally {
        await remote.close();
        await plugin.disconnect();
      }
    });

    it('rejects a realm user without the required role (401)', async () => {
      const { remote, plugin, origin } = await bootAgainstKeycloak({
        required_role: 'parley-owner',
      });
      try {
        const token = await accessToken('stranger', 'parleypass');
        expect((await postMcp(origin, token)).status).toBe(401);
        expect((await postMcp(origin)).status).toBe(401); // and no token at all
      } finally {
        await remote.close();
        await plugin.disconnect();
      }
    });

    it('rejects tokens when the configured audience does not match the mapper (401)', async () => {
      const { remote, plugin, origin } = await bootAgainstKeycloak({
        audience: 'some-other-resource',
      });
      try {
        const token = await accessToken('parley', 'parleypass');
        expect((await postMcp(origin, token)).status).toBe(401);
      } finally {
        await remote.close();
        await plugin.disconnect();
      }
    });

    it('serves PRM pointing at the realm issuer', async () => {
      const { remote, plugin, origin } = await bootAgainstKeycloak();
      try {
        const prm = (await (
          await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)
        ).json()) as Record<string, unknown>;
        expect(prm.authorization_servers).toEqual([ISSUER]);
      } finally {
        await remote.close();
        await plugin.disconnect();
      }
    });

    /**
     * The offline near-miss table drives a fake IdP; this drives a real realm without touching it.
     * Each gate is derived from the LIVE claims of a real user, perturbed one way, so the token
     * under test is genuinely valid and differs from the gate only in the way named. In Keycloak
     * every realm on a host shares one origin and one JWKS, so exactness here is the whole of the
     * single-tenant posture.
     */
    it.each([
      ['a gate that is a prefix of the real value', (v: string) => v.slice(0, -1)],
      ['a gate the real value is a prefix of', (v: string) => `${v}-staging`],
      ['a gate differing only in case', (v: string) => v.toUpperCase()],
      ['a gate with the real value as a substring', (v: string) => `x${v}x`],
      ['a gate with trailing whitespace', (v: string) => `${v} `],
    ])('refuses a live realm token against %s', async (_label: string, perturb: (v: string) => string) => {
      const token = await accessToken('parley', 'parleypass');
      const claims = decodeJwtPayload(token);
      const sub = claims.sub as string;
      const username = claims.preferred_username as string;
      expect(sub).toBeTypeOf('string');
      expect(username).toBe('parley');

      for (const gate of [
        { allowed_subjects: [perturb(sub)] },
        { allowed_usernames: [perturb(username)] },
      ]) {
        const { remote, plugin, origin } = await bootAgainstKeycloak(gate);
        try {
          expect((await postMcp(origin, token)).status, JSON.stringify(gate)).toBe(401);
        } finally {
          await remote.close();
          await plugin.disconnect();
        }
      }

      // The floor: the same live token against the UNPERTURBED gates is admitted, so a 401 above
      // cannot be the realm or the audience mapper failing for an unrelated reason.
      for (const gate of [{ allowed_subjects: [sub] }, { allowed_usernames: [username] }]) {
        const { remote, plugin, origin } = await bootAgainstKeycloak(gate);
        try {
          expect((await postMcp(origin, token)).status, JSON.stringify(gate)).toBe(200);
        } finally {
          await remote.close();
          await plugin.disconnect();
        }
      }
    });

    it('refuses a realm ID token presented as a bearer access token', async () => {
      const { id_token } = await passwordGrant('parley', 'parleypass', 'openid');
      expect(id_token).toBeTypeOf('string');
      const payload = decodeJwtPayload(id_token!);
      // The audience an ID token carries is the client_id, so a deployment that pins
      // auth.oidc.audience to its connector's client_id is exactly the vulnerable shape.
      expect(payload.typ).toBe('ID');
      expect(payload.aud).toBe('parley-test');

      const { remote, plugin, origin } = await bootAgainstKeycloak({
        audience: 'parley-test',
        allowed_usernames: ['parley'],
      });
      try {
        expect((await postMcp(origin, id_token)).status).toBe(401);
      } finally {
        await remote.close();
        await plugin.disconnect();
      }
    });
  });
}
