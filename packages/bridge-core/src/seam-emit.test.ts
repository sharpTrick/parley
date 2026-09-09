import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: a module this package publishes as TYPES AND DOC COMMENTS is the contract every backend
 * author reads, and a helper parked in one publishes an implementation from the declaration of an
 * interface — the two things this repo's prime directive keeps apart.
 *
 * The modules are derived from the BARREL: every specifier `src/index.ts` re-exports only types
 * from, and transitively every specifier those re-export only types from. Anchoring on a SET rather
 * than on a symbol is the point. Finding the file by asking which one declares `BackendPlugin` let
 * a split hide the defect — moving that one interface to a sibling, leaving every other seam type,
 * the whole contract doc block and `export const HELPER = …` behind in `seam.ts`, took the guard
 * off the file it was written about and left three rows green. A set survives the split, a rename,
 * and a second declaration file.
 *
 * Transpiled rather than scanned as text: a search for `export function` cannot see a `const`
 * arrow, a decorator, or a side-effecting import, and is the failure mode this repo has hit four
 * times. The options come from `tsconfig.base.json`, so the emit graded here is the one the build
 * performs rather than a second dialect that drifts from it — under an `.mts` name, because
 * `NodeNext` decides ESM-or-CJS from the file and a bare `probe.ts` transpiles to CommonJS, whose
 * two prologue statements read as runtime code in every module including an empty one.
 */
const SRC = new URL('./', import.meta.url);
const BARREL = 'index.ts';

const BUILD_OPTIONS = ts.convertCompilerOptionsFromJson(
  (
    JSON.parse(readFileSync(new URL('../../../tsconfig.base.json', SRC), 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    }
  ).compilerOptions,
  '.',
).options;

/**
 * The relative specifiers a module re-exports ONLY types from. A specifier that also carries a
 * value export anywhere in the module is excluded, so `export { asTopic } from './message.js'`
 * beside `export type { Topic } from './message.js'` keeps `message.ts` out — it is allowed to emit.
 */
function typeOnlySpecifiers(text: string): string[] {
  const parsed = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.ESNext, true);
  const typeOnly = new Set<string>();
  const value = new Set<string>();
  for (const st of parsed.statements) {
    if (!ts.isExportDeclaration(st)) continue;
    const from = st.moduleSpecifier;
    if (from === undefined || !ts.isStringLiteral(from)) continue;
    const clause = st.exportClause;
    const allTypes =
      st.isTypeOnly ||
      (clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((e) => e.isTypeOnly));
    (allTypes ? typeOnly : value).add(from.text);
  }
  for (const spelled of value) typeOnly.delete(spelled);
  return [...typeOnly];
}

const resolveFrom = (from: string, spec: string): string | undefined => {
  if (!spec.startsWith('.')) return undefined;
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return new URL(spec, `file:///${dir}`).pathname.slice(1).replace(/\.js$/, '.ts');
};

/** Every module reachable from `entry` through type-only re-exports, transitively. */
function typeOnlyModules(entry: string, read: (path: string) => string): string[] {
  const found: string[] = [];
  const walk = (from: string): void => {
    for (const spec of typeOnlySpecifiers(read(from))) {
      const path = resolveFrom(from, spec);
      if (path === undefined || found.includes(path)) continue;
      found.push(path);
      walk(path);
    }
  };
  walk(entry);
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

const readSource = (path: string): string => readFileSync(new URL(path, SRC), 'utf8');

const typeOnlyModulesOfBarrel = (): string[] => typeOnlyModules(BARREL, readSource);

/** Whether every module of a synthetic package still emits nothing — the check, run in miniature. */
const checkPasses = (files: Record<string, string>): boolean => {
  const modules = typeOnlyModules(BARREL, (p) => files[p] ?? '');
  return modules.length > 0 && modules.every((m) => emitted(files[m] ?? '').length === 0);
};

const SEAM = 'export interface BackendPlugin { connect(): Promise<void> }\n';
const HELPER = 'export const HELPER = (m: string): string => m;\n';

describe('the modules the barrel publishes as types emit nothing', () => {
  it('reads the emit, so a row below cannot pass by finding none', () => {
    expect(emitted('export interface A { b: string }')).toEqual([]);
    expect(emitted('export function f(): void {}')).not.toEqual([]);
    expect(emitted('const x = 1;')).not.toEqual([]);
    expect(emitted("import './side-effect.js';")).not.toEqual([]);
  });

  it('derives a non-empty set from the barrel, including the module declaring the seam', () => {
    const modules = typeOnlyModulesOfBarrel();
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((m) => readSource(m).includes('interface BackendPlugin'))).not.toEqual([]);
  });

  it('leaves a module the barrel also re-exports a value from out of the set', () => {
    expect(typeOnlyModulesOfBarrel()).not.toContain('message.ts');
  });

  it.each(typeOnlyModulesOfBarrel())('%s emits no runtime code', (module) => {
    expect(
      emitted(readSource(module)),
      `${module} is published by the barrel as types only and now emits runtime code — the ` +
        'implementation belongs in its own module, re-exported from the barrel',
    ).toEqual([]);
  });

  /**
   * The check against the shapes it exists to catch, run over a synthetic package so the plant is
   * real rather than described. The SPLIT rows are the ones the symbol-anchored predecessor let
   * through: `BackendPlugin` moves to a sibling and the runtime code stays behind.
   */
  it.each([
    [
      'a clean seam',
      { [BARREL]: "export type { BackendPlugin } from './seam.js';\n", 'seam.ts': SEAM },
      true,
    ],
    [
      'runtime code in the seam module',
      { [BARREL]: "export type { BackendPlugin } from './seam.js';\n", 'seam.ts': SEAM + HELPER },
      false,
    ],
    [
      'the seam interface split to a sibling the barrel names, helper left behind',
      {
        [BARREL]:
          "export type { BackendPlugin } from './seam-plugin.js';\n" +
          "export type { MessageHandler } from './seam.js';\n",
        'seam-plugin.ts': SEAM,
        'seam.ts': 'export type MessageHandler = (m: string) => void;\n' + HELPER,
      },
      false,
    ],
    [
      'the seam interface split to a sibling only the seam module names',
      {
        [BARREL]: "export type { BackendPlugin } from './seam.js';\n",
        'seam.ts': "export type { BackendPlugin } from './seam-plugin.js';\n" + HELPER,
        'seam-plugin.ts': SEAM,
      },
      false,
    ],
    [
      'runtime code in a module reached only through the seam module',
      {
        [BARREL]: "export type { BackendPlugin } from './seam.js';\n",
        'seam.ts': "export type { BackendPlugin } from './seam-plugin.js';\n",
        'seam-plugin.ts': SEAM + HELPER,
      },
      false,
    ],
  ] as Array<[string, Record<string, string>, boolean]>)(
    'the check reports %s as passing=%s',
    (_label, files, passes) => {
      expect(checkPasses(files)).toBe(passes);
    },
  );
});
