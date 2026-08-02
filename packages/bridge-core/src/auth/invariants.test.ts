import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { OidcAuthSchema } from '../config-auth.js';
import { parseConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startFakeOidc, type FakeOidc } from '../testing/fake-oidc.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { assertPublicBaseUrl, assertTrustProxy, LOOPBACK_HOSTS } from './invariants.js';
import { createOidcRemoteApp } from './oidc-remote.js';
import { createRemoteAuthApp, type RemoteAuthServer } from './remote-auth.js';
import { createOAuthRemoteApp } from './remote.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

let idp: FakeOidc;
let plugin: FakePlugin;
const opened: RemoteAuthServer[] = [];

beforeAll(async () => {
  idp = await startFakeOidc();
  plugin = new FakePlugin();
  await plugin.connect({});
});
afterAll(async () => {
  await plugin.disconnect();
  await idp.close();
});
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

function baseCfg(): ParleyConfig {
  return parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
}

/**
 * A config-schema rule is only a suggestion: every factory below is a public barrel export that a
 * caller can reach with a hand-built config object, bypassing parseConfig entirely. Each row asserts
 * the invariant is ALSO enforced where it is depended on, and that a legitimate shape still boots.
 */
interface BootInvariant {
  name: string;
  /** Build the object graph directly, with the invariant violated. */
  violate: () => Promise<unknown>;
  expected: RegExp;
  /** The same graph with the invariant satisfied — must boot. */
  satisfy: () => Promise<RemoteAuthServer>;
}

const GATE_VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['allowed_subjects', { allowed_subjects: ['owner-sub'] }],
  ['allowed_usernames', { allowed_usernames: ['alice'] }],
  ['required_role', { required_role: 'parley-owner' }],
];

function oidcApp(extras: Record<string, unknown>): () => Promise<RemoteAuthServer> {
  return async () => {
    const origin = `http://127.0.0.1:${await freePort()}`;
    return createOidcRemoteApp(plugin, baseCfg(), {
      publicUrl: new URL(origin),
      oidc: { issuer: idp.issuer, clock_skew_s: 30, ...extras } as never,
    });
  };
}

function bootInvariants(): BootInvariant[] {
  return [
    {
      name: 'oidc identity gate — createOidcRemoteApp',
      violate: oidcApp({}),
      expected: /identity gate/,
      satisfy: oidcApp({ allowed_subjects: ['owner-sub'] }),
    },
    {
      name: 'oidc identity gate — createRemoteAuthApp selector',
      violate: async () => {
        const origin = `http://127.0.0.1:${await freePort()}`;
        const cfg = baseCfg();
        // Hand-built: what parseConfig would have refused, reaching the factory anyway.
        const hacked = {
          ...cfg,
          auth: { mode: 'oidc', oidc: { issuer: idp.issuer, clock_skew_s: 30 } },
        } as unknown as ParleyConfig;
        return createRemoteAuthApp(plugin, hacked, { publicUrl: new URL(origin) });
      },
      expected: /identity gate/,
      satisfy: async () => {
        const origin = `http://127.0.0.1:${await freePort()}`;
        const cfg = parseConfig({
          identity: { handle: 'agent' },
          topics: ['ctx'],
          auth: { mode: 'oidc', oidc: { issuer: idp.issuer, allowed_subjects: ['owner-sub'] } },
        });
        return createRemoteAuthApp(plugin, cfg, { publicUrl: new URL(origin) });
      },
    },
    {
      name: 'builtin mode owner verifier — createRemoteAuthApp selector',
      violate: async () => {
        const origin = `http://127.0.0.1:${await freePort()}`;
        return createRemoteAuthApp(plugin, baseCfg(), { publicUrl: new URL(origin) });
      },
      expected: /verifyOwner/,
      satisfy: async () => {
        const origin = `http://127.0.0.1:${await freePort()}`;
        return createRemoteAuthApp(plugin, baseCfg(), {
          publicUrl: new URL(origin),
          verifyOwner: async () => true,
        });
      },
    },
  ];
}

describe('remote-mode boot invariants are enforced at the factory, not only in the config schema', () => {
  it.each(bootInvariants().map((i) => [i.name, i]))(
    '%s: refuses to construct when violated',
    async (_name: string, invariant: BootInvariant) => {
      await expect(invariant.violate()).rejects.toThrow(invariant.expected);
    },
  );

  it.each(bootInvariants().map((i) => [i.name, i]))(
    '%s: still constructs when satisfied',
    async (_name: string, invariant: BootInvariant) => {
      const server = await invariant.satisfy();
      opened.push(server);
      expect(server.resource.pathname).toBe('/mcp');
    },
  );

  it.each(GATE_VARIANTS)(
    'a gate of kind %s alone satisfies the identity requirement',
    async (_kind: string, gate: Record<string, unknown>) => {
      const server = await oidcApp(gate)();
      opened.push(server);
      expect(server.resource.pathname).toBe('/mcp');
    },
  );
});

/**
 * A boot invariant that mirrors a schema rule must mirror ALL of it. The schema says a gate is a
 * NON-EMPTY list of non-empty strings; a factory check that only asks "is the key present" accepts
 * `allowed_subjects: []`, which satisfies "a gate exists" and matches nobody — the server boots
 * healthy and then 401s every valid token, with nothing at boot naming the cause. The same halving
 * applies to every bounded scalar in the block, so each key is crossed with the degenerate values
 * its schema rule excludes AND with the extremes that rule allows.
 */
