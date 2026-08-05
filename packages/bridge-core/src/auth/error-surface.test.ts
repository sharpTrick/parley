import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { STATUS_CODES } from 'node:http';
import express, { type Response as ExpressResponse } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_ENVS,
  FRONT_DOORS,
  TRIGGERS,
  appFor,
  closeFrontDoors,
  internalsLeaked,
  triggerNamed,
  type BootEnv,
  type FrontDoor,
  type Trigger,
} from '../testing/front-doors.js';
import { hardenErrorSurface } from './error-surface.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

afterAll(closeFrontDoors);

function expectNoInternals(body: string): void {
  expect(internalsLeaked(body), body).toEqual([]);
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

/**
 * The other axis of the same handler: WHEN the error arrives. Past the first byte the handler can
 * no longer render anything, and attempting to must not raise a second error that displaces the
 * original — the only report of the real failure — in the operator's log.
 */
interface ErrorTiming {
  name: string;
  /** Leaves the response in the phase this row is about, then the route raises. */
  begin: (res: ExpressResponse) => void;
  /** What the client is still owed: a body, or nothing because the socket was cut. */
  client: { status: number; body: string } | 'aborted';
  /** Whether the original error must continue past the handler rather than be rendered by it. */
  delegates: boolean;
}

const ERROR_TIMINGS: ErrorTiming[] = [
  {
    name: 'before any byte is written',
    begin: () => undefined,
    client: { status: 500, body: '500 Internal Server Error' },
    delegates: false,
  },
  {
    name: 'after a partial write, with the response still open',
    begin: (res) => {
      res.status(200).type('txt');
      res.write('partial');
    },
    client: 'aborted',
    delegates: true,
  },
  {
    name: 'after the response was already ended',
    begin: (res) => {
      res.status(200).type('txt').send('partial');
    },
    client: { status: 200, body: 'partial' },
    delegates: true,
  },
];

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
    app.post('/timing/:row', (req, res, next) => {
      const row = ERROR_TIMINGS[Number(req.params.row)];
      if (row === undefined) throw new Error('unknown timing');
      row.begin(res);
      next(new Error(markerFor(Number(req.params.row))));
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

  it.each(ERROR_TIMINGS.map((t, i): [string, ErrorTiming, number] => [t.name, t, i]))(
    'an error arriving %s is answered without the handler raising a second one',
    async (_name: string, timing: ErrorTiming, row: number) => {
      let observed: { status: number; body: string } | 'aborted';
      try {
        const res = await fetch(`${base}/timing/${row}`, { method: 'POST' });
        observed = { status: res.status, body: await res.text() };
      } catch {
        observed = 'aborted';
      }
      expect(observed).toEqual(timing.client);

      await settled();
      const reports = logged.mock.calls.map((c) => c.map((a) => String(a)).join(' '));
      expect(reports.join('\n')).not.toMatch(/Cannot set headers|ERR_HTTP_HEADERS_SENT/);
      expect(reports.filter((r) => r.includes(markerFor(row)))).toHaveLength(
        timing.delegates ? 2 : 1,
      );
    },
  );
});

const markerFor = (row: number): string => `error-timing-row-${row}`;

/** Express logs the delegated error after the client sees the socket close; give it that tick. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
