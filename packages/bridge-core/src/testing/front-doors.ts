import { createServer, type AddressInfo } from 'node:net';
import type { Express } from 'express';
import * as core from '../index.js';
import { parseConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from './fake-plugin.js';
import { startFakeOidc, type FakeOidc } from './fake-oidc.js';

/**
 * Every front door this package hands an operator, DERIVED from the public surface so that a
 * factory written later joins the audit whether or not anyone remembers this file.
 *
 * A front door is an exported factory whose (awaited) result carries an Express `app`: that is what
 * a deployment binds to a socket, and so what any app-wide control — the error surface here,
 * security headers or rate limiting next — has to be graded on. {@link DoorName} computes that set
 * from `../index.js` structurally, and {@link DOORS} is checked against it in BOTH directions: a
 * factory with no row fails to compile, and a row naming a non-door fails too.
 *
 * Only the SUBJECT LIST is derived. Each door still supplies its own boot (they take different
 * arguments), the routes it actually mounts, and a bearer for its own /mcp, so that a framework
 * failure reaches the body parser instead of stopping at a 401 and proving nothing.
 */
type AwaitedReturn<T> = T extends (...args: never[]) => infer R
  ? R extends Promise<infer U>
    ? U
    : R
  : never;

type IsFrontDoorFactory<T> = T extends (...args: never[]) => unknown
  ? AwaitedReturn<T> extends { app: Express }
    ? true
    : false
  : false;

export type DoorName = {
  [K in keyof typeof core]-?: IsFrontDoorFactory<(typeof core)[K]> extends true ? K : never;
}[keyof typeof core];

/** Keep this assertion, so that a {@link DoorName} that collapsed to `never` — which would make the
 *  record below satisfy an empty type and grade nothing — is a compile error rather than a green
 *  suite. */
type Assert<T extends true> = T;
export type DoorNamesAreDerivable = Assert<[DoorName] extends [never] ? false : true>;

export type DoorServer = { [K in DoorName]: AwaitedReturn<(typeof core)[K]> }[DoorName];

export interface Booted {
  server: DoorServer;
  base: string;
  authorization: string;
}

interface Fixtures {
  plugin: FakePlugin;
  idp: FakeOidc;
}

export interface FrontDoor {
  name: DoorName;
  routes: readonly string[];
  /** Route + trigger whose failure really does reach the terminal handler on this door. */
  terminal: { route: string; trigger: string; status: number };
  boot: (port: number, fx: Fixtures) => Promise<Booted>;
}

/**
 * Express picks its stack-rendering branch from the app's `env`, which it seeds from NODE_ENV at
 * construction, so the boot environment is an axis of this matrix rather than a fixture: the
 * shipped run command in examples/self-host-remote/README.md sets neither.
 */
export const BOOT_ENVS = ['unset', 'development', 'production'] as const;
export type BootEnv = (typeof BOOT_ENVS)[number];

/**
 * Failures raised by the framework itself, before any Parley handler runs — the ones no route's own
 * try/catch can see, which is exactly why they reach Express's default handler.
 */
export interface Trigger {
  name: string;
  headers: Record<string, string>;
  body: string;
}

export const TRIGGERS: Trigger[] = [
  {
    name: 'body over the 100 KB parser limit (urlencoded)',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `passphrase=${'a'.repeat(200_000)}`,
  },
  {
    name: 'body over the 100 KB parser limit (json)',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['x'.repeat(200_000)] }),
  },
  {
    name: 'unparseable body for the declared type',
    headers: { 'content-type': 'application/json' },
    body: '{"redirect_uris":',
  },
  {
    name: 'unsupported charset',
    headers: { 'content-type': 'application/json; charset=utf-7' },
    body: '{}',
  },
  {
    name: 'content-encoding that does not match the body',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: 'not gzip at all',
  },
];

