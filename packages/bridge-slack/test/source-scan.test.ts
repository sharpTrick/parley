/**
 * Two CLASSES that only ever fail silently, because both are guards rather than behaviour.
 *
 * (1) A source-scanning assertion whose FILE ENUMERATION is narrower than the build's. Four scans in
 *     this suite listed `src/` with a non-recursive `readdirSync` while `tsconfig.json` compiles
 *     `src/**` — so a module in a subdirectory was graded by none of them and shipped in `dist/`
 *     anyway. The enumeration is now DERIVED from the tsconfig the build reads, and this file grades
 *     that derivation over synthetic projects on BOTH verdicts: what it must see, at three depths,
 *     and what it must not.
 *
 * (2) An array of vendor-chosen length exploded into an argument list. `f(...arr)`, `new F(...arr)`
 *     and `f.apply(ctx, arr)` all pass every element as a separate argument, and V8 refuses past
 *     ~125 000 of them with a `RangeError: Maximum call stack size exceeded` — an engine-level error
 *     naming neither the Slack method nor the plugin. `conversations.history` chose the length of
 *     the array behind the one that existed: `ok:true` is a claim about the CALL, not about the body,
 *     and nothing on the wire holds the vendor to the `limit` it was sent. The rejection landed at or
 *     above the caller's cursor, so every later catch-up threw on it again and the topic was wedged.
 *     Banned outright rather than only where the value looks vendor-derived: a scan that has to
 *     decide provenance is a scan that can be talked out of a hit.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { compiledSourceModules, compiledSourcePaths, slackSourceModules } from './source-tree.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway project on disk: a tsconfig with `include`, plus the files named. */
function fixtureProject(files: Record<string, string>, include: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'parley-slack-scan-'));
  roots.push(root);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { noEmit: true }, include }),
  );
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return join(root, 'tsconfig.json');
}

const namesOf = (config: string): string[] => compiledSourceModules(config).map((m) => m.name);

const MODULE = 'export const marker = 1;\n';

describe('the source enumeration is the set the build compiles, at every depth', () => {
  // The depths a directory-level scan gets wrong. `src/flat.ts` is the one the old scan DID see —
  // it is here so a walk that broke the other way, seeing only subdirectories, fails too.
  const PLACEMENTS = ['src/flat.ts', 'src/sub/nested.ts', 'src/a/b/deep.ts'];

  it.each(PLACEMENTS)('enumerates a module at %s', (placement) => {
    const config = fixtureProject({ 'src/index.ts': MODULE, [placement]: MODULE }, ['src/**/*']);
    expect(namesOf(config).sort()).toEqual(['src/index.ts', placement].sort());
  });

  it('enumerates every placement at once, and reads each one', () => {
    const files = Object.fromEntries(PLACEMENTS.map((p, i) => [p, `export const n = ${i};\n`]));
    const config = fixtureProject({ ...files, 'src/index.ts': MODULE }, ['src/**/*']);
    const modules = compiledSourceModules(config);
    expect(modules.map((m) => m.name).sort()).toEqual([...PLACEMENTS, 'src/index.ts'].sort());
    for (const m of modules) expect(m.text.length).toBeGreaterThan(0);
  });

  // The must-NOT arm. A scan that answered "everything on disk" would pass every case above while
  // grading files the build does not ship — and a `.d.ts` carries no call site at all.
  it('enumerates nothing the include does not cover, and no declaration file', () => {
    const config = fixtureProject(
      {
        'src/index.ts': MODULE,
        'src/kept.ts': MODULE,
        'src/legacy.d.ts': 'export declare const gone: number;\n',
        'src/notes.md': 'not source\n',
        'src/data.json': '{}\n',
        'test/helper.ts': MODULE,
        'outside.ts': MODULE,
      },
      ['src/**/*'],
    );
    expect(namesOf(config).sort()).toEqual(['src/index.ts', 'src/kept.ts']);
  });

  // The FLOOR. Without it, every consumer of this walk passes by grading an empty set — which is
  // precisely how the four scans this file replaces would have failed if their `src/` had moved.
  it.each([
    ['an include that matches nothing', ['nowhere/**/*']],
    ['an include that matches a single module', ['src/only.ts']],
  ])('refuses %s rather than reporting a scan of nothing', (_label, include) => {
    const config = fixtureProject({ 'src/only.ts': MODULE, 'src/other.ts': MODULE }, include);
    expect(() => compiledSourcePaths(config)).toThrow(/gone blind|did not parse/);
  });

  it('refuses a tsconfig that is not there', () => {
    const root = mkdtempSync(join(tmpdir(), 'parley-slack-scan-'));
    roots.push(root);
    expect(() => compiledSourcePaths(join(root, 'tsconfig.json'))).toThrow(/unreadable tsconfig/);
  });

  /**
   * The two derivations cross-checked: this walks the DISK recursively, `slackSourceModules` reads
   * the tsconfig. Narrowing either one — the walk, or the build's `include` — fails here, so "what
   * the guard reads" cannot drift below "what the build ships" without a red.
   */
  it("enumerates every .ts on disk under the package's src/", () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const onDisk = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map((f) => `src/${f.split(sep).join('/')}`)
      .sort();
    expect(onDisk.length).toBeGreaterThan(1);
    expect(slackSourceModules().map((m) => m.name).sort()).toEqual(onDisk);
  });
});