interface OidcValueRow {
  key: string;
  value: unknown;
  outcome: { refuses: RegExp } | 'boots';
}

const BLANK_GATE = /must name at least one non-blank value/;

const OIDC_VALUE_ROWS: OidcValueRow[] = [
  ...['allowed_subjects', 'allowed_usernames'].flatMap((key) =>
    [
      [[], BLANK_GATE],
      [[''], BLANK_GATE],
      [[' '], BLANK_GATE],
      [['\t'], BLANK_GATE],
      [['real-value', ''], BLANK_GATE],
    ].map(([value, refuses]): OidcValueRow => ({ key, value, outcome: { refuses: refuses as RegExp } })),
  ),
  { key: 'required_role', value: '', outcome: { refuses: BLANK_GATE } },
  { key: 'required_role', value: '   ', outcome: { refuses: BLANK_GATE } },
  { key: 'allowed_subjects', value: ['real-value'], outcome: 'boots' },
  { key: 'allowed_usernames', value: ['a', 'b'], outcome: 'boots' },
  { key: 'required_role', value: 'parley-owner', outcome: 'boots' },
  { key: 'audience', value: '', outcome: { refuses: /audience must not be blank/ } },
  { key: 'audience', value: '  ', outcome: { refuses: /audience must not be blank/ } },
  { key: 'audience', value: 'parley-mcp', outcome: 'boots' },
  ...[-1, 301, Number.NaN, Number.POSITIVE_INFINITY, 1.5].map(
    (value): OidcValueRow => ({
      key: 'clock_skew_s',
      value,
      outcome: { refuses: /clock_skew_s must be an integer between 0 and 300/ },
    }),
  ),
  { key: 'clock_skew_s', value: 0, outcome: 'boots' },
  { key: 'clock_skew_s', value: 300, outcome: 'boots' },
  ...['', ' ', '\t', 'a b'].map(
    (value): OidcValueRow => ({
      key: 'required_scope',
      value,
      outcome: { refuses: /required_scope must be a single non-blank scope token/ },
    }),
  ),
  { key: 'required_scope', value: 'mcp', outcome: 'boots' },
  ...['', '   ', 'not-a-url'].map(
    (value): OidcValueRow => ({
      key: 'issuer',
      value,
      outcome: { refuses: /issuer must be an absolute URL/ },
    }),
  ),
  ...['', '   '].map(
    (value): OidcValueRow => ({
      key: 'jwks_uri',
      value,
      outcome: { refuses: /jwks_uri must be an absolute URL/ },
    }),
  ),
];

describe('a factory check that mirrors a schema rule must mirror all of it', () => {
  /**
   * Derive the key set from the schema rather than hand-enumerating it. Five of the block's eight
   * keys had rows and three did not, and `required_scope` was the one whose schema rule (`min(1)`)
   * accepts a value — whitespace — that the verifier can never match: the resource server booted
   * healthy, advertised the blank scope in its metadata, and 403'd every valid token. A key with no
   * degenerate-value row is a hole that reads as coverage, so make it a red row instead.
   */
  it('has a degenerate-value row for every key the oidc schema declares', () => {
    const declared = Object.keys(OidcAuthSchema.shape);
    expect(declared.length).toBeGreaterThan(5);
    // A key present only through a value that BOOTS is a key nobody grades: `required_scope` would
    // have satisfied a membership-only check with its one working value while whitespace shipped.
    const refuted = OIDC_VALUE_ROWS.filter((r) => r.outcome !== 'boots').map((r) => r.key);
    expect([...new Set(refuted)].sort()).toEqual([...declared].sort());
  });

  it.each(
    OIDC_VALUE_ROWS.map((row): [string, OidcValueRow] => [
      `${row.key}: ${typeof row.value === 'number' ? String(row.value) : JSON.stringify(row.value)} ${
        row.outcome === 'boots' ? 'boots' : 'is refused'
      }`,
      row,
    ]),
  )('%s', async (_name: string, row: OidcValueRow) => {
    // A gate key under test supplies its own gate; every other key needs one beside it, so the
    // row cannot pass on the identity-gate error it was not written to provoke.
    const isGate = row.key.startsWith('allowed_') || row.key === 'required_role';
    const build = oidcApp({
      ...(isGate ? {} : { allowed_subjects: ['owner-sub'] }),
      [row.key]: row.value,
    });
    if (row.outcome === 'boots') {
      const server = await build();
      opened.push(server);
      expect(server.resource.pathname).toBe('/mcp');
      return;
    }
    await expect(build()).rejects.toThrow(row.outcome.refuses);
  });

  it('an empty gate is refused rather than booting a server that rejects a valid token', async () => {
    // The defect this row exists for was reachable only end to end: the factory accepted
    // allowed_subjects: [], the app served PRM, and a correct IdP token then 401'd forever.
    await expect(oidcApp({ allowed_subjects: [] })()).rejects.toThrow(BLANK_GATE);
    const server = await oidcApp({ allowed_subjects: ['owner-sub'] })();
    opened.push(server);
    const port = Number(server.resource.port);
    await server.listen(port);
    const token = await idp.mint({ aud: server.resource.href, sub: 'owner-sub' });
    const res = await fetch(server.resource.href, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });
});

/**
 * Every option `createRemoteAuthApp` accepts belongs to exactly one mode, and the selector forwards
 * only its own mode's. Silently discarding the other mode's is worst for `trustProxy`: it is what
 * keys the rate limiters, so a caller who sets it and is ignored believes they are protected from a
 * flood that can lock the owner out of the only path that authorizes the bridge.
 *
 * Each row states BOTH halves, because an option that reaches two consumers and is asserted at one
 * of them is a deletion no test can see: `scopesSupported` reaches the metadata document AND the
 * provider's /authorize check, and while only the document was read, dropping it from the provider
 * left an AS advertising a scope it answers `invalid_scope` to — with the whole suite green.
 */
interface Recorder {
  called: string[];
}

interface ModeOption {
  key: string;
  mode: 'builtin' | 'oidc';
  value: (recorder: Recorder) => unknown;
  /** What the object graph or the advertised document says about the option. */
  observeDeclared: (server: RemoteAuthServer, recorder: Recorder) => Promise<void>;
  /** What the RUNNING server does with it, over HTTP. */
  observeEnforced: (server: RemoteAuthServer, recorder: Recorder) => Promise<void>;
}

const OWNER_PASS = 'correct horse battery staple';
const CLIENT_REDIRECT = 'http://127.0.0.1:9999/callback';
const S256_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

async function listening(server: RemoteAuthServer): Promise<string> {
  await server.listen(Number(server.resource.port));
  return server.resource.origin;
}

async function registerClient(origin: string): Promise<string> {
  const res = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(origin: string, clientId: string, scope?: string): string {
  return `${origin}/authorize?${form({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: S256_CHALLENGE,
    code_challenge_method: 'S256',
    ...(scope !== undefined ? { scope } : {}),
  })}`;
}

async function consentIdFrom(origin: string, clientId: string): Promise<string> {
  const page = await (await fetch(authorizeUrl(origin, clientId))).text();
  const consentId = /name="consent_id" value="([^"]+)"/.exec(page)?.[1];
  expect(consentId, 'the /authorize response is not a consent page').toBeTruthy();
  return consentId!;
}

