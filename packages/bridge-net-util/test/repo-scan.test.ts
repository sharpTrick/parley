import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backendPackages,
  codeOf,
  commentaryLines,
  consumersOf,
  exportedNames,
  filesUnder,
  importedNames,
  importsIn,
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

  it.each([
    ['a named clause', "import { a, b } from './x.js';", ['a', 'b']],
    ['an aliased name', "import { a as renamed } from './x.js';", ['renamed']],
    ['a type-only clause', "import type { T } from './x.js';", ['T']],
    ['a type entry inside a value clause', "import { type T, v } from './x.js';", ['T', 'v']],
    ['a re-export', "export { a } from './x.js';", ['a']],
    ['a namespace import', "import * as ns from './x.js';\nns.reached();", ['ns', 'reached']],
    ['a default import', "import Thing from './x.js';", ['Thing']],
    ['a name only spelled, never bound', "// mentions a\nconst o = { a: 1 };", []],
    ['a name bound from elsewhere', "import { a } from 'other';", []],
  ])('reads %s', (_label, source, names) => {
    expect([...importedNames(source, own)].sort()).toEqual([...names].sort());
  });

  it('reads the module of a dynamic import', () => {
    expect(importsIn("const m = await import('./x.js');").map((b) => b.specifier)).toEqual(['./x.js']);
  });

  it('counts a barrel type-only export as published surface', () => {
    expect([...exportedNames("export type { Only } from './t.js';\nexport const v = 1;\n")].sort()).toEqual([
      'Only',
      'v',
    ]);
  });

  it('names the files that bind a symbol, and no file that merely spells it', () => {
    const files = [
      { path: 'a.ts', text: "import { wanted } from './x.js';" },
      { path: 'b.ts', text: '// wanted is described here\nconst wanted = 1;' },
    ];
    expect(consumersOf('wanted', files, own)).toEqual(['a.ts']);
  });
});