/**
 * 1-based lines where a call's argument list is built by EXPLODING an array — a call or `new` with a
 * spread argument, or a two-argument `.apply`. Read off the TypeScript AST rather than off the text,
 * so that an apostrophe in a comment, a quote inside a regex or a nested template literal cannot
 * desynchronize the scan and quietly stop it finding anything.
 */
function argumentExplosions(src: string): number[] {
  const file = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
  const found = new Set<number>();
  const at = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    const parent = node.parent as ts.Node | undefined;
    if (
      ts.isSpreadElement(node) &&
      parent !== undefined &&
      (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    ) {
      found.add(at(node));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'apply' &&
      node.arguments.length === 2
    ) {
      found.add(at(node));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return [...found].sort((a, b) => a - b);
}

describe('no array is exploded into an argument list', () => {
  const FLAGS: Array<[string, string]> = [
    ['a push of a filtered vendor page', 'collected.push(...page.filter(isPlainMessage));'],
    ['a spread of a cast vendor array', 'list.push(...(entries as StoredMessage[]));'],
    ['a reducer over a vendor array', 'const newest = Math.max(...tsValues);'],
    ['a decode over a vendor array', 'const s = String.fromCharCode(...codes);'],
    ['a spread that is not the first argument', 'log(label, ...entries);'],
    ['a spread into a constructor', 'const s = new Set(...groups);'],
    ['a spread into a nested call', 'wrap(collect(...page));'],
    ['a two-argument apply', 'fn.apply(null, page);'],
    ['a two-argument apply on a member', 'this.sink.apply(this, page);'],
    // The two shapes a TEXT scan gets wrong: each opens a quote it never closes, so everything
    // after it reads as string and the lint goes quietly blind.
    ['a spread under a comment carrying an apostrophe', "// the vendor's page\nout.push(...page);"],
    ['a spread under a regex carrying a quote', "const re = /'/;\nout.push(...page);"],
  ];

  const KEEPS: Array<[string, string]> = [
    ['an array literal built from a spread', 'for (const ws of [...this.sockets]) close(ws);'],
    ['an object literal built from a spread', 'return this.runFetch({ ...args, since: floor });'],
    ['a rest parameter', 'function log(label: string, ...rest: string[]): void {}'],
    ['a rest binding in a destructure', 'const [first, ...rest] = page;'],
    ['a one-argument apply', 'fn.apply(null);'],
    ['a plain call over an array', 'const kept = page.filter(isPlainMessage);'],
    ['a loop that appends one at a time', 'for (const m of page) collected.push(m);'],
    ['the banned shape quoted as fixture text', 'const bad = "collected.push(...page)";'],
    ['the banned shape inside a template literal', 'const bad = `fn.apply(null, page)`;'],
  ];

  for (const [label, text] of FLAGS) {
    it(`flags ${label}`, () => {
      expect(argumentExplosions(text)).not.toEqual([]);
    });
  }

  for (const [label, text] of KEEPS) {
    it(`leaves ${label} alone`, () => {
      expect(argumentExplosions(text)).toEqual([]);
    });
  }

  it('reports the line each hit sits on, so an offender can be found', () => {
    const probe = 'const a = 1;\nout.push(...page);\nconst b = 2;\nfn.apply(c, page);';
    expect(argumentExplosions(probe)).toEqual([2, 4]);
  });

  const modules = slackSourceModules();

  it('finds source modules to lint (guards against a broken walk)', () => {
    expect(modules.length).toBeGreaterThan(1);
  });

  for (const module of modules) {
    it(`${module.name} explodes no array into an argument list`, () => {
      const lines = argumentExplosions(module.text);
      expect(
        lines,
        `line(s) ${lines.join(', ')}: append in a loop — an argument list is capped at ~125k`,
      ).toEqual([]);
    });
  }
});