function submitConsent(origin: string, consentId: string, passphrase: string): Promise<Response> {
  return fetch(`${origin}/parley/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ consent_id: consentId, passphrase }),
    redirect: 'manual',
  });
}

const MODE_OPTIONS: ModeOption[] = [
  {
    key: 'verifyOwner',
    mode: 'builtin',
    value: () => async (pass: string) => pass === OWNER_PASS,
    observeDeclared: async (server) => {
      expect(server).toHaveProperty('provider');
    },
    observeEnforced: async (server) => {
      const origin = await listening(server);
      const clientId = await registerClient(origin);
      const wrong = await submitConsent(
        origin,
        await consentIdFrom(origin, clientId),
        `not ${OWNER_PASS}`,
      );
      expect(wrong.status).toBe(403);
      const right = await submitConsent(origin, await consentIdFrom(origin, clientId), OWNER_PASS);
      expect(right.status).toBe(302);
      expect(new URL(right.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    },
  },
  {
    key: 'trustProxy',
    mode: 'builtin',
    value: () => 'loopback',
    observeDeclared: async (server) => {
      expect(server.app.get('trust proxy')).toBe('loopback');
    },
    observeEnforced: async (server) => {
      const origin = await listening(server);
      const hit = (xff: string): Promise<Response> =>
        fetch(`${origin}/parley/consent`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': xff },
          body: form({ consent_id: 'none', passphrase: 'none' }),
          redirect: 'manual',
        });
      const remaining = (res: Response): number => Number(res.headers.get('ratelimit-remaining'));
      // One declared hop: the request arrives over loopback, so only the RIGHTMOST element is the
      // proxy's word and the leftmost is the caller's own — it must not mint a fresh bucket.
      const first = remaining(await hit('9.9.9.1, 198.51.100.4'));
      const second = remaining(await hit('9.9.9.2, 198.51.100.4'));
      expect(first).toBeGreaterThan(0);
      expect(second).toBe(first - 1);
    },
  },
  {
    key: 'scopesSupported',
    mode: 'builtin',
    value: () => ['mcp', 'parley:admin'],
    observeDeclared: async (server) => {
      const origin = await listening(server);
      const as = (await (
        await fetch(`${origin}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, unknown>;
      expect(as.scopes_supported).toEqual(['mcp', 'parley:admin']);
    },
    observeEnforced: async (server) => {
      const origin = await listening(server);
      const as = (await (
        await fetch(`${origin}/.well-known/oauth-authorization-server`)
      ).json()) as { scopes_supported: string[] };
      expect(as.scopes_supported.length).toBeGreaterThan(0);
      const clientId = await registerClient(origin);
      // Driven off the document the server just served, not off the row's literal: whatever this
      // AS advertises, it must also ACCEPT — one at a time and all together.
      for (const scope of [...as.scopes_supported, as.scopes_supported.join(' ')]) {
        const res = await fetch(authorizeUrl(origin, clientId, scope), { redirect: 'manual' });
        expect(res.status, `advertised scope ${JSON.stringify(scope)}`).toBe(200);
        expect(await res.text()).toContain('name="consent_id"');
      }
      const unadvertised = 'parley:not-advertised';
      expect(as.scopes_supported).not.toContain(unadvertised);
      const refused = await fetch(authorizeUrl(origin, clientId, unadvertised), {
        redirect: 'manual',
      });
      expect(refused.status).toBe(302);
      expect(new URL(refused.headers.get('location')!).searchParams.get('error')).toBe(
        'invalid_scope',
      );
    },
  },
  {
    key: 'fetchFn',
    mode: 'oidc',
    value: (recorder) => (async (input: unknown, init?: RequestInit) => {
      recorder.called.push(String(input));
      const doc = (await (await fetch(String(input), init)).json()) as Record<string, unknown>;
      // Same origin as the issuer, so the discovery-origin check still passes, but not the real
      // JWKS — the enforced half then has something only THIS document can explain.
      return Response.json({ ...doc, jwks_uri: new URL('/not-the-jwks', String(doc.issuer)).href });
    }) as unknown as typeof fetch,
    observeDeclared: async (_server, recorder) => {
      expect(recorder.called).toHaveLength(1);
      expect(recorder.called[0]).toContain('/.well-known/openid-configuration');
    },
    observeEnforced: async (server) => {
      const origin = await listening(server);
      const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${await idp.mint({ aud: server.resource.href })}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    },
  },
];

