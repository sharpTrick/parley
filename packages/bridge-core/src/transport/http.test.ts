import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as allowlistMod from '../allowlist.js';
import { parseConfig } from '../config.js';
import { decodePresence, DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import { asHandle, asTopic } from '../message.js';
import {
  installPost,
  POST_BEHAVIOUR_NAMES,
  unhandledDuring,
  type PostBehaviour,
} from '../testing/failure-shapes.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { createRemoteHttpApp, type RemoteHttpServer } from './http.js';
import { GOODBYE_TIMEOUT_MS } from './presence-loop.js';
import { buildBridge } from './stdio-bridge.js';

const TEARDOWN_BUDGET_MS = GOODBYE_TIMEOUT_MS + 1_500;

let remote: RemoteHttpServer;
let plugin: FakePlugin;
let client: Client;

beforeEach(async () => {
  plugin = new FakePlugin();
  await plugin.connect({});
  const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
  remote = createRemoteHttpApp(plugin, cfg, { insecureNoAuth: true });
  const srv = await remote.listen(0);
  const port = (srv.address() as AddressInfo).port;
  client = new Client({ name: 'chat-stand-in', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

afterEach(async () => {
  await client.close();
  await remote.close();
  await plugin.disconnect();
});

interface ToolText {
  content: Array<{ text: string }>;
}
const parse = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]!.text);

describe('remote HTTP transport (reactive, unauthenticated)', () => {
  it('connects over HTTP and lists the reactive tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
      'parley_list_users',
      'parley_post',
      'parley_reply',
    ]);
  });

  it('post + fetch_recent round-trip over HTTP', async () => {
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'hello over http' } });
    const res = await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
    const out = parse(res) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['hello over http']);
  });

  it('is reactive-only — does NOT advertise the claude/channel capability', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.['claude/channel']).toBeUndefined();
    expect(caps?.tools).toBeDefined();
  });

  it('rejects a topic outside the allowlist (isError, not a crash)', async () => {
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'secret', content: 'x' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    // Closed allowlist → `topic` is a z.enum, so the SDK rejects a disallowed topic at the schema
    // layer (Invalid enum value); with a post pattern it would be allow.assert's "topic not
    // allowed". Either way it is an isError result, not a crash.
    expect(res.content[0]!.text).toMatch(/invalid enum value|topic not allowed/i);
  });
});

