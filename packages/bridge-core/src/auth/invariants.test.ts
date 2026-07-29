import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { parseConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startFakeOidc, type FakeOidc } from '../testing/fake-oidc.js';
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
];

const shapeName = (s: BaseUrlShape): string =>
  `${s.shape} ${'boots' in s.outcome ? 'boots' : 'is refused'}`;

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