/**
 * The row set is checked against the selector's own table rather than eyeballed, so a mode-scoped
 * option added tomorrow arrives with no observation and fails the day it lands.
 */
function modeOnlyOptionsFromSource(): string[] {
  const src = readFileSync(fileURLToPath(new URL('./remote-auth.ts', import.meta.url)), 'utf8');
  const table = /const MODE_ONLY_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src)?.[1];
  if (table === undefined) throw new Error('MODE_ONLY_OPTIONS not found in remote-auth.ts');
  return [...table.matchAll(/\['(\w+)',\s*'(\w+)'\]/g)].map((m) => `${m[1]}:${m[2]}`);
}

async function buildInMode(
  mode: 'builtin' | 'oidc',
  extra: Record<string, unknown>,
): Promise<RemoteAuthServer> {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const cfg =
    mode === 'oidc'
      ? parseConfig({
          identity: { handle: 'agent' },
          topics: ['ctx'],
          auth: { mode: 'oidc', oidc: { issuer: idp.issuer, allowed_subjects: ['owner-sub'] } },
        })
      : baseCfg();
  return createRemoteAuthApp(plugin, cfg, {
    publicUrl: new URL(origin),
    ...(mode === 'builtin' && extra.verifyOwner === undefined ? { verifyOwner: async () => true } : {}),
    ...extra,
  });
}

describe('the front-door selector never silently discards an option belonging to the other mode', () => {
  it('covers every mode-scoped option the selector names, and no other', () => {
    const declared = modeOnlyOptionsFromSource();
    expect(declared.length).toBeGreaterThan(0);
    expect(MODE_OPTIONS.map((o) => `${o.key}:${o.mode}`).sort()).toEqual([...declared].sort());
  });

  it.each(MODE_OPTIONS.map((o): [string, ModeOption] => [`${o.key} (${o.mode} only)`, o]))(
    '%s is refused by name in the other mode',
    async (_name: string, option: ModeOption) => {
      const other = option.mode === 'builtin' ? 'oidc' : 'builtin';
      const recorder: Recorder = { called: [] };
      await expect(
        buildInMode(other, { [option.key]: option.value(recorder) }),
      ).rejects.toThrow(new RegExp(option.key));
    },
  );

  const SIDES: Array<[string, (o: ModeOption) => ModeOption['observeDeclared']]> = [
    ['what the server declares', (o) => o.observeDeclared],
    ['what the server enforces', (o) => o.observeEnforced],
  ];

  const OBSERVATIONS = MODE_OPTIONS.flatMap((o) =>
    SIDES.map((side): [string, ModeOption, (typeof SIDES)[number][1]] => [
      `${o.key} (${o.mode} only) reaches ${side[0]}`,
      o,
      side[1],
    ]),
  );

  it.each(OBSERVATIONS)(
    '%s',
    async (
      _name: string,
      option: ModeOption,
      side: (o: ModeOption) => ModeOption['observeDeclared'],
    ) => {
      const recorder: Recorder = { called: [] };
      const server = await buildInMode(option.mode, { [option.key]: option.value(recorder) });
      opened.push(server);
      await side(option)(server, recorder);
    },
  );

  it('names every option it refuses, not just the first', async () => {
    const build = (): Promise<RemoteAuthServer> =>
      buildInMode('oidc', { trustProxy: 'loopback', scopesSupported: ['mcp'] });
    await expect(build()).rejects.toThrow(/trustProxy/);
    await expect(build()).rejects.toThrow(/scopesSupported/);
  });
});

/**
 * `assertTrustProxy` refuses a value that trusts the WHOLE address space, however it is spelled —
 * the behavioural half of that lives in remote.test.ts, where a forged X-Forwarded-For is shown not
 * to mint its own rate-limit bucket. This is the other half, and the one a coverage check gets
 * wrong: a real deployment behind a CDN names PUBLIC ranges, so a guard that refuses "any routable
 * address is trusted" would refuse the topology it exists to serve. Every row here is a proxy list
 * an operator legitimately writes.
 */
