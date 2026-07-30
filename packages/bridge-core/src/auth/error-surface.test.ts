import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { STATUS_CODES } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startFakeOidc, type FakeOidc } from '../testing/fake-oidc.js';
import { hardenErrorSurface } from './error-surface.js';
import { createOidcRemoteApp } from './oidc-remote.js';
import { ownerVerifierFromPassphrase } from './owner.js';
import { createOAuthRemoteApp } from './remote.js';
import type { RemoteAuthServer } from './remote-auth.js';

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
let idp: FakeOidc;

beforeAll(async () => {
  plugin = new FakePlugin();
  await plugin.connect({});
  idp = await startFakeOidc();
});
afterAll(async () => {
  await plugin.disconnect();
  await idp.close();
});

function baseCfg(): ParleyConfig {
  return parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
}

/**
 * Express picks its stack-rendering branch from the app's `env`, which it seeds from NODE_ENV at
 * construction, so the boot environment is an axis of this matrix rather than a fixture: the
 * shipped run command in examples/self-host-remote/README.md sets neither.
 */
const BOOT_ENVS = ['unset', 'development', 'production'] as const;
type BootEnv = (typeof BOOT_ENVS)[number];

interface Booted {
  server: RemoteAuthServer;
  base: string;
  authorization: string;
}

/**
 * Every front door hardenErrorSurface is applied to. A control applied in one factory and forgotten
 * in the next is invisible unless the matrix is driven from this list — each door supplies the
 * routes it actually mounts and a bearer for its own /mcp, so that a framework failure reaches the
 * body parser instead of stopping at a 401 and proving nothing.
 */
interface FrontDoor {
  name: string;
  routes: readonly string[];
  /** Route + trigger whose failure really does reach the terminal handler on this door. */
  terminal: { route: string; trigger: string; status: number };
  boot: (port: number) => Promise<Booted>;
}

const FRONT_DOORS: FrontDoor[] = [
  {
    name: 'built-in OAuth',
    routes: ['/mcp', '/authorize', '/token', '/register', '/revoke', '/parley/consent'],
    terminal: { route: '/parley/consent', trigger: 'body over the 100 KB parser limit (urlencoded)', status: 413 },
    boot: async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const server = createOAuthRemoteApp(plugin, baseCfg(), {
        issuerUrl: new URL(base),
        verifyOwner: ownerVerifierFromPassphrase('open sesame'),
      });
      const minted = (
        server.provider as unknown as {
          issue(clientId: string, scopes: string[], resource: string): { access_token: string };
        }
      ).issue('error-surface-probe', ['mcp'], server.resource.href);
      return { server, base, authorization: `Bearer ${minted.access_token}` };
    },
  },
  {
    name: 'delegated OIDC',
    routes: ['/mcp'],
    terminal: { route: '/mcp', trigger: 'body over the 100 KB parser limit (json)', status: 413 },
    boot: async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const server = await createOidcRemoteApp(plugin, baseCfg(), {
        publicUrl: new URL(base),
        oidc: { issuer: idp.issuer, allowed_subjects: ['owner-sub'] } as never,
      });
      const token = await idp.mint({ aud: server.resource.href });
      return { server, base, authorization: `Bearer ${token}` };
    },
  },
];

const apps = new Map<string, Booted>();

