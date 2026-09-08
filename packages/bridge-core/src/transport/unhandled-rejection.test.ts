import { readdirSync, statSync } from 'node:fs';
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
 * The tables above can only cover the sites they know about. Pin the INVENTORY of discarded
 * promises so a newly added one fails here until someone decides which behavioural row covers it.
 *
 * The class is a TYPE: a statement that starts promise-typed work and keeps no handle on the
 * result. Ask the checker, because the spellings are open-ended — `void p()`, `p.then(f)`,
 * `p['then'](f)`, `Promise.all([…])`, a bare call to an async function, and a promise bound to a
 * name nothing reads again are all one class, and each of them ends the process under Node's
 * default `--unhandled-rejections=throw`.
 */
describe('every discarded promise in src/ is a known one', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));

  const OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  /** A type with a callable `then` — what Node will report as unhandled if it rejects. */
  const isPromiseLike = (checker: ts.TypeChecker, type: ts.Type, at: ts.Node): boolean => {
    if (type.isUnionOrIntersection())
      return type.types.some((member) => isPromiseLike(checker, member, at));
    const then = type.getProperty('then');
    if (then === undefined) return false;
    return checker.getTypeOfSymbolAtLocation(then, at).getCallSignatures().length > 0;
  };

  const isAssignment = (node: ts.Node): boolean =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

  /**
   * Every promise in one source that nothing holds. A declaration is dropped when the compiler can
   * find no other reference to the symbol it binds — resolved through the checker rather than by
   * name, so a shadowing binding elsewhere cannot vouch for it. `declare` and `export` are skipped:
   * neither has its readers in this file.
   */
  function discardedIn(checker: ts.TypeChecker, source: ts.SourceFile): ts.Node[] {
    const found: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        let expr = node.expression;
        while (ts.isVoidExpression(expr)) expr = expr.expression;
        if (!isAssignment(expr) && isPromiseLike(checker, checker.getTypeAtLocation(expr), expr))
          found.push(node);
      }
      if (
        ts.isVariableStatement(node) &&
        (ts.getCombinedModifierFlags(node.declarationList.declarations[0]!) &
          (ts.ModifierFlags.Ambient | ts.ModifierFlags.Export)) ===
          0
      ) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!isPromiseLike(checker, checker.getTypeAtLocation(decl.name), decl.name)) continue;
          const bound = checker.getSymbolAtLocation(decl.name);
          let read = false;
          const seek = (n: ts.Node): void => {
            if (n !== decl.name && ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === bound)
              read = true;
            n.forEachChild(seek);
          };
          seek(source);
          if (!read) found.push(decl);
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  }

  const inventory = (): string[] => {
    const roots = sources(SRC);
    const program = ts.createProgram(roots, OPTIONS);
    const checker = program.getTypeChecker();
    return roots.flatMap((file) => {
      const source = program.getSourceFile(file);
      return source === undefined
        ? []
        : discardedIn(checker, source).map(
            (node) => `${relative(SRC, file)}: ${node.getText().split('\n')[0]!.trim()}`,
          );
    });
  };

  /** Each site, and why its failure has somewhere to land. */
  const EXPECTED: Record<string, string> = {
    "cli/backend-cli.ts: void bridge.shutdown().finally(() => process.exit(0));":
      're-raises rather than absorbing — survivable only because process.exit(0) runs first',
    "engine/blocking-fetch.ts: void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));":
      'both outcomes are handed to the caller’s promise; the finally only detaches a listener',
    "transport/http.ts: void closeQuietly('transport', transport);":
      'closeQuietly absorbs every shape, graded by the per-request table above',
    "transport/http.ts: void closeQuietly('reactive server', server);":
      'closeQuietly absorbs every shape, graded by the per-request table above',
    'transport/push-loop.ts: void emitChannel(server, m).catch(() => {':
      'the catch absorbs every shape, graded by the push-emit table above',
    'seam.ts: void Promise.resolve(handler(message())).catch(() => undefined);':
      'safeDeliver absorbs every shape, graded by safe-deliver.test.ts and, for each backend, by ' +
      'the conformance handler-fault clause',
  };

  /**
   * The planted rows below are compiled as one virtual source apiece and put through the same
   * `discardedIn` walk the inventory uses. `PREAMBLE` mints the names they need; it is ambient, so
   * it contributes no rows of its own.
   */
  const PLANTED = join(SRC, 'planted-probe.ts');
  const PREAMBLE = [
    'declare const p: Promise<void>;',
    'declare function f(): void;',
    'declare function h(): void;',
    'declare function work(): Promise<void>;',
    'declare function reapSession(s: unknown): Promise<void>;',
    'declare const server: unknown;',
    'declare const args: unknown;',
    'declare const plugin: { fetchRecent(a: unknown): Promise<void> };',
    'declare let slot: Promise<void> | undefined;',
    '',
  ].join('\n');

  function discardedInSnippet(snippet: string): string[] {
    const host = ts.createCompilerHost(OPTIONS, true);
    const text = PREAMBLE + snippet;
    const readReal = host.readFile.bind(host);
    const getReal = host.getSourceFile.bind(host);
    const existsReal = host.fileExists.bind(host);
    host.readFile = (name) => (name === PLANTED ? text : readReal(name));
    host.fileExists = (name) => name === PLANTED || existsReal(name);
    host.getSourceFile = (name, lang, onError, shouldCreate) =>
      name === PLANTED
        ? ts.createSourceFile(name, text, lang, true)
        : getReal(name, lang, onError, shouldCreate);
    const program = ts.createProgram([PLANTED], OPTIONS, host);
    const source = program.getSourceFile(PLANTED)!;
    return discardedIn(program.getTypeChecker(), source).map((node) => node.getText());
  }

  it('reads a discarded promise however the statement is written', () => {
    const planted: Record<string, string> = {
      'a voided call': 'void work();',
      'a bare then': 'p.then(f);',
      'a bare catch': 'p.catch(f);',
      'a bare finally': 'p.finally(f);',
      'a settled chain off a call': 'plugin.fetchRecent(args).then(() => undefined);',
      'a bare call to a promise-returning function': 'reapSession(server);',
      'a settler reached by index': "p['then'](f);",
      'a combinator': 'Promise.all([p, p]);',
      'a promise stored and never read': 'const dropped = work();',
    };
    for (const [how, snippet] of Object.entries(planted))
      expect(discardedInSnippet(snippet), `${how} was not seen`).toHaveLength(1);

    const innocent: Record<string, string> = {
      'a synchronous call': 'h();',
      'a void return annotation': 'function fn(): void { h(); }',
      'a void operator on a non-promise': 'const fn = () => void 0;',
      'an awaited chain': 'async function fn(): Promise<void> { await p.then(f); }',
      'a chain bound to a name that is awaited':
        'async function fn(): Promise<void> { const q = p.then(f); await q; }',
      'a returned chain': 'function fn(): Promise<void> { return p.then(f); }',
      'an assignment that stores it': 'function fn(): Promise<void> { slot ??= work(); return slot; }',
    };
    for (const [how, snippet] of Object.entries(innocent))
      expect(discardedInSnippet(snippet), `${how} was read as a discarded promise`).toEqual([]);
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
