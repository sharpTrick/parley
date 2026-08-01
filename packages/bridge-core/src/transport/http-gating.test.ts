import { request } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import {
  INITIALIZE,
  MCP_HEADERS,
  NO_PRESENCE,
  mcpPost,
  serveRemoteHttp,
} from '../testing/http-app.js';
import { createRemoteHttpApp, type RemoteHttpOptions } from './http.js';

/**
 * One subject: what the /mcp endpoint refuses, and what it refuses to disclose. Everything here is
 * a request that must not reach the tools — an unauthenticated one, one whose `Host` names an
 * attacker — or a failure that must not reach the client verbatim.
 */

const served = (opts: RemoteHttpOptions = {}): ReturnType<typeof serveRemoteHttp> =>
  serveRemoteHttp(opts, NO_PRESENCE);

describe('reactive HTTP: fail closed by default', () => {
  it('401s /mcp when neither protect nor insecureNoAuth is set (no-arg ≠ no-auth)', async () => {
    const { port, teardown } = await served(); // no auth option → fail CLOSED
    try {
      const res = await mcpPost(port);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32001);
    } finally {
      await teardown();
    }
  });

  /**
   * A middleware chain verified on ONE route and assumed on its siblings is a route away from
   * shipping unauthenticated: dropping `protect` from the GET wiring turns an unauthenticated probe
   * from 401 into a 405 that confirms the endpoint exists, and nothing in a POST-only auth test
   * moves. So grade the whole METHOD × auth-config grid, with the method list DERIVED from the
   * routes the app registers — a new route joins the grid instead of quietly sitting outside it.
   */
  describe('every mounted method is gated, on every auth config', () => {
    const mountedMethods = (): string[] => {
      const p = new FakePlugin();
      const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'], presence: { enabled: false } });
      const { app } = createRemoteHttpApp(p, cfg, { insecureNoAuth: true });
      const layers = (app as unknown as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })
        .router.stack;
      return layers
        .filter((l) => l.route?.path === '/mcp')
        .flatMap((l) => Object.keys(l.route!.methods))
        .map((m) => m.toUpperCase())
        .sort();
    };

    // Pin membership by value: a generated grid cannot see a route that was never registered, and
    // "the auth test covers every method" is only true while this list is the whole surface.
    it('mounts exactly POST, GET and DELETE on /mcp', () => {
      expect(mountedMethods()).toEqual(['DELETE', 'GET', 'POST']);
    });

    const teapot: RequestHandler = (_req, res) => {
      res.status(418).end();
    };
    const waveThrough: RequestHandler = (_req, _res, next) => next();

    // status per (auth config × method); PUT is UNMOUNTED, so its 404 proves the grid is reading
    // the routing table and not just echoing one middleware's answer.
    const GRID: Array<[name: string, opts: RemoteHttpOptions, byMethod: Record<string, number>]> = [
      ['fail-closed default', {}, { POST: 401, GET: 401, DELETE: 401, PUT: 404 }],
      ['insecureNoAuth: true', { insecureNoAuth: true }, { POST: 200, GET: 405, DELETE: 405, PUT: 404 }],
      ['protect rejects', { protect: teapot }, { POST: 418, GET: 418, DELETE: 418, PUT: 404 }],
      ['protect accepts', { protect: waveThrough }, { POST: 200, GET: 405, DELETE: 405, PUT: 404 }],
    ];

    it.each(GRID)('%s', async (_name, opts, byMethod) => {
      expect(Object.keys(byMethod).filter((m) => m !== 'PUT').sort()).toEqual(mountedMethods());
      const { port, teardown } = await served(opts);
      try {
        for (const [method, status] of Object.entries(byMethod)) {
          const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method,
            ...(method === 'POST' ? { headers: MCP_HEADERS, body: INITIALIZE } : {}),
          });
          expect(`${method} ${res.status}`).toBe(`${method} ${status}`);
        }
      } finally {
        await teardown();
      }
    });
  });
});

describe('reactive HTTP: 500 path hides internal detail, logs it', () => {
  it('returns generic "internal error" and console.errors the real error', async () => {
    const SECRET = 'SECRET /var/lib/parley.db backend driver detail';
    const { port, teardown } = await served({ insecureNoAuth: true });
    const handleSpy = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
      .mockRejectedValue(new Error(SECRET));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await mcpPost(port);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe('internal error'); // generic, not err.message
      expect(JSON.stringify(body)).not.toContain('SECRET'); // no internal detail leaked to client
      // … while the real error reached the operator via stderr.
      const logged = errSpy.mock.calls.some((call) =>
        call.some((arg) => arg instanceof Error && arg.message === SECRET),
      );
      expect(logged).toBe(true);
    } finally {
      handleSpy.mockRestore();
      errSpy.mockRestore();
      await teardown();
    }
  });
});

/**
 * DNS rebinding is the one attack a loopback bind does not stop: the operator visits an attacker
 * page, the attacker re-resolves its own domain to 127.0.0.1, and the browser then treats requests to
 * the bridge as SAME-origin — so CORS stops protecting the JSON POST and the page can drive
 * parley_post / parley_fetch_recent. The `Host` (and `Origin`, when the browser sends one) is the only
 * thing that still names the attacker, so table both headers against the modes and require a 403 for
 * every cell that is not the deployment's own name.
 */
