import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { STATUS_CODES } from 'node:http';
import { format } from 'node:util';
import express, { type Response as ExpressResponse } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_ENVS,
  FRONT_DOORS,
  TRIGGERS,
  appFor,
  closeFrontDoors,
  internalsLeaked,
  secretsLeaked,
  triggerNamed,
  type BootEnv,
  type FrontDoor,
  type Trigger,
} from '../test-support/front-doors.js';
import { errorDigest, hardenErrorSurface } from './error-surface.js';

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

/**
 * A leak is a property of a SINK, not of a route, and this file used to inspect one of them: the
 * response body. The other sink is the operator's log, and it was the leaking one — the terminal
 * handler passed the error object itself to `console.error`, which prints an Error's own enumerable
 * properties, and body-parser attaches the raw request body to the failures it raises. So both
 * sinks are graded from the same cell, against the same canaries, and the log carries a SIZE bound
 * too: it is reachable unauthenticated, so an unbounded write is a service an anonymous caller can
 * spend at whatever rate it likes.
 */
const LOG_BUDGET_BYTES = 1024;

describe('no route publishes internal error detail, whatever the boot environment', () => {
  let logged: ReturnType<typeof vi.spyOn>;
  let written: string[];

  beforeEach(() => {
    written = [];
    logged = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(format(...args));
    });
  });
  afterEach(() => {
    logged.mockRestore();
  });

  const loggedText = (): string => written.join('\n');

  async function fire(door: FrontDoor, env: BootEnv, route: string, t: Trigger): Promise<string> {
    const { base, authorization } = await appFor(door, env);
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { ...t.headers, authorization },
      body: t.body,
    });
    return res.text();
  }

  it.each(MATRIX)(
    '%s',
    async (_name: string, door: FrontDoor, env: BootEnv, route: string, t: Trigger) => {
      const body = await fire(door, env, route, t);
      const log = loggedText();
      expectNoInternals(body);
      expect(secretsLeaked(body), body).toEqual([]);
      expect(secretsLeaked(log), log).toEqual([]);
      expect(
        log.length,
        `${log.length} bytes logged for a ${t.body.length}-byte body: ${log}`,
      ).toBeLessThan(LOG_BUDGET_BYTES);
    },
  );

  // The bound above could be met by a log that grows slower than the body rather than not at all.
  it.each(
    FRONT_DOORS.map((door): [string, FrontDoor] => [door.name, door]),
  )('%s: what the log costs does not follow what the caller sends', async (_name, door) => {
    const base = triggerNamed(door.terminal.trigger);
    const grown: Trigger = { ...base, body: base.body.repeat(8) };
    await fire(door, 'production', door.terminal.route, base);
    const small = loggedText().length;
    written = [];
    await fire(door, 'production', door.terminal.route, grown);
    expect(loggedText().length, 'the log grew with the request body').toBeLessThanOrEqual(small);
  });

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
      // Rendered the way console.error itself renders them: the handler now logs a constructed
      // descriptor rather than the error, and `String()` on an object says only [object Object].
      const reports = logged.mock.calls.map((c) => format(...(c as unknown[])));
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

/**
 * The digest itself, on the shapes the matrix cannot reach cheaply. Two things are graded here that
 * a request cannot show: that nothing beyond the named fields survives — an error carries whatever
 * middleware chose to hang on it, and `console.error` prints every one of them — and that what does
 * survive is neutered as TEXT. A log line is read in a terminal and parsed by a shipper, and
 * `JSON.stringify` is not the guard people take it for: DEL, C1, the bidi overrides, U+2028 and the
 * BOM all pass through it raw, and each of them rewrites or truncates the record around them.
 */
describe('the operator digest carries the diagnosis and nothing the caller sent', () => {
  const bodyParserish = (): unknown =>
    Object.assign(new Error('request entity too large'), {
      name: 'PayloadTooLargeError',
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
      body: 'passphrase=hunter2&client_secret=s3cret',
    });

  it('drops every attached property of a caller-shaped failure, message included', () => {
    const digest = errorDigest(bodyParserish());
    expect(digest).toEqual({ status: 413, name: 'PayloadTooLargeError', type: 'entity.too.large' });
    expect(JSON.stringify(digest)).not.toContain('hunter2');
    expect(JSON.stringify(digest)).not.toContain('s3cret');
  });

  it('keeps the message and the stack of an internal fault, which is what a 500 is for', () => {
    const digest = errorDigest(new Error('the read-state file is unreadable'));
    expect(digest.status).toBe(500);
    expect(digest.message).toBe('the read-state file is unreadable');
    expect(String(digest.stack)).toContain('error-surface.test.ts');
  });

  it('bounds what one request can write, and says how much it withheld', () => {
    const digest = errorDigest(new Error('x'.repeat(5_000)));
    expect(String(digest.message)).toHaveLength(120 + '[+4880]'.length);
    expect(String(digest.message).endsWith('[+4880]')).toBe(true);
  });

  // Measured: `JSON.stringify` escapes the first row and the last, and lets every row between
  // it straight through — which is why the log's own escape has to be wider than JSON's.
  it.each([
    ['C0, forging a second record', '\u0000\u001b\u005b\u0032\u004b\u000a', '\\u0000\\u001b[2K\\u000a'],
    ['DEL and C1, an escape a terminal obeys', '\u007f\u009d', '\\u007f\\u009d'],
    ['a bidi override, reversing the rest of the line', '\u202e', '\\u202e'],
    ['a bidi isolate', '\u2066\u2069', '\\u2066\\u2069'],
    ['U+2028, which ends a record in a JSON-lines reader', '\u2028\u2029', '\\u2028\\u2029'],
    ['a format character no hand-written list had, BOM and ZWSP', '\ufeff\u200b', '\\ufeff\\u200b'],
    ['a surrogate with no partner', '\ud800', '\\ud800'],
  ])('escapes %s', (_name, planted, escaped) => {
    expect(errorDigest(new Error(`before${planted}after`)).message).toBe(`before${escaped}after`);
  });

  it.each([
    ['ordinary text', 'failed to bind 127.0.0.1:8080 (EADDRINUSE) — retrying'],
    // A well-formed astral character is ONE code point under `u`, so the lone-surrogate range must
    // not touch it — the escape that flattens an attack must not also mangle an operator's log.
    ['an astral character', 'the topic named \u{1F600} could not be resolved'],
  ])('leaves %s alone (negative control)', (_name, message) => {
    expect(errorDigest(new Error(message)).message).toBe(message);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare string thrown instead of an Error', 'exploded'],
  ])('answers for %s without reading a property off it', (_name, thrown) => {
    expect(errorDigest(thrown)).toEqual({
      status: 500,
      name: undefined,
      type: undefined,
      message: undefined,
      stack: undefined,
    });
  });
});
