import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: the module that declares the seam is TYPES AND DOC COMMENTS. It is the one file every
 * backend author reads as the contract, and a helper parked in it publishes an implementation from
 * the declaration of an interface — the two things this repo's prime directive keeps apart.
 *
 * Graded from what tsc EMITS rather than from the source text: a scan for `export function` is the
 * failure mode this repo has hit four times, and it cannot see a `const` arrow, a decorator, or a
 * side effect. The module is FOUND by asking which one declares `BackendPlugin`, so moving the seam
 * moves this check with it rather than leaving it grading a file that no longer holds the contract.
 */
const SRC = new URL('./', import.meta.url);

const sourceFiles = (): string[] =>
  readdirSync(fileURLToPath(SRC), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

const declaresSeam = (text: string): boolean =>
  ts
    .createSourceFile('probe.ts', text, ts.ScriptTarget.ESNext, true)
    .statements.some((st) => ts.isInterfaceDeclaration(st) && st.name.text === 'BackendPlugin');

const seamModules = (): string[] =>
  sourceFiles().filter((f) => declaresSeam(readFileSync(new URL(f, SRC), 'utf8')));

/** The statements tsc emits for a module — `export {}` from an erased module does not count. */
const emitted = (source: string): string[] => {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
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

describe('the seam declares the contract and emits nothing', () => {
  it('reads the emit, so a row below cannot pass by finding none', () => {
    expect(emitted('export interface A { b: string }')).toEqual([]);
    expect(emitted('export function f(): void {}')).not.toEqual([]);
    expect(emitted('const x = 1;')).not.toEqual([]);
    expect(emitted("import './side-effect.js';")).not.toEqual([]);
  });

  it('exactly one module declares the seam interface', () => {
    expect(seamModules()).toHaveLength(1);
  });

  it('the module that declares the seam interface emits no runtime code', () => {
    const [seam] = seamModules() as [string];
    expect(
      emitted(readFileSync(new URL(seam, SRC), 'utf8')),
      `${seam} declares the seam and now emits runtime code — the implementation belongs in its ` +
        'own module, re-exported from the barrel',
    ).toEqual([]);
  });
});