const LEGITIMATE_PROXY_LISTS: Array<[string, string | string[]]> = [
  ['the reverse proxy in examples/self-host-remote', 'loopback'],
  ['a single public proxy by address', '8.8.8.8'],
  ['a CDN’s published IPv4 and IPv6 ranges', ['1.2.3.0/24', '2606:4700::/32']],
  ['several public ranges in one comma-separated string', '203.0.113.0/24, 198.51.100.0/24'],
  ['a private proxy tier', ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']],
  ['every IPv4 half but one', ['0.0.0.0/1']],
  ['express’s own named presets', 'loopback, linklocal, uniquelocal'],
];

describe('the trust-proxy guard refuses covering the address space, not naming a public one', () => {
  it.each(LEGITIMATE_PROXY_LISTS)('accepts %s', (_name: string, value: string | string[]) => {
    expect(() => assertTrustProxy(value, 'trustProxy')).not.toThrow();
  });
});

/**
 * The advertised RFC 9728 resource id is `publicUrl + mcpPath` — a function of TWO inputs, both
 * caller-supplied, which keeps only scheme, host and port of the first. A base URL varying in ANY
 * other component, or a path that is not a plain path on that origin, is therefore either refused
 * or advertised as something the operator did not write — so every accepted row states the exact
 * href it must produce and asserts the origin survived. Both front doors run it: oidc mode does not
 * route through the SDK's own issuer check, so a rule enforced only there would leave it the weaker
 * of the two.
 */
interface BaseUrlShape {
  /** `PORT` is replaced with a free port before the URL is parsed. */
  shape: string;
  /** The exact resource href a booting row must advertise, or the message a refused row must carry. */
  outcome: { boots: string } | { refuses: RegExp };
}

const BASE_URL_SHAPES: BaseUrlShape[] = [
  { shape: 'http://127.0.0.1:PORT/', outcome: { boots: 'http://127.0.0.1:PORT/mcp' } },
  { shape: 'http://127.0.0.1:PORT', outcome: { boots: 'http://127.0.0.1:PORT/mcp' } },
  { shape: 'http://localhost:PORT/', outcome: { boots: 'http://localhost:PORT/mcp' } },
  { shape: 'https://parley.example.com/', outcome: { boots: 'https://parley.example.com/mcp' } },
  { shape: 'https://parley.example.com:8443/', outcome: { boots: 'https://parley.example.com:8443/mcp' } },
  { shape: 'http://127.0.0.1:PORT/parley', outcome: { refuses: /no path/ } },
  { shape: 'http://127.0.0.1:PORT/parley/', outcome: { refuses: /no path/ } },
  { shape: 'http://127.0.0.1:PORT/a/b/', outcome: { refuses: /no path/ } },
  { shape: 'http://127.0.0.1:PORT/?tenant=a', outcome: { refuses: /query string/ } },
  { shape: 'http://127.0.0.1:PORT/#frag', outcome: { refuses: /fragment/ } },
  { shape: 'http://owner:hunter2@127.0.0.1:PORT/', outcome: { refuses: /userinfo credentials/ } },
  { shape: 'https://owner:hunter2@parley.example.com/', outcome: { refuses: /userinfo credentials/ } },
  { shape: 'http://parley.example.com/', outcome: { refuses: /https outside loopback/ } },
  // Every shape this guard accepts must boot on EVERY front door. IPv6 loopback used to pass here
  // and then die inside the SDK with "Issuer URL must be HTTPS" on the built-in door only, pointing
  // the operator at TLS, which cannot help — so the refusal must carry OUR message, naming the rule.
  {
    shape: 'http://[::1]:PORT/',
    outcome: { refuses: /Only 127\.0\.0\.1 and localhost are exempt/ },
  },
  {
    shape: 'http://[::1]:PORT',
    outcome: { refuses: /Only 127\.0\.0\.1 and localhost are exempt/ },
  },
  // The scheme is a component of its own. A non-special one parses with origin "null", so the
  // cross-origin check in canonicalResourceId compares "null" to "null" and cannot fire — the
  // loopback exemption then admits a one-character typo and every token is minted for a resource
  // identifier naming a protocol nothing speaks.
  { shape: 'htp://localhost:PORT', outcome: { refuses: /https or http scheme/ } },
  { shape: 'foo://127.0.0.1:PORT', outcome: { refuses: /https or http scheme/ } },
  { shape: 'ws://localhost:PORT/', outcome: { refuses: /https or http scheme/ } },
  { shape: 'file://localhost/', outcome: { refuses: /https or http scheme/ } },
];

const shapeName = (s: BaseUrlShape): string =>
  `${s.shape} ${'boots' in s.outcome ? 'boots' : 'is refused'}`;

/**
 * The loopback exemption is a claim about a DEPENDENCY: the built-in door hands issuerUrl to the
 * SDK's `checkIssuerUrl`, which exempts its own fixed host set. A host in one set and not the other
 * is a base URL that boots on one front door and dies inside the other, so the rule is asserted
 * against the SDK itself rather than restated in a comment that cannot fail.
 */
describe('the loopback exemption is exactly the one the SDK issuer check applies', () => {
  const STUB_PROVIDER = { clientsStore: { registerClient: () => undefined } } as unknown as
    OAuthServerProvider;

  const sdkAccepts = (url: URL): boolean => {
    try {
      createOAuthMetadata({ provider: STUB_PROVIDER, issuerUrl: url, baseUrl: url });
      return true;
    } catch {
      return false;
    }
  };
  const weAccept = (url: URL): boolean => {
    try {
      assertPublicBaseUrl(url, 'issuerUrl');
      return true;
    } catch {
      return false;
    }
  };

  // A table generated FROM the set cannot see a member deleted from it, so the membership is also
  // pinned by value.
  it('names 127.0.0.1 and localhost, and nothing else', () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(['127.0.0.1', 'localhost']);
  });

  const HOSTS = [...LOOPBACK_HOSTS, '[::1]', 'localhost.localdomain', 'parley.example.com'];

  it.each(HOSTS)('http://%s is accepted by both guards or by neither', (host: string) => {
    const url = new URL(`http://${host}:8080`);
    expect(weAccept(url)).toBe(sdkAccepts(url));
  });
});