describe('remote HTTP: listen() rejects on a bind error', () => {
  async function appOn() {
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    return { p, app: createRemoteHttpApp(p, cfg, { insecureNoAuth: true }) };
  }

  it('rejects with EADDRINUSE when the port is already bound (does not resolve a null-address server)', async () => {
    // Bind a plain http server on an ephemeral port to occupy it.
    const blocker = createHttpServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const { p, app } = await appOn();
    try {
      // The whole point: this must REJECT, not resolve a server whose address() is null.
      await expect(app.listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await app.close();
      await p.disconnect();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('a bind failure leaves the app retryable — a later listen(0) still succeeds', async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const { p, app } = await appOn();
    try {
      await expect(app.listen(taken)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      const s = await app.listen(0);
      expect(s.address()).not.toBeNull();
    } finally {
      await app.close();
      await p.disconnect();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('positive: listen(0) resolves with a bound server, and a later runtime error does not reject it', async () => {
    const { p, app } = await appOn();
    let settled: 'resolved' | 'rejected' | 'pending' = 'pending';
    const promise = app.listen(0).then(
      (s) => {
        settled = 'resolved';
        return s;
      },
      (e) => {
        settled = 'rejected';
        throw e;
      },
    );
    const s = await promise;
    expect(settled).toBe('resolved');
    // A genuinely BOUND server: address() is non-null.
    expect(s.address()).not.toBeNull();
    // A later runtime 'error' on the live server must NOT flip the already-settled promise into a
    // rejection (the success callback removed listen()'s reject listener).
    s.on('error', () => {}); // catcher so emit() doesn't throw (EventEmitter throws on unhandled 'error')
    s.emit('error', Object.assign(new Error('runtime boom'), { code: 'ERUNTIME' }));
    // Give any stray rejection a tick to surface, then confirm the promise is still resolved.
    await Promise.resolve();
    await expect(promise).resolves.toBe(s);
    expect(settled).toBe('resolved');
    await app.close();
    await p.disconnect();
  });
});

/**
 * Teardown is called on paths nobody chose: a `try { await listen() } finally { await close() }`
 * root, a signal handler racing an explicit shutdown, a retry after a failed bind. Table the ORDERS
 * `listen`/`close` can arrive in and require every close() to RESOLVE — and no presence loop to
 * survive it. Cleanup here deliberately does NOT swallow: a `close()` that rejects is the defect,
 * and a `.catch(() => {})` in cleanup is what let it ship.
 */
describe('remote HTTP: close() resolves in whatever order the lifecycle runs', () => {
  type Op = 'listen-ok' | 'listen-fail' | 'close';

  const SEQUENCES: Array<[name: string, ops: Op[]]> = [
    ['close before any listen', ['close']],
    ['a failed bind, then close', ['listen-fail', 'close']],
    ['listen, close, close again', ['listen-ok', 'close', 'close']],
    ['listen, close, listen again, close', ['listen-ok', 'close', 'listen-ok', 'close']],
    ['a failed bind, a good one, then close', ['listen-fail', 'listen-ok', 'close']],
  ];

  it.each(SEQUENCES)('%s', async (_name, ops) => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 },
    });
    const app = createRemoteHttpApp(p, cfg, { insecureNoAuth: true });
    const beatCount = async (): Promise<number> =>
      (await p.fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) })).messages.length;
    const bound: Array<Awaited<ReturnType<typeof app.listen>>> = [];
    try {
      for (const op of ops) {
        if (op === 'listen-ok') bound.push(await app.listen(0));
        else if (op === 'listen-fail') {
          await expect(app.listen(taken)).rejects.toMatchObject({ code: 'EADDRINUSE' });
        } else await app.close();
      }
      for (const s of bound) expect(s.listening).toBe(false);
      const atStop = await beatCount();
      await new Promise((resolve) => setTimeout(resolve, 80)); // several heartbeat cadences
      expect(await beatCount()).toBe(atStop);
    } finally {
      await p.disconnect();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('reactive HTTP: allowlist compiled once per app, not per POST', () => {
  it('derives the allowlist a single time at app scope regardless of request count', async () => {
    const spy = vi.spyOn(allowlistMod, 'allowlistFor');
    const plugin2 = new FakePlugin();
    await plugin2.connect({});
    // Presence off: keep this focused on the request path (a presence loop reuses deps.allow anyway).
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(plugin2, cfg, { insecureNoAuth: true });
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const c = new Client({ name: 'x', version: '0.0.0' }, { capabilities: {} });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      // Several POSTs, each building a brand-new reactive server + transport …
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'a' } });
      await c.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
      await c.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
      // … yet the allowlist (and its regex compilation) was built exactly once, at app scope.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await c.close();
      await app.close();
      await plugin2.disconnect();
      spy.mockRestore();
    }
  });
});

describe('reactive HTTP: fail closed by default', () => {
  const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'x', version: '0.0.0' },
    },
  });
  const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  async function appOn(opts?: Parameters<typeof createRemoteHttpApp>[2]) {
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(p, cfg, opts);
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    return { p, app, port, teardown: async () => (await app.close(), await p.disconnect()) };
  }

  it('401s /mcp when neither protect nor insecureNoAuth is set (no-arg ≠ no-auth)', async () => {
    const { port, teardown } = await appOn(); // no auth option → fail CLOSED
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: HEADERS, body: INIT });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32001);
    } finally {
      await teardown();
    }
  });

  it('serves /mcp (200) once insecureNoAuth: true is set explicitly', async () => {
    const { port, teardown } = await appOn({ insecureNoAuth: true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: HEADERS, body: INIT });
      expect(res.status).toBe(200);
    } finally {
      await teardown();
    }
  });
});

