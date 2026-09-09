import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: the module a seam type is DECLARED in is the contract every backend author reads, and a
 * helper parked in one publishes an implementation from the declaration of an interface — the two
 * things this repo's prime directive keeps apart.
 *
 * The set is resolved with the TypeScript CHECKER, from the seam's own type names to whatever
 * source file declares each of them. Two earlier spellings were both moved off the file they were
 * written about without going red: one anchored on the symbol `BackendPlugin` (a split to a sibling
 * took the guard with it), and one derived the set from the barrel's type-only re-export
 * specifiers — a derivation under the MUTATOR's control, since adding any value re-export from the
 * same specifier drops that module out of the set. A name the checker resolves cannot be moved out
 * of the set by anything written in the barrel.
 *
 * Transpiled rather than scanned as text: a search for `export function` cannot see a `const`
 * arrow, a decorator, or a side-effecting import. The options come from `tsconfig.base.json` so the
 * emit graded is the one the build performs, under an `.mts` name because `NodeNext` decides
 * ESM-or-CJS from the file and a bare `probe.ts` transpiles to CommonJS, whose two prologue
 * statements read as runtime code in every module including an empty one.
 */
const SRC = new URL('./', import.meta.url);

/** The seam (DESIGN §5/§11). Every type a backend author implements against, by name. */
const SEAM_TYPES = [
  'BackendPlugin',
  'BackendConfig',
  'BackendIdentity',
  'FetchRecentArgs',
  'FetchRecentResult',
  'MessageHandler',
] as const;

const BUILD_OPTIONS = ts.convertCompilerOptionsFromJson(
  (
    JSON.parse(readFileSync(new URL('../../../tsconfig.base.json', SRC), 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    }
  ).compilerOptions,
  '.',
).options;

/** Each seam type's DECLARING source file, resolved through the barrel's export aliases. */
function declaringFiles(): Map<string, string> {
  const barrel = fileURLToPath(new URL('index.ts', SRC));
  const program = ts.createProgram([barrel], BUILD_OPTIONS);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(barrel);
  expect(source, 'the barrel did not load, so nothing below resolves').toBeDefined();
  const moduleSymbol = checker.getSymbolAtLocation(source as ts.SourceFile);
  expect(moduleSymbol, 'the barrel is not a module symbol').toBeDefined();
  const exported = checker.getExportsOfModule(moduleSymbol as ts.Symbol);
  const found = new Map<string, string>();
  for (const name of SEAM_TYPES) {
    const alias = exported.find((s) => s.getName() === name);
    if (alias === undefined) continue;
    const symbol = alias.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(alias) : alias;
    const file = symbol.declarations?.[0]?.getSourceFile().fileName;
    if (file !== undefined) found.set(name, file);
  }
  return found;
}

/** The statements tsc emits for a module — `export {}` from an erased module does not count. */
const emitted = (source: string): string[] => {
  const js = ts.transpileModule(source, {
    compilerOptions: BUILD_OPTIONS,
    fileName: 'probe.mts',
  }).outputText;
  const out = ts.createSourceFile('emit.js', js, ts.ScriptTarget.ESNext, true);
  return out.statements
    .filter(
      (st) =>
        !(
          ts.isExportDeclaration(st) &&
          st.exportClause !== undefined &&
          ts.isNamedExports(st.exportClause) &&
          st.exportClause.elements.length === 0
        ),
    )
    .map((st) => st.getText(out).split('\n')[0] as string);
};

const DECLARED = declaringFiles();

describe('the modules declaring the seam emit nothing', () => {
  it('reads the emit, so a row below cannot pass by finding none', () => {
    expect(emitted('export interface A { b: string }')).toEqual([]);
    expect(emitted('export function f(): void {}')).not.toEqual([]);
    expect(emitted('const x = 1;')).not.toEqual([]);
    expect(emitted("import './side-effect.js';")).not.toEqual([]);
  });

  it.each(SEAM_TYPES)('%s is exported by the barrel and resolves to a file', (name) => {
    expect(DECLARED.get(name), `${name} no longer resolves, so no row below grades it`).toBeDefined();
  });

  it.each([...new Set(DECLARED.values())])('%s emits no runtime code', (file) => {
    expect(
      emitted(readFileSync(file, 'utf8')),
      `${file} declares part of the seam and now emits runtime code — the implementation belongs ` +
        'in its own module, re-exported from the barrel',
    ).toEqual([]);
  });
});