/**
 * The second operand. `new URL(path, base)` will take an authority (`//host`, and `/\host`, which
 * WHATWG treats identically for http), a scheme, or a query/fragment and hand back something that
 * is not a path on this origin — advertising a resource this server never serves and minting every
 * token for it, while the route the owner just consented to answers 404. A trailing slash is a
 * different resource id, as every NEAR_MISS_RESOURCES row in oauth-provider.test.ts shows.
 */
const BACKSLASH = String.fromCharCode(92);

interface McpPathShape {
  path: string;
  /** The exact pathname a booting row must advertise, or the message a refused row must carry. */
  outcome: { boots: string } | { refuses: RegExp };
}

const MCP_PATH_SHAPES: McpPathShape[] = [
  { path: '/mcp', outcome: { boots: '/mcp' } },
  { path: '/parley/mcp', outcome: { boots: '/parley/mcp' } },
  { path: 'mcp', outcome: { refuses: /absolute path beginning with/ } },
  { path: '', outcome: { refuses: /absolute path beginning with/ } },
  { path: 'https://evil.example/mcp', outcome: { refuses: /absolute path beginning with/ } },
  { path: '/', outcome: { refuses: /must name a path/ } },
  { path: '/mcp/', outcome: { refuses: /must not end in/ } },
  { path: '//evil.example/mcp', outcome: { refuses: /plain path on the/ } },
  { path: `/${BACKSLASH}evil.example/mcp`, outcome: { refuses: /plain path on the/ } },
  { path: '/mcp?x=1', outcome: { refuses: /plain path on the/ } },
  { path: '/mcp#f', outcome: { refuses: /plain path on the/ } },
  // A path that NORMALIZES survives every clause above — same origin, no query, no fragment — and
  // is caught only by the byte-for-byte pathname round-trip. Without it `/mcp/../admin` advertises
  // `<origin>/admin` while Express registers the literal string, so nothing the operator consented
  // to can ever be reached.
  { path: '/mcp/../admin', outcome: { refuses: /plain path on the/ } },
  { path: '/./mcp', outcome: { refuses: /plain path on the/ } },
  { path: '/mcp/./v1', outcome: { refuses: /plain path on the/ } },
  { path: '/MCP/../mcp', outcome: { refuses: /plain path on the/ } },
  { path: '/mcp//v1', outcome: { refuses: /literal path of/ } },
  // Express reads the same string as a route pattern, a grammar `new URL` knows nothing about:
  // '/mcp:v1' registered a named parameter and served every /mcp<suffix>, and '/mcp*' threw an
  // opaque path-to-regexp error at boot instead of ours.
  { path: '/mcp:v1', outcome: { refuses: /literal path of/ } },
  { path: '/:x', outcome: { refuses: /literal path of/ } },
  { path: '/mcp*', outcome: { refuses: /literal path of/ } },
  { path: '/mcp(a)', outcome: { refuses: /literal path of/ } },
  { path: '/mcp+', outcome: { refuses: /literal path of/ } },
  { path: '/mcp%2Fx', outcome: { refuses: /literal path of/ } },
  { path: '/m cp', outcome: { refuses: /plain path on the/ } },
  { path: '/mcp{a}', outcome: { refuses: /plain path on the/ } },
];

interface FrontDoor {
  name: string;
  build: (base: URL, mcpPath?: string) => Promise<RemoteAuthServer>;
}

const FRONT_DOORS: FrontDoor[] = [
  {
    name: 'built-in OAuth',
    build: async (base, mcpPath) =>
      createOAuthRemoteApp(plugin, baseCfg(), {
        issuerUrl: base,
        verifyOwner: async () => true,
        ...(mcpPath !== undefined ? { mcpPath } : {}),
      }),
  },
  {
    name: 'delegated OIDC',
    build: async (base, mcpPath) =>
      createOidcRemoteApp(plugin, baseCfg(), {
        publicUrl: base,
        oidc: { issuer: idp.issuer, clock_skew_s: 30, allowed_subjects: ['owner-sub'] } as never,
        ...(mcpPath !== undefined ? { mcpPath } : {}),
      }),
  },
];

