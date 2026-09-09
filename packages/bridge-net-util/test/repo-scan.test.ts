import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backendPackages,
  codeOf,
  commentaryLines,
  consumedNames,
  consumersOf,
  declaredExports,
  exportedNames,
  filesUnder,
  importedNames,
  importsIn,
  starReexports,
  unusedImports,
  withoutComments,
  workspacePackages,
  workspaceRoot,
} from '@sharptrick/parley-net-util/testing';

const plant = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'repo-scan-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

/**
 * The universe half, on a SYNTHETIC tree. Grading the walker against the repository's own layout is
 * what lets a flat listing keep passing until the day a package grows a subdirectory.
 */
describe('the workspace derivation', () => {
  const TREE = {
    'package.json': JSON.stringify({ workspaces: ['packages/*', 'examples/*'] }),
    'packages/alpha/package.json': JSON.stringify({
      name: '@x/alpha',
      publishConfig: { access: 'public' },
      dependencies: { '@sharptrick/parley-conformance': '^0' },
    }),
    'packages/alpha/src/index.ts': 'export const a = 1;\n',
    'packages/alpha/src/deep/nested/here.ts': 'export const b = 2;\n',
    'packages/alpha/src/notes.md': 'not a source\n',
    'packages/alpha/node_modules/evil/index.ts': 'export const nope = 3;\n',
    'packages/beta/package.json': JSON.stringify({ name: '@x/beta', private: true }),
    'packages/beta/src/index.ts': 'export const c = 3;\n',
    'examples/demo/package.json': JSON.stringify({ name: '@x/demo' }),
    'loose/package.json': JSON.stringify({ name: '@x/loose' }),
  };

  it('finds the root by the manifest that declares the workspaces, not by counting `../`', () => {
    const root = plant(TREE);
    expect(workspaceRoot(join(root, 'packages/alpha/src/deep/nested'))).toBe(root);
  });

  it('takes every declared area and nothing outside one', () => {
    const root = plant(TREE);
    expect(workspacePackages(root).map((p) => p.relative)).toEqual([
      'examples/demo',
      'packages/alpha',
      'packages/beta',
    ]);
  });

  it('separates the backends structurally, by what they declare', () => {
    const root = plant(TREE);
    expect(backendPackages(root).map((p) => p.name)).toEqual(['@x/alpha']);
  });

  it('walks to every depth and never into node_modules', () => {
    const root = plant(TREE);
    expect(filesUnder(join(root, 'packages/alpha')).map((f) => f.slice(root.length + 1)).sort()).toEqual([
      'packages/alpha/src/deep/nested/here.ts',
      'packages/alpha/src/index.ts',
    ]);
  });
});

/**
 * The code/prose split, on the shapes that separate them. Every row appears twice — once carrying
 * the subject in commentary, once with the same shape carrying it inside a literal, which is code.
 * Rows that are all shapes the scanner already sees cannot tell a working scanner from one blind to
 * half the grammar.
 */
