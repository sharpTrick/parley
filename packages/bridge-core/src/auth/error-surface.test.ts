import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { ownerVerifierFromPassphrase } from './owner.js';
import { createOAuthRemoteApp, type OAuthRemoteServer } from './remote.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

let plugin: FakePlugin;

beforeAll(async () => {
  plugin = new FakePlugin();
  await plugin.connect({});
});
afterAll(async () => {
  await plugin.disconnect();
});

/**
 * Express picks its stack-rendering branch from the app's `env`, which it seeds from NODE_ENV at
 * construction, so the boot environment is an axis of this matrix rather than a fixture: the
 * shipped run command in examples/self-host-remote/README.md sets neither.
 */
const BOOT_ENVS = ['unset', 'development', 'production'] as const;
type BootEnv = (typeof BOOT_ENVS)[number];

const apps = new Map<BootEnv, { server: OAuthRemoteServer; base: string }>();

async function appFor(env: BootEnv): Promise<string> {
  const existing = apps.get(env);
  if (existing !== undefined) return existing.base;
  const before = process.env.NODE_ENV;
  if (env === 'unset') delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server = createOAuthRemoteApp(
      plugin,
      parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] }),
      { issuerUrl: new URL(base), verifyOwner: ownerVerifierFromPassphrase('open sesame') },
    );
    await server.listen(port);
    apps.set(env, { server, base });
    return base;
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

afterAll(async () => {
  for (const { server } of apps.values()) await server.close();
  apps.clear();
});

/** Every route this front door mounts. A hand-mounted addition should appear here. */
const ROUTES = ['/mcp', '/authorize', '/token', '/register', '/revoke', '/parley/consent'] as const;

/**
 * Failures raised by the framework itself, before any Parley handler runs — the ones no route's own
 * try/catch can see, which is exactly why they reach Express's default handler.
 */
interface Trigger {
  name: string;
  headers: Record<string, string>;
  body: string;
}

const TRIGGERS: Trigger[] = [
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

const CWD = process.cwd();
const STACK_FRAME = /\bat \S+ \(/;

function expectNoInternals(body: string): void {
  expect(body).not.toContain('node_modules');
  expect(body).not.toContain(CWD);
  expect(body).not.toMatch(STACK_FRAME);
}

const MATRIX = BOOT_ENVS.flatMap((env) =>
  ROUTES.flatMap((route) =>
    TRIGGERS.map((t): [string, BootEnv, string, Trigger] => [
      `NODE_ENV=${env} ${route} with a ${t.name}`,
      env,
      route,
      t,
    ]),
  ),
);

describe('no route publishes internal error detail, whatever the boot environment', () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it.each(MATRIX)('%s', async (_name: string, env: BootEnv, route: string, t: Trigger) => {
    const base = await appFor(env);
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: t.headers, body: t.body });
    expectNoInternals(await res.text());
  });

  // A route mounted PAST the terminal handler is not covered by it, so the app's `env` is the only
  // thing left between such a route and Express's stack-rendering fallback.
  it.each(BOOT_ENVS.map((e) => [e]))(
    'NODE_ENV=%s: a route mounted after the terminal handler still cannot render a stack',
    async (env: BootEnv) => {
      const base = await appFor(env);
      const app = apps.get(env)!.server.app;
      const path = `/late-${env}`;
      app.post(path, () => {
        throw new Error('boom');
      });
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      expect(res.status).toBe(500);
      expectNoInternals(await res.text());
    },
  );

  // The matrix above is only a leak detector; without this row a change that stopped the triggers
  // reaching Express's fallback at all would leave every cell green and prove nothing.
  it.each(BOOT_ENVS.map((e) => [e]))(
    'NODE_ENV=%s: an oversize consent body really does reach the terminal handler (413, logged, no stack)',
    async (env: BootEnv) => {
      const base = await appFor(env);
      const res = await fetch(`${base}/parley/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `passphrase=${'a'.repeat(200_000)}`,
      });
      expect(res.status).toBe(413);
      const body = await res.text();
      expectNoInternals(body);
      expect(body).not.toContain('PayloadTooLargeError');
      expect(logged).toHaveBeenCalled();
    },
  );
});