describe('the advertised resource id must match the URL the endpoint is served at', () => {
  const BASE_ROWS = FRONT_DOORS.flatMap(({ name, build }) =>
    BASE_URL_SHAPES.map((s): [string, BaseUrlShape, FrontDoor['build']] => [
      `${name} front door: ${shapeName(s)}`,
      s,
      build,
    ]),
  );

  it.each(BASE_ROWS)(
    '%s',
    async (_name: string, s: BaseUrlShape, build: FrontDoor['build']) => {
      const port = String(await freePort());
      const base = new URL(s.shape.replaceAll('PORT', port));

      if ('refuses' in s.outcome) {
        await expect(build(base)).rejects.toThrow(s.outcome.refuses);
        return;
      }
      const server = await build(base);
      opened.push(server);
      expect(server.resource.href).toBe(s.outcome.boots.replaceAll('PORT', port));
      expect(server.resource.origin).toBe(base.origin);
    },
  );

  // The path is the other half of the same expression, so it is validated on every base shape the
  // base matrix accepts — a loopback origin and a real https one, which resolve `//host` differently
  // in scheme but identically in outcome.
  const ACCEPTED_BASES = ['http://127.0.0.1:PORT', 'https://parley.example.com'];
  const PATH_ROWS = FRONT_DOORS.flatMap(({ name, build }) =>
    ACCEPTED_BASES.flatMap((baseShape) =>
      MCP_PATH_SHAPES.map((s): [string, string, McpPathShape, FrontDoor['build']] => [
        `${name} front door on ${baseShape}: mcpPath ${JSON.stringify(s.path)} ${
          'boots' in s.outcome ? 'boots' : 'is refused'
        }`,
        baseShape,
        s,
        build,
      ]),
    ),
  );

  it.each(PATH_ROWS)(
    '%s',
    async (
      _name: string,
      baseShape: string,
      s: McpPathShape,
      build: FrontDoor['build'],
    ) => {
      const port = String(await freePort());
      const base = new URL(baseShape.replaceAll('PORT', port));

      if ('refuses' in s.outcome) {
        await expect(build(base, s.path)).rejects.toThrow(s.outcome.refuses);
        return;
      }
      const server = await build(base, s.path);
      opened.push(server);
      expect(server.resource.href).toBe(`${base.origin}${s.outcome.boots}`);
      expect(server.resource.origin).toBe(base.origin);
    },
  );

  /**
   * The refusals above are a property of one string; this is a property of the running server. The
   * advertised resource identifier must be the WHOLE served route set — a 404 on a neighbouring
   * path is the ceiling, and the 401 on the advertised path is the floor that stops the whole row
   * from passing on a server that serves nothing at all.
   */
  const ACCEPTED_PATHS = MCP_PATH_SHAPES.filter((s) => 'boots' in s.outcome).map((s) => s.path);

  it.each(ACCEPTED_PATHS)('mcpPath %s is served at exactly that path and nowhere near it', async (mcpPath: string) => {
    const port = await freePort();
    const server = await FRONT_DOORS[1]!.build(new URL(`http://127.0.0.1:${port}`), mcpPath);
    opened.push(server);
    await server.listen(port);
    const post = (path: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{}',
      });

    expect((await post(mcpPath)).status).toBe(401);
    for (const neighbour of [
      `${mcpPath}TOTALLY-ELSE`,
      `${mcpPath}/extra`,
      `${mcpPath.slice(0, -1)}`,
      `${mcpPath}.json`,
    ]) {
      expect((await post(neighbour)).status, `POST ${neighbour}`).toBe(404);
    }
  });
});

/**
 * Every config value the auth layer will fetch a trust root FROM. `issuer` supplies the discovery
 * document and `jwks_uri` supplies the keys every delegated-mode token is verified against — over
 * plaintext HTTP either one lets anyone on the path substitute their own keys and mint a token that
 * satisfies iss, aud, exp and the identity gate. `jwks_uri` is the documented origin-check bypass,
 * so it has no other protection at all. Each row runs through both entry points, because the schema
 * is not in front of a hand-built config object.
 */
interface TrustRootRow {
  name: string;
  oidc: (idpIssuer: string) => Record<string, unknown>;
  /** Discovery response for issuers that are not the local fake IdP. */
  discovery?: { issuer: string; jwks_uri: string };
  refuses?: RegExp;
}

const HTTPS_ISSUER = 'https://kc.corp.example/realms/parley';