describe('the insecure-no-auth endpoint answers only to the hosts it was configured for', () => {
  /** `fetch` will not let us forge Host, so speak HTTP/1.1 over a raw socket. */
  function statusFor(port: number, host: string, origin?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: {
            host,
            ...MCP_HEADERS,
            'content-length': Buffer.byteLength(INITIALIZE),
            ...(origin === undefined ? {} : { origin }),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(INITIALIZE);
    });
  }

  const ALLOWED = 200;
  const REFUSED = 403;

  it('a request whose Host names the attacker is refused, whatever it puts in Origin', async () => {
    const { port, teardown } = await served({ insecureNoAuth: true });
    try {
      // Header SPELLING is its own axis: `Host` is case-insensitive per RFC 9110 and browsers and
      // proxies do send mixed case, so a gate that compares raw bytes locks a legitimate client out
      // — while a suffix like `127.0.0.1.evil.com` must still be a different host, not a prefix
      // match. Every existing row sent an already-lowercase value, so the normalisation itself was
      // free to disappear.
      const HOSTS: Array<[label: string, host: (port: number) => string, expected: number]> = [
        ['the loopback address it is bound to', (p) => `127.0.0.1:${p}`, ALLOWED],
        ['localhost', (p) => `localhost:${p}`, ALLOWED],
        ['localhost in mixed case', () => 'LocalHost', ALLOWED],
        ['localhost upper-cased', () => 'LOCALHOST', ALLOWED],
        ['the bracketed IPv6 loopback', () => '[::1]', ALLOWED],
        ['the bracketed IPv6 loopback with a port', (p) => `[::1]:${p}`, ALLOWED],
        ['a rebinding attacker domain', () => 'files.attacker.example', REFUSED],
        ['a rebinding attacker domain in mixed case', () => 'Files.Attacker.Example', REFUSED],
        ['an attacker domain on the right port', (p) => `attacker.example:${p}`, REFUSED],
        ['a loopback-prefixed attacker domain', (p) => `127.0.0.1.evil.example:${p}`, REFUSED],
        ['a loopback name with a trailing dot', (p) => `localhost.:${p}`, REFUSED],
        ['a public name this bridge was never told about', () => 'parley.example.com', REFUSED],
      ];
      const ORIGINS: Array<[label: string, origin: string | undefined, allowed: boolean]> = [
        ['no Origin (a non-browser client)', undefined, true],
        ['a loopback Origin', 'http://127.0.0.1', true],
        ['a mixed-case loopback Origin', 'http://LocalHost', true],
        ['an attacker Origin', 'https://evil.example', false],
        ['an attacker Origin in mixed case', 'https://Evil.Example', false],
        ['the opaque null Origin', 'null', false],
      ];
      for (const [hostLabel, host, hostExpected] of HOSTS) {
        for (const [originLabel, origin, originAllowed] of ORIGINS) {
          const expected = hostExpected === ALLOWED && originAllowed ? ALLOWED : REFUSED;
          expect(
            await statusFor(port, host(port), origin),
            `Host: ${hostLabel} × Origin: ${originLabel}`,
          ).toBe(expected);
        }
      }
    } finally {
      await teardown();
    }
  });

  it('an explicit allowedHosts list replaces the loopback default', async () => {
    const { port, teardown } = await served({ insecureNoAuth: true, allowedHosts: ['parley.internal'] });
    try {
      expect(await statusFor(port, 'parley.internal')).toBe(ALLOWED);
      expect(await statusFor(port, `127.0.0.1:${port}`)).toBe(REFUSED);
    } finally {
      await teardown();
    }
  });

  // The CONFIGURED side of the comparison is untested by the table above, which only varies the
  // incoming header. An operator who writes their host the way their DNS zone does must not find
  // every lowercase request refused.
  it('a mixed-case allowedHosts entry still matches a lowercase Host', async () => {
    const { port, teardown } = await served({
      insecureNoAuth: true,
      allowedHosts: ['Parley.Internal', 'HTTPS://Parley.Example:8443'],
    });
    try {
      expect(await statusFor(port, 'parley.internal')).toBe(ALLOWED);
      expect(await statusFor(port, 'parley.example')).toBe(ALLOWED);
      expect(await statusFor(port, 'other.internal')).toBe(REFUSED);
    } finally {
      await teardown();
    }
  });

  /**
   * A bearer-protected deployment is normally reached through a proxy under a public name this layer
   * is never told, and a rebinding page cannot forge an Authorization header — so the gate is off
   * there unless the operator asks for it. Pin that, so the default is a decision rather than an
   * accident nobody notices when it changes.
   */
  it('a protected deployment is not host-gated unless allowedHosts says so', async () => {
    const { port, teardown } = await served({ protect: (_req, _res, next) => next() });
    try {
      expect(await statusFor(port, 'parley.example.com')).toBe(ALLOWED);
    } finally {
      await teardown();
    }
    const gated = await served({ protect: (_req, _res, next) => next(), allowedHosts: ['parley.example.com'] });
    try {
      expect(await statusFor(gated.port, 'parley.example.com')).toBe(ALLOWED);
      expect(await statusFor(gated.port, 'other.example.com')).toBe(REFUSED);
    } finally {
      await gated.teardown();
    }
  });
});