describe('reactive HTTP: 500 path hides internal detail, logs it', () => {
  it('returns generic "internal error" and console.errors the real error', async () => {
    const SECRET = 'SECRET /var/lib/parley.db backend driver detail';
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(p, cfg, { insecureNoAuth: true });
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const handleSpy = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
      .mockRejectedValue(new Error(SECRET));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
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
      await app.close();
      await p.disconnect();
    }
  });
});

/**
 * Presence is a liveness advertisement: peers use `parley_list_users` to pick a hand-off target, so
 * an announcement must never precede a delivery path that can answer. Both composition roots have
 * to obey one rule, so table them together — the HTTP root announced at CONSTRUCTION time (before
 * any bind, and even when the bind failed) while the stdio root deliberately waited.
 */
describe('presence is announced only once the transport is actually live', () => {
  const presenceCfg = (topics = ['ctx']) =>
    parseConfig({
      identity: { handle: 'agent' },
      topics,
      live_push: { enabled: true },
      presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 },
    });

  /** Every presence post seen so far, in order. A FakePlugin records posts durably. */
  async function beats(p: FakePlugin): Promise<string[]> {
    const { messages } = await p.fetchRecent({ topic: DEFAULT_PRESENCE_TOPIC as never });
    return messages.map((m) => m.content);
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 120)); // several heartbeat cadences
  }

  it('http root: nothing is announced before listen() resolves', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const app = createRemoteHttpApp(p, presenceCfg(), { insecureNoAuth: true });
    await settle();
    expect(await beats(p)).toEqual([]); // constructed, never listened ⇒ never advertised
    const s = await app.listen(0);
    expect(s.address()).not.toBeNull();
    await vi.waitFor(async () => expect((await beats(p)).length).toBeGreaterThan(0));
    await app.close();
    await p.disconnect();
  });

  it('http root: a failed bind never announces', async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const p = new FakePlugin();
    await p.connect({});
    const app = createRemoteHttpApp(p, presenceCfg(), { insecureNoAuth: true });
    await expect(app.listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await settle();
    expect(await beats(p)).toEqual([]);
    await app.close();
    await p.disconnect();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('stdio root: nothing is announced before attach(), and a failed attach never announces', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const bridge = await buildBridge(p, presenceCfg());
    await settle();
    expect(await beats(p)).toEqual([]); // built, never attached ⇒ never advertised
    const [, serverT] = InMemoryTransport.createLinkedPair();
    await bridge.attach(serverT);
    await vi.waitFor(async () => expect((await beats(p)).length).toBeGreaterThan(0));
    await bridge.shutdown();

    const failing = new FakePlugin();
    await failing.connect({});
    failing.subscribe = (): Promise<void> => Promise.reject(new Error('subscribe boom'));
    const doomed = await buildBridge(failing, presenceCfg());
    const [, t2] = InMemoryTransport.createLinkedPair();
    await expect(doomed.attach(t2)).rejects.toThrow(/subscribe boom/);
    await settle();
    expect(await beats(failing)).toEqual([]);
  });
});

/**
 * Starting a composition root twice must fail, not silently double up: the second start would
 * overwrite the first server + presence loop, leaving a socket bound and a loop beating that no
 * teardown can ever reach — so `parley_list_users` reports a shut-down bridge as online forever.
 * One rule, both roots.
 */