describe('the code and commentary split', () => {
  const PROBE = /the reviewer|as of (?:today|now)/i;

  it.each([
    ['a whole-line comment', '// as discussed with the reviewer, this stays.', "  example: '// with the reviewer, x.',"],
    ['a trailing comment', 'const x = 1; // as of now this is fine', "const u = 'https://x/as-of-today';"],
    ['a JSDoc continuation', '/**\n * kept as of today\n */', 'const T = /the reviewer/i;'],
    ['a one-line block comment', '/* kept as of today */', "const s = '/* kept as of today */';"],
    [
      'a block continued without a leading star',
      '/*\n   kept as of today,\n   and tomorrow\n*/',
      "const s = ['/*', 'kept as of today', '*/'].join('');",
    ],
    [
      'a block continuation carrying a quote character',
      "/*\n   the reviewer's note\n*/",
      'const s = "/* the reviewer\'s note */";',
    ],
    ['a test name', "  it('as of today it holds', () => {})", "  it('holds', () => { const s = 'as of today'; })"],
  ])('reads %s as commentary and its quoted twin as code', (_label, flagged, ignored) => {
    expect(commentaryLines(flagged).some((text) => PROBE.test(text))).toBe(true);
    expect(commentaryLines(ignored).some((text) => PROBE.test(text))).toBe(false);
  });

  it('stops treating a file as commentary once the block closes', () => {
    const lines = commentaryLines('/*\n   a note\n*/\nconst asOfToday = 1;\nconst reviewer = 2;\n');
    expect(lines[1]).toContain('a note');
    expect(lines.slice(3).join('\n')).not.toMatch(/asOfToday|reviewer/);
  });

  it.each([
    ['a statement', 'const x = 1;', 'const x = 1;'],
    ['a trailing comment', 'const x = 1; // note', 'const x = 1; '],
    ['a comment holding an apostrophe', "// the vendor's page\nconst x = 1;", '\nconst x = 1;'],
    ['a URL inside a literal', "const u = 'http://x';", "const u = 'http://x';"],
    ['a block spanning lines', 'a;\n/* one\n two */\nb;', 'a;\n\n\nb;'],
  ])('strips %s down to its code', (_label, source, code) => {
    expect(withoutComments(source)).toBe(code);
  });

  it('blanks the literals a rule must not read through', () => {
    expect(codeOf("const bad = 'out.push(...page)'; // note")).not.toContain('out.push');
  });

  /**
   * CLASS: a construct whose literal does not close on the line it opens. The per-line matcher this
   * replaces required one, so a multi-line template holding a block-comment opener swallowed THE
   * REST OF THE FILE as commentary, a regex holding `//` truncated its line, and a regex holding a
   * PAIR of quotes had everything between them destroyed — live on 14 lines across 12 files, the
   * worst being the argument-literal extractor the repo's own package-boundary rule is built on.
   *
   * The row this replaces graded only the LINE-CROSSING form with a single unpaired quote, which
   * can never run away under a matcher that requires a literal to close on its own line: it could
   * not fail.
   *
   * Each row asserts that a named identifier AFTER the construct on the SAME line survives, and
   * that the NEXT line survives. Both, because the two failures are different: a bad mask eats the
   * rest of one line, a bad block state eats the rest of the file.
   */
  it.each([
    ['a regex holding single quotes', "const re = /'([^'\\n]*)'/g; const after = 1;"],
    ['a regex holding double quotes', 'const re = /"([^"\\n]*)"/g; const after = 1;'],
    ['a regex holding a backtick', 'const re = /`([^`]*)`/g; const after = 1;'],
    ['a regex character class holding a line-comment marker', 'const re = /[//]/g; const after = 1;'],
    ['a regex holding a block-comment opener', 'const re = /[/][*]/g; const after = 1;'],
    ['a regex with an unpaired quote', "const re = /'/g; const after = 1;"],
    ['a nested template', 'const t = `a ${`b ${x}`} c`; const after = 1;'],
    ['a division, which is not a regex', 'const n = (a) / 2; const after = 1;'],
  ])('reads %s without eating the code around it', (_label, source) => {
    const text = `${source}\nconst next = 2;`;
    expect(withoutComments(text)).toContain('after');
    expect(withoutComments(text)).toContain('next');
    expect(codeOf(text)).toContain('after');
    expect(codeOf(text)).toContain('next');
  });

  it.each([
    ['a block-comment opener', '/*'],
    ['a line-comment marker', '//'],
    ['an apostrophe', "the vendor's"],
    ['a block-comment closer', '*/'],
  ])('survives a multi-line template carrying %s', (_label, payload) => {
    const text = `const t = \`\n  ${payload}\n\`;\nconst after = 1;\nconst next = 2;\n`;
    expect(withoutComments(text)).toContain('after');
    expect(withoutComments(text)).toContain('next');
    expect(codeOf(text)).toContain('after');
  });

  it('reads a template placeholder as the code it is', () => {
    expect(codeOf('const t = `a ${sentinel} b`;')).toContain('sentinel');
    expect(withoutComments('const t = `a ${/* note */ b} c`;')).not.toContain('note');
  });

  it('masks the argument-literal extractor the package-boundary rule is built on', () => {
    const source = "const found = [...args.matchAll(/'([^'\\n]*)'|\"([^\"\\n]*)\"/g)].map(pick);";
    expect(codeOf(source)).toContain('args.matchAll');
    expect(codeOf(source)).toContain('.map(pick)');
  });
});

