import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { parseConfig } from '../config.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import {
  FAILURE_SHAPE_NAMES,
  FAILURE_SHAPES,
  unhandledDuring,
  type FailureShape,
} from '../testing/failure-shapes.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { createRemoteHttpApp } from './http.js';
import { startPushLoop } from './push-loop.js';

/**
 * Core fires seam calls it deliberately does NOT await — the live-push emit, and the per-request
 * teardown remote mode runs from a response's `close` event. Every one of them must absorb the
 * failure whatever SHAPE it arrives in, because an escaped rejection from a fire-and-forget call has
 * no handler anywhere and Node terminates the process.
 *
 * Table the shapes against every fire-and-forget call site and assert on captured
 * `unhandledRejection` events, not on "the call returned" — a site that lets one escape returns
 * perfectly well and takes the process down a tick later.
 */
describe('no fire-and-forget seam call escapes as an unhandled rejection', () => {
  describe.each(FAILURE_SHAPE_NAMES)('push emit whose channel notification %s', (shape) => {
    it('is absorbed by the emit path', async () => {
      const plugin = new FakePlugin();
      await plugin.connect({});
      let notifications = 0;
      const server = {
        server: {
          notification: (): Promise<void> => {
            notifications++;
            return FAILURE_SHAPES[shape](Promise.resolve());
          },
        },
      } as unknown as McpServer;

      const escaped = await unhandledDuring(async () => {
        await startPushLoop(server, plugin, new Allowlist(['ctx']), new SeenSet(), {
          mentionFilter: false,
          identity: asHandle('agent'),
        });
        await plugin.post(asTopic('ctx'), asHandle('bob'), 'hi');
        await vi.waitFor(() => expect(notifications).toBeGreaterThan(0));
      });

      expect(escaped).toEqual([]);
      await plugin.disconnect();
    });
  });

  /**
   * Remote mode tears its per-request server and transport down from the response's `close` event,
   * where nothing is awaiting them: a transport whose socket is already destroyed rejects there, and
   * a single aborted or malformed POST would take the whole remote bridge down with it.
   */
  const PER_REQUEST_SITES = {
    'the per-request transport': (): { close: unknown } => StreamableHTTPServerTransport.prototype,
    'the per-request reactive server': (): { close: unknown } => McpServer.prototype,
  };

  for (const [site, proto] of Object.entries(PER_REQUEST_SITES)) {
    describe.each(FAILURE_SHAPE_NAMES)(`${site} whose close %s`, (shape) => {
      it('is absorbed, and every sibling teardown still runs', async () => {
        const plugin = new FakePlugin();
        await plugin.connect({});
        const cfg = parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
        const app = createRemoteHttpApp(plugin, cfg, { insecureNoAuth: true });
        const srv = await app.listen(0);
        const port = (srv.address() as AddressInfo).port;
        // Spy on EVERY per-request teardown, not only the failing one: a throw that leaves the
        // response-close handler skips the ones after it, and that leak reports as nothing at all
        // when the throw is also the thing being graded.
        const spies = Object.entries(PER_REQUEST_SITES).map(([name, target]) => {
          const spy = vi.spyOn(target() as { close: () => Promise<void> }, 'close');
          if (target === proto)
            spy.mockImplementation(() => FAILURE_SHAPES[shape](Promise.resolve()));
          return [name, spy] as const;
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const escaped = await unhandledDuring(async () => {
          const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'x', version: '0' },
              },
            }),
          });
          expect(res.status).toBe(200);
          await res.text();
        });

        // Keep the restores unconditional, so that a row which fails cannot leave a throwing
        // prototype behind and report its own failure again in every row after it.
        try {
          // Both that the failing site was exercised — without which the row proves nothing — and
          // that nothing downstream of it was skipped. Ahead of `escaped`, so that a teardown the
          // throw jumped over is reported as the leak it is rather than only as the throw.
          for (const [name, spy] of spies)
            expect(spy, `${name} teardown never ran`).toHaveBeenCalled();
          expect(escaped).toEqual([]);
        } finally {
          for (const [, spy] of spies) spy.mockRestore();
          errSpy.mockRestore();
          await app.close();
          await plugin.disconnect();
        }
      });
    });
  }
});