export const triggerNamed = (name: string): Trigger => {
  const found = TRIGGERS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no trigger named ${name}`);
  return found;
};

const CWD = process.cwd();
const STACK_FRAME = /\bat \S+ \(/;

/** What a response body gave away about the server that sent it. Empty is the only pass. */
export function internalsLeaked(body: string): string[] {
  const leaks: string[] = [];
  if (body.includes('node_modules')) leaks.push('names node_modules');
  if (body.includes(CWD)) leaks.push('names the install directory');
  const frame = STACK_FRAME.exec(body);
  if (frame !== null) leaks.push(`renders a stack frame (${frame[0]})`);
  return leaks;
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

function baseCfg(): ParleyConfig {
  return parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
}

/** The built-in AS mints its own tokens; both builtin-mode doors reach /mcp through one. */
function ownerBearer(server: DoorServer): string {
  const issuer = server as unknown as {
    provider: {
      issue(clientId: string, scopes: string[], resource: string): { access_token: string };
    };
    resource: URL;
  };
  const minted = issuer.provider.issue('error-surface-probe', ['mcp'], issuer.resource.href);
  return `Bearer ${minted.access_token}`;
}

const OAUTH_ROUTES = ['/mcp', '/authorize', '/token', '/register', '/revoke', '/parley/consent'];
const OVERSIZE_FORM = {
  route: '/parley/consent',
  trigger: 'body over the 100 KB parser limit (urlencoded)',
  status: 413,
};
const OVERSIZE_JSON = {
  route: '/mcp',
  trigger: 'body over the 100 KB parser limit (json)',
  status: 413,
};

const DOORS = {
  createRemoteHttpApp: {
    routes: ['/mcp'],
    terminal: OVERSIZE_JSON,
    boot: async (port, { plugin }) => ({
      server: core.createRemoteHttpApp(plugin, baseCfg(), { insecureNoAuth: true }),
      base: `http://127.0.0.1:${port}`,
      authorization: 'Bearer this-door-runs-without-auth',
    }),
  },
  createOAuthRemoteApp: {
    routes: OAUTH_ROUTES,
    terminal: OVERSIZE_FORM,
    boot: async (port, { plugin }) => {
      const base = `http://127.0.0.1:${port}`;
      const server = core.createOAuthRemoteApp(plugin, baseCfg(), {
        issuerUrl: new URL(base),
        verifyOwner: core.ownerVerifierFromPassphrase('open sesame'),
      });
      return { server, base, authorization: ownerBearer(server) };
    },
  },
  createOidcRemoteApp: {
    routes: ['/mcp'],
    terminal: OVERSIZE_JSON,
    boot: async (port, { plugin, idp }) => {
      const base = `http://127.0.0.1:${port}`;
      const server = await core.createOidcRemoteApp(plugin, baseCfg(), {
        publicUrl: new URL(base),
        oidc: { issuer: idp.issuer, allowed_subjects: ['owner-sub'] } as never,
      });
      const token = await idp.mint({ aud: server.resource.href });
      return { server, base, authorization: `Bearer ${token}` };
    },
  },
  createRemoteAuthApp: {
    routes: ['/mcp', '/parley/consent'],
    terminal: OVERSIZE_FORM,
    boot: async (port, { plugin }) => {
      const base = `http://127.0.0.1:${port}`;
      const server = await core.createRemoteAuthApp(plugin, baseCfg(), {
        publicUrl: new URL(base),
        verifyOwner: core.ownerVerifierFromPassphrase('open sesame'),
      });
      return { server, base, authorization: ownerBearer(server) };
    },
  },
} satisfies Record<DoorName, Omit<FrontDoor, 'name'>>;

export const FRONT_DOORS: FrontDoor[] = Object.entries(DOORS).map(([name, door]) => ({
  name: name as DoorName,
  ...door,
}));

/**
 * The same set read back off the running module, so that the derivation is graded by the SUITE and
 * not only by the type-checker — and so that a door dropped or renamed on the public surface is a
 * failing row rather than a matrix that quietly walks fewer doors.
 */
export function exportedDoorFactories(): string[] {
  return Object.entries(core)
    .filter(([name, value]) => typeof value === 'function' && /^create[A-Z]\w*App$/.test(name))
    .map(([name]) => name)
    .sort();
}

let fixtures: Promise<Fixtures> | undefined;
const booted = new Map<string, Booted>();

function fixturesUp(): Promise<Fixtures> {
  fixtures ??= (async () => {
    const plugin = new FakePlugin();
    await plugin.connect({});
    return { plugin, idp: await startFakeOidc() };
  })();
  return fixtures;
}

/** The door booted under `env` and listening. Cached: every boot binds a socket. */
export async function appFor(door: FrontDoor, env: BootEnv): Promise<Booted> {
  const key = `${door.name}|${env}`;
  const existing = booted.get(key);
  if (existing !== undefined) return existing;
  const fx = await fixturesUp();
  const before = process.env.NODE_ENV;
  if (env === 'unset') delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;
  try {
    const port = await freePort();
    const app = await door.boot(port, fx);
    await app.server.listen(port);
    booted.set(key, app);
    return app;
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

export async function closeFrontDoors(): Promise<void> {
  for (const { server } of booted.values()) await server.close();
  booted.clear();
  const fx = await fixtures;
  fixtures = undefined;
  if (fx === undefined) return;
  await fx.idp.close();
  await fx.plugin.disconnect();
}