async function appFor(door: FrontDoor, env: BootEnv): Promise<Booted> {
  const key = `${door.name}|${env}`;
  const existing = apps.get(key);
  if (existing !== undefined) return existing;
  const before = process.env.NODE_ENV;
  if (env === 'unset') delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;
  try {
    const port = await freePort();
    const booted = await door.boot(port);
    await booted.server.listen(port);
    apps.set(key, booted);
    return booted;
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

afterAll(async () => {
  for (const { server } of apps.values()) await server.close();
  apps.clear();
});

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

const triggerNamed = (name: string): Trigger => {
  const found = TRIGGERS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no trigger named ${name}`);
  return found;
};

const CWD = process.cwd();
const STACK_FRAME = /\bat \S+ \(/;

function expectNoInternals(body: string): void {
  expect(body).not.toContain('node_modules');
  expect(body).not.toContain(CWD);
  expect(body).not.toMatch(STACK_FRAME);
}

const MATRIX = FRONT_DOORS.flatMap((door) =>
  BOOT_ENVS.flatMap((env) =>
    door.routes.flatMap((route) =>
      TRIGGERS.map((t): [string, FrontDoor, BootEnv, string, Trigger] => [
        `${door.name} NODE_ENV=${env} ${route} with a ${t.name}`,
        door,
        env,
        route,
        t,
      ]),
    ),
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

  it.each(MATRIX)(
    '%s',
    async (_name: string, door: FrontDoor, env: BootEnv, route: string, t: Trigger) => {
      const { base, authorization } = await appFor(door, env);
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { ...t.headers, authorization },
        body: t.body,
      });
      expectNoInternals(await res.text());
    },
  );

  const DOOR_ENVS = FRONT_DOORS.flatMap((door) =>
    BOOT_ENVS.map((env): [string, FrontDoor, BootEnv] => [`${door.name} NODE_ENV=${env}`, door, env]),
  );

  // A route mounted PAST the terminal handler is not covered by it, so the app's `env` is the only
  // thing left between such a route and Express's stack-rendering fallback.
  it.each(DOOR_ENVS)(
    '%s: a route mounted after the terminal handler still cannot render a stack',
    async (_name: string, door: FrontDoor, env: BootEnv) => {
      const { base, server } = await appFor(door, env);
      const path = `/late-${env}`;
      server.app.post(path, () => {
        throw new Error('boom');
      });
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      expect(res.status).toBe(500);
      expectNoInternals(await res.text());
    },
  );

  // The matrix above is only a leak detector; without this row a change that stopped the triggers
  // reaching Express's fallback at all would leave every cell green and prove nothing. It also
  // pins what ONLY the terminal handler does — plaintext, a bare status line, the [parley] prefix —
  // so that deleting it on any one door turns this red instead of being absorbed by finalhandler.
  it.each(DOOR_ENVS)(
    '%s: a framework failure really does reach the terminal handler',
    async (_name: string, door: FrontDoor, env: BootEnv) => {
      const { base, authorization } = await appFor(door, env);
      const t = triggerNamed(door.terminal.trigger);
      const res = await fetch(`${base}${door.terminal.route}`, {
        method: 'POST',
        headers: { ...t.headers, authorization },
        body: t.body,
      });
      expect(res.status).toBe(door.terminal.status);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const body = await res.text();
      expect(body).toBe(`${door.terminal.status} ${STATUS_CODES[door.terminal.status]}`);
      expectNoInternals(body);
      expect(logged).toHaveBeenCalledWith('[parley] request failed:', expect.anything());
    },
  );
});

/**
 * The terminal handler's own contract. The factories mount it last, so no test above can put a
 * throwing route in FRONT of it — and everything the env pin already delivers (a stackless body,
 * finalhandler's own 4xx/5xx clamp) is delivered whether it runs or not. These rows exercise it
 * directly, on the shapes an error can arrive in.
 */
interface ErrorShape {
  name: string;
  make: () => unknown;
  status: number;
}

const ERROR_SHAPES: ErrorShape[] = [
  { name: 'no status at all', make: () => new Error('boom'), status: 500 },
  {
    name: 'a framework status',
    make: () => Object.assign(new Error('too big'), { status: 413 }),
    status: 413,
  },
  {
    name: 'statusCode rather than status',
    make: () => Object.assign(new Error('too big'), { statusCode: 413 }),
    status: 413,
  },
  {
    name: 'a success status on a failure',
    make: () => Object.assign(new Error('nope'), { status: 200 }),
    status: 500,
  },
  {
    name: 'a status past the end of the HTTP range',
    make: () => Object.assign(new Error('nope'), { status: 999 }),
    status: 500,
  },
  {
    name: 'a fractional status',
    make: () => Object.assign(new Error('nope'), { status: 1.5 }),
    status: 500,
  },
  {
    name: 'a status that is a string',
    make: () => Object.assign(new Error('nope'), { status: '413' }),
    status: 500,
  },
  { name: 'a bare string thrown instead of an Error', make: () => 'exploded', status: 500 },
];

describe('the terminal error handler answers every error shape with a bare status line', () => {
  let logged: ReturnType<typeof vi.spyOn>;
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const app = express();
    app.post('/throw/:shape', (req, _res, next) => {
      const shape = ERROR_SHAPES[Number(req.params.shape)];
      if (shape === undefined) throw new Error('unknown shape');
      next(shape.make());
    });
    app.post('/after-send', (_req, res, next) => {
      res.status(200).type('txt').send('partial');
      next(new Error('raised once the response was already on the wire'));
    });
    hardenErrorSurface(app);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const server = app.listen(port, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it.each(ERROR_SHAPES.map((s, i): [string, ErrorShape, number] => [s.name, s, i]))(
    '%s',
    async (_name: string, shape: ErrorShape, index: number) => {
      const res = await fetch(`${base}/throw/${index}`, { method: 'POST' });
      expect(res.status).toBe(shape.status);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await res.text()).toBe(`${shape.status} ${STATUS_CODES[shape.status]}`);
      expect(logged).toHaveBeenCalledWith('[parley] request failed:', expect.anything());
    },
  );

  // Re-sending on a response already on the wire throws ERR_HTTP_HEADERS_SENT inside the error
  // handler, which kills the connection mid-body. The client must still receive what was sent.
  it('leaves a response that was already sent alone', async () => {
    const res = await fetch(`${base}/after-send`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('partial');
  });
});