/**
 * The table above can only cover the sites it knows about. Pin the INVENTORY of fire-and-forget
 * statements so a newly added one fails here until someone decides which behavioural row covers it.
 *
 * The class is the SHAPE — a statement that starts work and keeps no handle on the promise — not the
 * `void` keyword and not the two directories the behavioural tables happen to exercise:
 * `plugin.fetchRecent(args).then(handle);` discards a rejection exactly as `void` does, and under
 * Node's default `--unhandled-rejections=throw` either one ends the process. So read every statement
 * under `src/` off the parser, which cannot mistake a `: void` annotation for one.
 */
describe('every fire-and-forget statement in src/ is a known one', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));

  /** The methods that settle a promise in place, leaving the statement with nothing to await. */
  const SETTLERS = ['then', 'catch', 'finally'];

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  /** Every expression statement in `source` whose value — a promise — is thrown away. */
  function discarded(source: string): string[] {
    const parsed = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        const expr = node.expression;
        const settled =
          ts.isCallExpression(expr) &&
          ts.isPropertyAccessExpression(expr.expression) &&
          SETTLERS.includes(expr.expression.name.text);
        if (ts.isVoidExpression(expr) || settled)
          found.push(node.getText().split('\n')[0]!.trim());
      }
      node.forEachChild(visit);
    };
    visit(parsed);
    return found;
  }

  const inventory = (): string[] =>
    sources(SRC).flatMap((file) =>
      discarded(readFileSync(file, 'utf8')).map((stmt) => `${relative(SRC, file)}: ${stmt}`),
    );

  /** Each site, and why its failure has somewhere to land. */
  const EXPECTED: Record<string, string> = {
    "cli/backend-cli.ts: void bridge.shutdown().finally(() => process.exit(0));":
      're-raises rather than absorbing — survivable only because process.exit(0) runs first',
    "engine/blocking-fetch.ts: void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));":
      'both outcomes are handed to the caller\u2019s promise; the finally only detaches a listener',
    "transport/http.ts: void closeQuietly('transport', transport);":
      'closeQuietly absorbs every shape, graded by the per-request table above',
    "transport/http.ts: void closeQuietly('reactive server', server);":
      'closeQuietly absorbs every shape, graded by the per-request table above',
    'transport/push-loop.ts: void emitChannel(server, m).catch(() => {':
      'the catch absorbs every shape, graded by the push-emit table above',
  };

  it('reads a discarded promise however the statement is written', () => {
    const planted: Record<string, string> = {
      'a voided call': 'void p();',
      'a bare then': 'p.then(f);',
      'a bare catch': 'p.catch(f);',
      'a bare finally': 'p.finally(f);',
      'a settled chain off a call': 'plugin.fetchRecent(args).then(() => undefined);',
    };
    for (const [how, snippet] of Object.entries(planted))
      expect(discarded(snippet), `${how} was not seen`).toHaveLength(1);

    const innocent: Record<string, string> = {
      'a void return annotation': 'function f(): void { g(); }',
      'a Promise<void> annotation': 'const p: Promise<void> = g();',
      'a void operator in an arrow body': 'const f = () => void 0;',
      'an awaited chain': 'async function f() { await p.then(g); }',
      'a chain bound to a name': 'const q = p.then(g);',
      'a returned chain': 'function f() { return p.then(g); }',
    };
    for (const [how, snippet] of Object.entries(innocent))
      expect(discarded(snippet), `${how} was read as fire-and-forget`).toEqual([]);
  });

  it('walks more than the directories the tables above exercise', () => {
    expect(sources(SRC).length).toBeGreaterThan(20);
    expect(new Set(sources(SRC).map((f) => relative(SRC, f).split('/')[0])).size).toBeGreaterThan(3);
  });

  it('matches the inventory the failure-shape tables cover', () => {
    expect(inventory().sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

/**
 * The harness itself has to be able to produce the input it advertises. A shape that silently
 * degrades to an ordinary rejection is how a row can sit in a table for rounds while never once
 * exercising the class it names.
 */
describe('the failure-shape fixtures are what they claim', () => {
  const ASYNC: FailureShape[] = ['rejects', 'rejects with a non-Error'];

  it.each(ASYNC)('%s returns a promise rather than throwing', async (shape) => {
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = FAILURE_SHAPES[shape](Promise.resolve());
    }).not.toThrow();
    await expect(pending).rejects.toBeDefined();
  });
});
