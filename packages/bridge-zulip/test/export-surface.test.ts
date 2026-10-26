/**
 * `package.json` maps the package's one export condition to `dist/index.js`, so the PUBLISHED
 * surface is what `src/index.ts` exports — whether it declares the name or re-exports it by name.
 * Every published name becomes a compatibility obligation semantic-release has to version, so each
 * must earn it: either a test consumes it (which is what an exported test seam is FOR) or it is
 * listed below with the reason it is public.
 *
 * Every other `src/` file is internal — a consumer cannot reach it — so its exports are graded on
 * the weaker thing that still matters: that something in the package uses them. That split is what
 * keeps a module boundary from reading as new API.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  consumersOf,
  declaredExports,
  derivedRows,
  exportedNames,
  importsIn,
  starReexports,
  unusedImports,
} from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TEST = fileURLToPath(new URL('./', import.meta.url));

/** The one module `package.json` publishes; everything else in `src/` is internal. */
const ENTRY = 'index.ts';

/** Exports with no test consumer that are nonetheless public API, each with why. */
const ALLOWED_PUBLIC_API: Array<{ name: string; because: string }> = [
  {
    name: 'ZulipBackendConfig',
    because:
      'the shape a deployment writes under backend_config, so a consumer typing that object needs ' +
      'it published. Nothing inside this package binds it: the barrel moves it onward, which is a ' +
      're-export rather than a consumer of it',
  },
];

const sourceFiles = derivedRows(
  'every zulip source module',
  () => readdirSync(SRC).filter((f) => f.endsWith('.ts')),
  { floor: 5, witness: [ENTRY, 'http.ts'] },
);
const sources = new Map(sourceFiles.map((f) => [f, readFileSync(`${SRC}${f}`, 'utf8')]));

/**
 * Every file of the package as a named source, so "is this name still used?" is answered from the
 * IMPORT that binds it rather than from how often it is spelled.
 *
 * Counting occurrences over concatenated text made a comment naming the symbol a consumer of it.
 * Under this repository's comment doctrine that is the cheapest artifact available: adding one line
 * of prose turned a red row green, watched both ways.
 */
const files = [
  ...sourceFiles.map((f) => ({ path: `src/${f}`, text: readFileSync(`${SRC}${f}`, 'utf8') })),
  ...readdirSync(TEST)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ path: `test/${f}`, text: readFileSync(`${TEST}${f}`, 'utf8') })),
];

/** Anything this package can bind one of its own names from: a sibling module, or its own barrel. */
const withinPackage = (specifier: string): boolean =>
  specifier.startsWith('.') || specifier === '@sharptrick/parley-zulip';

/** A published name the module does not itself declare — `export { a, b as c } from './x.js'`. */
const reexports = (source: string): string[] => {
  const declared = new Set(declaredExports(source));
  return [...exportedNames(source)].filter((name) => !declared.has(name));
};

/** The files that BIND `name` from inside this package, never counting the one that declares it. */
const importersOf = (name: string, declaredIn: string): string[] =>
  consumersOf(name, files, withinPackage).filter((path) => path !== `src/${declaredIn}`);

describe('zulip public export surface', () => {
  const entry = sources.get(ENTRY) ?? '';

  it('finds the package source to read', () => {
    expect(sourceFiles).toContain(ENTRY);
  });

  /**
   * The parser, against a fixture that carries one export of every shape and two non-exports.
   * Naming a REAL export as the witness for a shape grades nothing: a name-presence assertion
   * cannot fail for the reason it claims. An exact expected SET fails the moment a shape stops
   * being read, and cannot be satisfied by a differently-spelled real export.
   */
  const SHAPE_FIXTURE = [
    'export const aConst = 1;',
    'export let aLet = 1;',
    'export var aVar = 1;',
    'export function aFunction(): void {}',
    'export async function anAsyncFunction(): Promise<void> {}',
    'export class AClass {}',
    'export abstract class AnAbstractClass {}',
    'export interface AnInterface { a: string }',
    'export type AType = string;',
    'export enum AnEnum { A }',
    'export declare const aDeclaredConst: number;',
    '  export const indentedInsideNothing = 1;',
    'const notExported = 1;',
    "const mentions = 'export function notADeclaration()';",
  ].join('\n');

  const REEXPORT_FIXTURE = [
    "export { aName, other as renamed } from './x.js';",
    "export type { AType } from './y.js';",
    "import { notAnExport } from './z.js';",
  ].join('\n');

  it('reads every export shape it claims to grade, so a parse miss cannot pass as a clean file', () => {
    expect(declaredExports(SHAPE_FIXTURE)).toEqual([
      'aConst',
      'aLet',
      'aVar',
      'aFunction',
      'anAsyncFunction',
      'AClass',
      'AnAbstractClass',
      'AnInterface',
      'AType',
      'AnEnum',
      'aDeclaredConst',
      'indentedInsideNothing',
    ]);
    expect(reexports(REEXPORT_FIXTURE)).toEqual(['aName', 'renamed', 'AType']);
  });

  it('reads this package with the parser above, so the rows below are not reading an empty set', () => {
    expect([...sources.values()].flatMap(declaredExports).length).toBeGreaterThan(10);
    expect(reexports(entry).length).toBeGreaterThan(0);
  });

  const published = new Set([...declaredExports(entry), ...reexports(entry)]);

  it('the entry publishes only names a test consumes or the allowlist admits', () => {
    const allowed = new Set(ALLOWED_PUBLIC_API.map((e) => e.name));
    const orphans = [...published].filter(
      (name) => !allowed.has(name) && importersOf(name, ENTRY).length === 0,
    );
    expect(orphans).toEqual([]);
  });

  it('reads an import of this package rather than a mention of it', () => {
    expect(importersOf('ZulipPlugin', ENTRY)).not.toEqual([]);
    expect(
      consumersOf('ZulipPlugin', [{ path: 'test/prose.ts', text: '// ZulipPlugin lives here\n' }], withinPackage),
    ).toEqual([]);
  });

  for (const [file, source] of sources) {
    it(`${file} re-exports nothing wholesale, so the published list stays enumerable`, () => {
      expect(starReexports(source)).toEqual([]);
    });

    if (file === ENTRY) continue;

    it(`${file} exports no name the package never uses`, () => {
      const dead = declaredExports(source)
        .filter((name) => !published.has(name))
        .filter((name) => importersOf(name, file).length === 0);
      expect(dead).toEqual([]);
    });
  }

  it('admits nothing to the allowlist without a reason', () => {
    expect(ALLOWED_PUBLIC_API.filter((e) => e.because.trim() === '')).toEqual([]);
  });
});

/**
 * The mirror of the block above, and the same CLASS: a name the source declares that nothing
 * consumes. `unusedImports` is the shared reader's answer; what this file adds is that the rule
 * runs over every module of this package.
 */
describe('zulip source imports nothing it does not use', () => {
  for (const [file, source] of sources) {
    it(`${file} binds no import name the rest of the file never references`, () => {
      expect(unusedImports(source)).toEqual([]);
    });
  }

  it('reads the import clauses it claims to grade, so a parse miss cannot pass as a clean file', () => {
    const bound = [...sources.values()].flatMap((source) =>
      importsIn(source).flatMap((binding) => binding.names),
    );
    expect(bound).toContain('ZulipPlugin'); // cli.ts, a default-shaped named import
    expect(bound).toContain('fetchWithRetry'); // http.ts, a single-line named clause
    expect(bound).toContain('Topic'); // index.ts, a `type`-prefixed entry in a multi-line clause
  });
});
