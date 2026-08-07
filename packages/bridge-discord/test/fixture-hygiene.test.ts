/**
 * The gateway harness was restated per suite — four `reachReady` copies, three `fetch` stubs, the
 * same fake-timer ordering comment pasted three times — so a change to the handshake dance had to be
 * found in four places and a missed copy hung that suite on `await pending` with no sign of which
 * copy was stale. Two of the copies were byte-identical, so neither could fail independently. This
 * refuses a fifth: `harness.ts` owns them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));

/** Declaring one of these locally means a copy of the shared harness, not a new fixture. */
const OWNED_BY_HARNESS = [
  'reachReady',
  'stubFetch',
  'HUGE_HB',
  'NO_HANDSHAKE_TIMEOUT',
  // The url source is a FIXTURE AXIS, not a per-table choice: pinning `gateway_url` skips the
  // production dial's `GET /gateway/bot` await, and a table that pins it silently cannot reach
  // anything that happens across that await.
  'URL_SOURCES',
  // Observing a settlement is the same kind of axis: a local copy is free to fold `resolved` and
  // `rejected` into one value, and every table built on it then grades something other than what
  // the call actually did.
  'settleOf',
  // Reading a member the plugin does not export is the same kind of axis again: a local copy is
  // free to read it without first proving it is there, and the assertion under it then grades
  // `undefined` for as long as nobody notices.
  'probe',
];

