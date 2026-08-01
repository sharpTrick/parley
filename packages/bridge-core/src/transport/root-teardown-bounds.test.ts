import { connect, type Socket } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { asHandle, asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { MCP_HEADERS, NO_PRESENCE, serveRemoteHttp } from '../testing/http-app.js';
import {
  installPost,
  POST_BEHAVIOUR_NAMES,
  unhandledDuring,
} from '../testing/failure-shapes.js';
import { createRemoteHttpApp } from './http.js';
import { GOODBYE_TIMEOUT_MS } from './presence-loop.js';
import { buildBridge } from './stdio-bridge.js';

/**
 * One subject: a stop finishes inside a fixed budget whatever is still in flight. Two things can
 * hold one open — the best-effort presence goodbye, and Node's `server.close()` waiting on every
 * live connection — and either one unbounded means a supervisor SIGKILLs the process mid-teardown
 * with the bridge already advertised as gone. Whether a stop RESOLVES at all is the neighbouring
 * question, graded in root-lifecycle.test.ts.
 */

const TEARDOWN_BUDGET_MS = GOODBYE_TIMEOUT_MS + 1_500;

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

/**
 * The presence goodbye is only one of the things that can hold a teardown. Node's `server.close()`
 * waits for every in-flight REQUEST, and `parley_fetch_recent` is designed to hold one open for its
 * whole long-poll budget — so a bridge whose goodbye has already advertised it as gone keeps serving
 * for up to `catchup.block_max_ms` while the supervisor's stop grace period runs out. Table the
 * connection states a client can leave behind and require one fixed budget in every cell; the
 * presence-only table above varies the post and cannot fail on request-driven hangs.
 */
describe('remote HTTP close() is bounded whatever a client is doing', () => {
  const BLOCK_MAX_MS = 4_000;
  const CLOSE_BUDGET_MS = 1_000;

  const CATCHUP = { catchup: { block_max_ms: BLOCK_MAX_MS, block_poll_interval_ms: 100 } };

  const serving = (): ReturnType<typeof serveRemoteHttp> =>
    serveRemoteHttp({ insecureNoAuth: true }, { ...NO_PRESENCE, ...CATCHUP });

  /** A long-poll POST that will still be parked when close() runs. */
  function longPoll(port: number): Promise<unknown> {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'parley_fetch_recent', arguments: { topic: 'ctx', block_ms: BLOCK_MAX_MS } },
      }),
    }).catch(() => undefined);
  }

  /** A raw socket that connects and then either idles or sends a partial request. */
  function rawSocket(port: number, send?: string): Promise<Socket> {
    return new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        if (send !== undefined) socket.write(send);
        resolve(socket);
      });
      socket.on('error', () => {});
    });
  }

  const STATES: Array<[name: string, arrange: (port: number) => Promise<() => void>]> = [
    ['no client at all', async () => () => {}],
    [
      'a long-poll fetch_recent in flight',
      async (port) => {
        const pending = longPoll(port);
        await new Promise((r) => setTimeout(r, 200)); // parked inside the poll loop
        return () => void pending;
      },
    ],
    [
      'a completed request holding a keep-alive connection',
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        await res.text();
        return () => {};
      },
    ],
    [
      'a socket that connected and sent nothing',
      async (port) => {
        const socket = await rawSocket(port);
        return () => socket.destroy();
      },
    ],
    [
      'a socket part-way through a request',
      async (port) => {
        const socket = await rawSocket(port, 'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 99\r\n\r\n{');
        return () => socket.destroy();
      },
    ],
    [
      'a long-poll in flight AND an idle socket',
      async (port) => {
        const pending = longPoll(port);
        const socket = await rawSocket(port);
        await new Promise((r) => setTimeout(r, 200));
        return () => {
          void pending;
          socket.destroy();
        };
      },
    ],
  ];

  it.each(STATES)('close() settles inside its budget with %s', async (_name, arrange) => {
    const { plugin, app, port } = await serving();
    const release = await arrange(port);
    try {
      const t0 = Date.now();
      await app.close();
      expect(Date.now() - t0).toBeLessThan(CLOSE_BUDGET_MS);
    } finally {
      release();
      await plugin.disconnect();
    }
  });

  /** The stdio root's teardown obeys the same rule; one budget, both composition roots. */
  it('stdio shutdown() settles inside its budget with a long-poll in flight', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: ['ctx'],
      ...NO_PRESENCE,
      ...CATCHUP,
    });
    const bridge = await buildBridge(p, cfg);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'x', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([bridge.attach(serverT), c.connect(clientT)]);
    const pending = c
      .callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx', block_ms: BLOCK_MAX_MS } })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await bridge.shutdown();
    expect(Date.now() - t0).toBeLessThan(CLOSE_BUDGET_MS);
    await c.close();
    void pending;
    await p.disconnect();
  });
});
