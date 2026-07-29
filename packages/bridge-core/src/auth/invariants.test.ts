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
 * The advertised RFC 9728 resource id is `publicUrl + /mcp`, which keeps only scheme, host and
 * port. A base URL varying in ANY other component is therefore either refused, or advertised as
 * something the operator did not write — so every accepted row states the exact href it must
 * produce, and the matrix varies one component at a time rather than the path alone. Both front
 * doors run it: oidc mode does not route through the SDK's own issuer check, so a rule enforced
 * only there would leave it the weaker of the two.
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

describe('the advertised resource id must match the URL the endpoint is served at', () => {
  const FRONT_DOORS: Array<[string, (base: URL) => Promise<RemoteAuthServer>]> = [
    [
      'built-in OAuth',
      async (base) =>
        createOAuthRemoteApp(plugin, baseCfg(), { issuerUrl: base, verifyOwner: async () => true }),
    ],
    [
      'delegated OIDC',
      async (base) =>
        createOidcRemoteApp(plugin, baseCfg(), {
          publicUrl: base,
          oidc: { issuer: idp.issuer, clock_skew_s: 30, allowed_subjects: ['owner-sub'] } as never,
        }),
    ],
  ];

  const ROWS = FRONT_DOORS.flatMap(([door, build]) =>
    BASE_URL_SHAPES.map((s): [string, BaseUrlShape, (base: URL) => Promise<RemoteAuthServer>] => [
      `${door} front door: ${shapeName(s)}`,
      s,
      build,
    ]),
  );

  it.each(ROWS)(
    '%s',
    async (
      _name: string,
      s: BaseUrlShape,
      build: (base: URL) => Promise<RemoteAuthServer>,
    ) => {
      const port = String(await freePort());
      const base = new URL(s.shape.replaceAll('PORT', port));

      if ('refuses' in s.outcome) {
        await expect(build(base)).rejects.toThrow(s.outcome.refuses);
        return;
      }
      const server = await build(base);
      opened.push(server);
      expect(server.resource.href).toBe(s.outcome.boots.replaceAll('PORT', port));
    },
  );
});