describe('what a source imports, and from where', () => {
  const own = (spec: string): boolean => spec.startsWith('.');
  const specifiers = (source: string): string[] => importsIn(source).map((b) => b.specifier);

  /**
   * The GRAMMAR, one row per spelling, because five hand-rolled readers of it were in the tree and
   * every one had a hole a row here would have found: a side-effect import binding nothing, a
   * dynamic import, `require`, an `import x = require()`, and — live — an `export { a };` with no
   * `from`, which the shared reader ERASED the next import and FABRICATED `a` out of.
   */
  it.each([
    ['a named clause', "import { a, b } from './x.js';", ['./x.js']],
    ['a side-effect import', "import './x.js';", ['./x.js']],
    ['a type-only import', "import type { T } from './x.js';", ['./x.js']],
    ['a dynamic import', "const m = await import('./x.js');", ['./x.js']],
    ['a require call', "const m = require('./x.js');", ['./x.js']],
    ['an import-equals', "import m = require('./x.js');", ['./x.js']],
    ['a re-export', "export { a } from './x.js';", ['./x.js']],
    ['a wholesale re-export', "export * from './x.js';", ['./x.js']],
    ['a namespace re-export', "export * as ns from './x.js';", ['./x.js']],
    ['an export with no module at all', 'const a = 1;\nexport { a };', []],
    ['an import quoted inside a string', 'const s = "import { X } from \'./x.js\';";', []],
    ['an import named only in a comment', "// import { X } from './x.js';\nconst a = 1;", []],
    [
      'a live import beside a module-less export',
      "const a = 1;\nexport { a };\nimport { X } from './x.js';",
      ['./x.js'],
    ],
  ])('reads the module of %s', (_label, source, modules) => {
    expect(specifiers(source)).toEqual(modules);
  });

  /**
   * The ALIAS fork, which is the distinction the shared reader had backwards. `import { x as y }`
   * is a rename and nothing else: the LOCAL name is what an unused-import rule asks about, and the
   * SOURCE name is what "who consumes this export" asks about. One function cannot answer both,
   * and answering the second with the first failed a live guard on a pure rename.
   */
  it.each([
    ['a named clause', "import { a, b } from './x.js';", ['a', 'b'], ['a', 'b']],
    ['an aliased name', "import { a as renamed } from './x.js';", ['renamed'], ['a']],
    ['a type-only clause', "import type { T as U } from './x.js';", ['U'], ['T']],
    ['a type entry inside a value clause', "import { type T, v } from './x.js';", ['T', 'v'], ['T', 'v']],
    ['a default import', "import Thing from './x.js';", ['Thing'], ['default']],
    ['an aliased re-export', "export { a as b } from './x.js';", ['b'], ['a']],
    ['a namespace import', "import * as ns from './x.js';\nns.reached();", ['ns', 'reached'], ['reached']],
    ['a side-effect import', "import './x.js';", [], []],
    ['a name only spelled, never bound', '// mentions a\nconst o = { a: 1 };', [], []],
    ['a name bound from elsewhere', "import { a } from 'other';", [], []],
  ])('reads %s as local %j and source %j', (_label, source, local, from) => {
    expect([...importedNames(source, own)].sort()).toEqual([...local].sort());
    expect([...consumedNames(source, own)].sort()).toEqual([...from].sort());
  });

  /**
   * A re-export moves a name onward; it is not something needing it. Counting one as a consumer is
   * what let fifteen symbols whose only in-repo reader is a barrel read as live, and it is why the
   * one package that noticed subtracts its own barrel by hand.
   */
  it.each([
    ['an import', "import { wanted } from './x.js';", ['a.ts']],
    ['an aliased import', "import { wanted as w } from './x.js';", ['a.ts']],
    ['a namespace read', "import * as ns from './x.js';\nns.wanted();", ['a.ts']],
    ['a re-export', "export { wanted } from './x.js';", []],
    ['an aliased re-export', "export { wanted as onward } from './x.js';", []],
    ['a mention in prose', '// wanted is described here\nconst wanted = 1;', []],
    ['an import from elsewhere', "import { wanted } from 'other';", []],
  ])('counts %s as a consumer: %j', (_label, text, consumers) => {
    expect(consumersOf('wanted', [{ path: 'a.ts', text }], own)).toEqual(consumers);
  });

  /** What a barrel PUBLISHES, including the two shapes a runtime key enumeration cannot see. */
  it.each([
    ['a declaration', 'export const v = 1;', ['v'], ['v']],
    ['an indented declaration', '  export const v = 1;', ['v'], ['v']],
    ['a type-only re-export', "export type { Only } from './t.js';", [], ['Only']],
    ['an aliased re-export', "export { a as b } from './x.js';", [], ['b']],
    ['a default export', 'const foo = 1;\nexport default foo;', [], ['default']],
    ['a default declaration', 'export default function foo(): void {}', [], ['default']],
    ['a namespace re-export', "export * as ns from './x.js';", [], ['ns']],
    ['a wholesale re-export', "export * from './a.js';", [], []],
    ['a local that is not exported', 'const v = 1;', [], []],
    ['a name only spelled in a string', "const s = 'export const v = 1;';", [], []],
  ])('publishes %s as declared %j and exported %j', (_label, source, declared, exported) => {
    expect(declaredExports(source)).toEqual(declared);
    expect([...exportedNames(source)].sort()).toEqual([...exported].sort());
  });

  /**
   * `export *` republishes names this reader cannot enumerate, so a guard built on
   * {@link exportedNames} alone reads a barrel using one as publishing nothing. Naming the module
   * is what lets a rule ban it rather than silently under-report.
   */
  it.each([
    ['a wholesale re-export', "export * from './a.js';", ['./a.js']],
    ['a type-only wholesale re-export', "export type * from './a.js';", ['./a.js']],
    ['a named re-export', "export { a } from './a.js';", []],
    ['a namespace re-export', "export * as ns from './a.js';", []],
    ['an import', "import './a.js';", []],
  ])('names the module of %s', (_label, source, modules) => {
    expect(starReexports(source)).toEqual(modules);
  });

  /** An import nothing references, across the spellings that keep one alive. */
  it.each([
    ['a name the body calls', "import { a } from './x.js';\na();", []],
    ['a name used in a type position', "import type { T } from './x.js';\nconst v: T = 1;", []],
    ['a name re-exported by the same file', "import { a } from './x.js';\nexport { a };", []],
    ['a name read off a namespace', "import * as ns from './x.js';\nns.a();", []],
    ['a name nothing references', "import { a } from './x.js';", ['a']],
    ['an alias nothing references', "import { a as b } from './x.js';\na();", ['b']],
    ['a name kept alive only by a comment', "import { a } from './x.js';\n// a is fine\n", ['a']],
    ['a name kept alive only by a string', "import { a } from './x.js';\nconst s = 'a';", ['a']],
    ['a re-exported name binding nothing locally', "export { a } from './x.js';", []],
  ])('reports %s as unused: %j', (_label, source, dead) => {
    expect(unusedImports(source)).toEqual(dead);
  });
});