const declaration = (name: string): RegExp =>
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|function|async function)\\s+${name}\\b`, 'm');

describe('the gateway harness has exactly one copy', () => {
  // Every test module EXCEPT the harness itself — a second copy in a shared fixture module would be
  // just as stale-able as one in a suite.
  const others = readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts') && f !== 'harness.ts');

  it('finds the package test modules to lint', () => {
    expect(others.length).toBeGreaterThan(5);
  });

  for (const name of OWNED_BY_HARNESS) {
    it(`no other test module declares its own ${name}`, () => {
      const offenders = others.filter((f) =>
        declaration(name).test(readFileSync(`${TEST_DIR}${f}`, 'utf8')),
      );
      expect(offenders, `import ${name} from ./harness.js instead of restating it`).toEqual([]);
    });
  }

  for (const name of OWNED_BY_HARNESS) {
    it(`harness.ts exports ${name}`, () => {
      expect(readFileSync(`${TEST_DIR}harness.ts`, 'utf8')).toMatch(
        new RegExp(`export (?:const|async function|function) ${name}\\b`),
      );
    });
  }
});

/**
 * 1-based lines carrying a `.then(` given a SECOND argument. Read off the TypeScript AST rather
 * than off the text, so that an apostrophe in a comment, a quote inside a regex, or a nested
 * template literal cannot desynchronize the scan and quietly stop it finding anything.
 */
function settlementFolds(src: string): number[] {
  const file = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      node.arguments.length > 1
    ) {
      found.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

// CLASS: a `.then(onFulfilled, onRejected)` maps BOTH settlements onto whatever its two arms
// return, so a table built on one can grade only what survives that fold — elapsed time, a request
// count — while the call under it rejects. A settlement therefore reaches a case only through the
// harness, whose union cannot be read without first naming which arm it is.
//
// The scan is graded on BOTH sides — text it must flag and text it must leave alone — so that a
// matcher which stops matching, or one which starts matching a one-arm `.then`, loses a case rather
// than reading as coverage.
describe('a settlement is observed only through the harness', () => {
  const FOLDS: Array<[string, string]> = [
    ['arms that name the settlement but hand back neither', "p.then(() => 'resolved', () => 'rejected')"],
    ['arms that keep the values but not which arm ran', 'p.then((v) => v, (e: unknown) => e)'],
    ['named arms rather than inline ones', 'p.then(onOk, onFail)'],
    [
      'arms whose own calls carry commas',
      'p.then((v) => wrap(v, 1), (e) => wrap(e, 2))',
    ],
    ['a pair split across lines', 'p.then(\n  () => undefined,\n  (e) => e,\n)'],
    // The two shapes a text scan gets wrong: each opens a quote it never closes, so everything
    // after it reads as string and the lint goes quietly blind.
    ['a fold under a comment carrying an apostrophe', "// core's budget\np.then((v) => v, (e) => e)"],
    ['a fold under a regex carrying a quote', "const re = /'/;\np.then((v) => v, (e) => e)"],
  ];

  const KEEPS: Array<[string, string]> = [
    ['a one-arm then', 'p.then((r) => expect(r.messages).toEqual([]))'],
    ['a one-arm then whose body carries commas', 'p.then((v) => wrap(v, 1, [2, 3]))'],
    ['a one-arm then returning an object literal', 'p.then((v) => ({ a: 1, b: 2 }))'],
    ['a comma living inside a string', "p.then((v) => 'resolved, then rejected')"],
    ['the whole fold quoted as fixture text', "const bad = \"p.then(() => 1, () => 2)\";"],
  ];

  for (const [label, text] of FOLDS) {
    it(`flags ${label}`, () => {
      expect(settlementFolds(text)).not.toEqual([]);
    });
  }

  for (const [label, text] of KEEPS) {
    it(`leaves ${label} alone`, () => {
      expect(settlementFolds(text)).toEqual([]);
    });
  }

  const linted = readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts') && f !== 'harness.ts');

  it('finds the package test modules to lint', () => {
    expect(linted.length).toBeGreaterThan(5);
  });

  for (const file of linted) {
    it(`${file} folds no settlement of its own`, () => {
      const at = settlementFolds(readFileSync(`${TEST_DIR}${file}`, 'utf8'));
      expect(at, `line(s) ${at.join(', ')}: await settleOf(call) and assert its status instead`)
        .toEqual([]);
    });
  }
});

/**
 * 1-based lines carrying `x as unknown as { … }` — a double cast whose target is an INLINE object
 * type. That shape has one use in this package: naming a member the plugin does not export so a
 * case can read it. Read off the AST for the same reason `settlementFolds` is.
 */
function inlineShapeCasts(src: string): number[] {
  const file = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isAsExpression(node) &&
      ts.isTypeLiteralNode(node.type) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

// CLASS: an assertion whose PASS is indistinguishable from "the thing I reached for is not there".
// `expect((p as unknown as { gatewayReady?: unknown }).gatewayReady).toBeUndefined()` graded the
// terminal-close contract and stayed green after the member was renamed away — CLAUDE.md's "probe
// turned tautology" verbatim. The cast is the reachable half of that shape, so it is what this
// refuses; `probe()` names the member as a STRING and throws before reading it, which turns the
// same rename into a named red.
//
// Graded on BOTH sides, so that a matcher which stops matching — or one which starts flagging the
// ordinary `as unknown as SomeType` widening — loses a case rather than reading as coverage.
describe('a member the plugin does not export is read only through the harness', () => {
  const FLAGS: Array<[string, string]> = [
    ['a private field reached for a value', '(p as unknown as { waiters: Map<string, unknown> }).waiters'],
    ['an optional member reached for an absence check', '(p as unknown as { ready?: unknown }).ready'],
    ['a cast split across lines', '(p as unknown as {\n  heartbeats: Set<unknown>;\n}).heartbeats'],
    ['a cast bound to a name first', 'const inner = p as unknown as { subs: Map<string, unknown> };'],
    ['a cast under a comment carrying an apostrophe', "// core's memo\n(p as unknown as { m: 1 }).m"],
  ];

  const KEEPS: Array<[string, string]> = [
    ['a widening to a named type', 'const c = id as unknown as Cursor;'],
    ['a widening to an indexed type', '({}) as unknown as Parameters<typeof startPushLoop>[0]'],
    ['a single cast to an inline shape', 'const b = body as { type?: unknown };'],
    ['the harness call that replaces it', "probe<Map<string, unknown>>(plugin, 'waiters')"],
    ['the whole cast quoted as fixture text', 'const bad = "(p as unknown as { a: 1 }).a";'],
  ];

  for (const [label, text] of FLAGS) {
    it(`flags ${label}`, () => {
      expect(inlineShapeCasts(text)).not.toEqual([]);
    });
  }

  for (const [label, text] of KEEPS) {
    it(`leaves ${label} alone`, () => {
      expect(inlineShapeCasts(text)).toEqual([]);
    });
  }

  const linted = readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts') && f !== 'harness.ts');

  it('finds the package test modules to lint', () => {
    expect(linted.length).toBeGreaterThan(5);
  });

  for (const file of linted) {
    it(`${file} reaches for no unexported member of its own`, () => {
      const at = inlineShapeCasts(readFileSync(`${TEST_DIR}${file}`, 'utf8'));
      expect(at, `line(s) ${at.join(', ')}: read it through probe(target, 'name') instead`)
        .toEqual([]);
    });
  }
});