const TRUST_ROOT_ROWS: TrustRootRow[] = [
  {
    name: 'issuer https, jwks from discovery on the same origin',
    oidc: () => ({ issuer: HTTPS_ISSUER, allowed_subjects: ['owner-sub'], clock_skew_s: 30 }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'https://kc.corp.example/realms/parley/certs' },
  },
  {
    name: 'issuer http on loopback (the dev/test fake)',
    oidc: (issuer) => ({ issuer, allowed_subjects: ['owner-sub'], clock_skew_s: 30 }),
  },
  {
    name: 'issuer http off loopback',
    oidc: () => ({
      issuer: 'http://kc.corp.example/realms/parley',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    refuses: /auth\.oidc\.issuer must use https outside loopback/,
  },
  {
    name: 'jwks_uri pinned to https off the issuer origin (a CDN-hosted JWKS)',
    oidc: () => ({
      issuer: HTTPS_ISSUER,
      jwks_uri: 'https://cdn.corp.example/keys',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'https://kc.corp.example/realms/parley/certs' },
  },
  {
    name: 'jwks_uri pinned to http on loopback',
    oidc: (issuer) => ({
      issuer,
      jwks_uri: 'http://127.0.0.1:9/keys',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
  },
  {
    name: 'jwks_uri pinned to http off loopback',
    oidc: () => ({
      issuer: HTTPS_ISSUER,
      jwks_uri: 'http://jwks.attacker-reachable.example/keys',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'https://kc.corp.example/realms/parley/certs' },
    refuses: /auth\.oidc\.jwks_uri must use https outside loopback/,
  },
  {
    name: 'jwks_uri handed back over http by an https discovery document',
    oidc: () => ({ issuer: HTTPS_ISSUER, allowed_subjects: ['owner-sub'], clock_skew_s: 30 }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'http://jwks.attacker-reachable.example/keys' },
    refuses: /jwks_uri must use https outside loopback/,
  },
  // IPv6 loopback is not a loopback exemption anywhere, so the trust-root guard has to agree with
  // the base-URL guard: one set, one policy, both messages ours.
  {
    name: 'issuer http on IPv6 loopback',
    oidc: () => ({
      issuer: 'http://[::1]:8080/realms/parley',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    refuses: /auth\.oidc\.issuer must use https outside loopback/,
  },
  {
    name: 'jwks_uri pinned to http on IPv6 loopback',
    oidc: () => ({
      issuer: HTTPS_ISSUER,
      jwks_uri: 'http://[::1]:9/keys',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'https://kc.corp.example/realms/parley/certs' },
    refuses: /auth\.oidc\.jwks_uri must use https outside loopback/,
  },
  // The scheme is its own component: `new URL` accepts any of them, and a non-special one leaves
  // the loopback exemption looking at a hostname that means nothing. Both trust roots must refuse
  // a scheme the fetch can never speak, not only a plaintext one.
  {
    name: 'issuer on a scheme nothing fetches',
    oidc: () => ({
      issuer: 'htp://localhost:8080/realms/parley',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    refuses: /auth\.oidc\.issuer must use the https or http scheme/,
  },
  {
    name: 'jwks_uri on a scheme nothing fetches',
    oidc: () => ({
      issuer: HTTPS_ISSUER,
      jwks_uri: 'htp://127.0.0.1:9/keys',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'https://kc.corp.example/realms/parley/certs' },
    refuses: /auth\.oidc\.jwks_uri must use the https or http scheme/,
  },
  {
    name: 'jwks_uri that is not a URL at all',
    oidc: () => ({
      issuer: HTTPS_ISSUER,
      jwks_uri: 'certs',
      allowed_subjects: ['owner-sub'],
      clock_skew_s: 30,
    }),
    discovery: { issuer: HTTPS_ISSUER, jwks_uri: 'https://kc.corp.example/realms/parley/certs' },
    refuses: /must be an absolute URL/,
  },
];

function discoveryStub(doc: { issuer: string; jwks_uri: string }): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        issuer: doc.issuer,
        authorization_endpoint: `${doc.issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${doc.issuer}/protocol/openid-connect/token`,
        jwks_uri: doc.jwks_uri,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

describe('every URL the auth layer fetches a trust root from must satisfy the transport invariant', () => {
  const ENTRY_POINTS: Array<
    [string, (row: TrustRootRow, publicUrl: URL) => Promise<RemoteAuthServer>]
  > = [
    [
      'createOidcRemoteApp',
      async (row, publicUrl) =>
        createOidcRemoteApp(plugin, baseCfg(), {
          publicUrl,
          oidc: row.oidc(idp.issuer) as never,
          ...(row.discovery !== undefined ? { fetchFn: discoveryStub(row.discovery) } : {}),
        }),
    ],
    [
      'createRemoteAuthApp selector',
      async (row, publicUrl) => {
        const hacked = {
          ...baseCfg(),
          auth: { mode: 'oidc', oidc: row.oidc(idp.issuer) },
        } as unknown as ParleyConfig;
        return createRemoteAuthApp(plugin, hacked, {
          publicUrl,
          ...(row.discovery !== undefined ? { fetchFn: discoveryStub(row.discovery) } : {}),
        });
      },
    ],
  ];

  const ROWS = ENTRY_POINTS.flatMap(([entry, build]) =>
    TRUST_ROOT_ROWS.map(
      (row): [string, TrustRootRow, (r: TrustRootRow, u: URL) => Promise<RemoteAuthServer>] => [
        `${entry}: ${row.name} ${row.refuses === undefined ? 'boots' : 'is refused'}`,
        row,
        build,
      ],
    ),
  );

  it.each(ROWS)(
    '%s',
    async (
      _name: string,
      row: TrustRootRow,
      build: (r: TrustRootRow, u: URL) => Promise<RemoteAuthServer>,
    ) => {
      const publicUrl = new URL(`http://127.0.0.1:${await freePort()}`);
      if (row.refuses !== undefined) {
        await expect(build(row, publicUrl)).rejects.toThrow(row.refuses);
        return;
      }
      const server = await build(row, publicUrl);
      opened.push(server);
      expect(server.resource.origin).toBe(publicUrl.origin);
    },
  );

  // The same rule has to hold for a config that arrived as YAML, not only for a hand-built object.
  it('refuses a plaintext jwks_uri that came through parseConfig', async () => {
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      auth: {
        mode: 'oidc',
        oidc: {
          issuer: HTTPS_ISSUER,
          jwks_uri: 'http://jwks.attacker-reachable.example/keys',
          allowed_subjects: ['owner-sub'],
        },
      },
    });
    await expect(
      createRemoteAuthApp(plugin, cfg, {
        publicUrl: new URL(`http://127.0.0.1:${await freePort()}`),
        fetchFn: discoveryStub({
          issuer: HTTPS_ISSUER,
          jwks_uri: 'https://kc.corp.example/realms/parley/certs',
        }),
      }),
    ).rejects.toThrow(/jwks_uri must use https outside loopback/);
  });
});