describe('a composition root can only be started once', () => {
  const startedCfg = () =>
    parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 1_000 },
    });

  interface Started {
    startAgain: () => Promise<unknown>;
    stop: () => Promise<void>;
    stillBound: () => boolean;
  }

  const roots: Record<string, (p: FakePlugin) => Promise<Started>> = {
    'http listen()': async (p) => {
      const app = createRemoteHttpApp(p, startedCfg(), { insecureNoAuth: true });
      const s = await app.listen(0);
      return {
        startAgain: () => app.listen(0),
        stop: () => app.close(),
        stillBound: () => s.listening,
      };
    },
    'stdio attach()': async (p) => {
      const bridge = await buildBridge(p, startedCfg());
      await bridge.attach(InMemoryTransport.createLinkedPair()[1]);
      return {
        startAgain: () => bridge.attach(InMemoryTransport.createLinkedPair()[1]),
        stop: () => bridge.shutdown(),
        stillBound: () => false,
      };
    },
  };

  async function kinds(p: FakePlugin): Promise<string[]> {
    const { messages } = await p.fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) });
    return messages.map((m) => decodePresence(m.content)?.kind ?? 'unknown');
  }

  it.each(Object.keys(roots))(
    '%s rejects a second start, runs exactly one presence loop, and goes quiet on teardown',
    async (name) => {
      const p = new FakePlugin();
      await p.connect({});
      const started = await roots[name]!(p);
      await vi.waitFor(async () => expect((await kinds(p)).length).toBeGreaterThan(0));

      await expect(started.startAgain()).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 80)); // several heartbeat cadences

      // A second loop would announce itself with its own hello.
      expect((await kinds(p)).filter((k) => k === 'hello')).toHaveLength(1);

      await started.stop();
      expect(started.stillBound()).toBe(false);
      const atStop = (await kinds(p)).length;
      await new Promise((r) => setTimeout(r, 100));
      expect((await kinds(p)).length).toBe(atStop); // nothing beats past teardown
      await p.disconnect();
    },
  );
});

/**
 * The public JSDoc once described the opposite design (session-per-connection, reused by
 * `mcp-session-id`). Pin the observable session contract instead of the sentence, so a doc that
 * regrows session affinity is contradicted by a failing test rather than by a neighbouring comment.
 */
describe('reactive HTTP is stateless: no session id, no GET/DELETE', () => {
  const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
  });

  async function appOn() {
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      presence: { enabled: false },
    });
    const app = createRemoteHttpApp(p, cfg, { insecureNoAuth: true });
    const srv = await app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    return { port, teardown: async () => (await app.close(), await p.disconnect()) };
  }

  it('the initialize response carries no mcp-session-id header', async () => {
    const { port, teardown } = await appOn();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: INIT,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
    } finally {
      await teardown();
    }
  });

  it.each(['GET', 'DELETE'])('%s /mcp is 405 — there is no session to resume or terminate', async (method) => {
    const { port, teardown } = await appOn();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method });
      expect(res.status).toBe(405);
    } finally {
      await teardown();
    }
  });
});

/**
 * The HTTP root's close() awaits the same best-effort goodbye the stdio root does, so it inherits
 * the same hazard: a presence post that never settles must not hold the socket open forever.
 */
describe('remote HTTP close() is bounded whatever the presence post does', () => {
  it.each(POST_BEHAVIOUR_NAMES)('close() completes with a post that %s', async (behaviour) => {
    const p = new FakePlugin();
    await p.connect({});
    installPost(p, behaviour);
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      // A live cadence, so the heartbeat site is exercised too and not just hello + goodbye.
      presence: { enabled: true, heartbeat_ms: 20, ttl_ms: 180_000 },
    });
    const app = createRemoteHttpApp(p, cfg, { insecureNoAuth: true });
    let s: Awaited<ReturnType<typeof app.listen>> | undefined;
    const escaped = await unhandledDuring(async () => {
      s = await app.listen(0);
      await new Promise((r) => setTimeout(r, 60)); // several heartbeats
      const closed = await Promise.race([
        app.close().then(() => 'CLOSED'),
        new Promise((r) => setTimeout(() => r('TIMED OUT'), TEARDOWN_BUDGET_MS).unref?.()),
      ]);
      expect(closed).toBe('CLOSED');
    });
    expect(s?.listening).toBe(false);
    // A best-effort beat may fail; it may never take the process down with it.
    expect(escaped).toEqual([]);
    await p.disconnect();
  });

  /**
   * The harness has to be able to produce the input the table names. Installing a sync-throwing
   * behaviour through an `async` wrapper turns it into an ordinary rejection, and the row silently
   * becomes a duplicate of `rejects` — coverage on paper, none in fact.
   */
  it('installs a sync-throwing post that really throws synchronously', async () => {
    const p = new FakePlugin();
    await p.connect({});
    installPost(p, 'rejects synchronously');
    expect(() => p.post(asTopic('ctx'), asHandle('agent'), 'x')).toThrow();
    await p.disconnect();
  });
});
