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
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TEST = fileURLToPath(new URL('./', import.meta.url));

/** The one module `package.json` publishes; everything else in `src/` is internal. */
const ENTRY = 'index.ts';

/** Exports with no test consumer that are nonetheless public API, each with why. */
const ALLOWED_PUBLIC_API: Array<{ name: string; because: string }> = [];

const NAMED_EXPORT =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm;

/** `export { a, b as c } from './x.js'` — a published name the entry does not itself declare. */
const NAMED_REEXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"];/gm;

const sourceFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const sources = new Map(sourceFiles.map((f) => [f, readFileSync(`${SRC}${f}`, 'utf8')]));
const testSources = readdirSync(TEST)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(`${TEST}${f}`, 'utf8'))
  .join('\n');

const declaredExports = (source: string): string[] =>
  [...source.matchAll(NAMED_EXPORT)].map((m) => m[1] ?? '');

const reexports = (source: string): string[] =>
  [...source.matchAll(NAMED_REEXPORT)].flatMap((m) =>
    (m[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^type\s+/, ''))
      .map((entry) => (/\sas\s/.test(entry) ? entry.split(/\sas\s/)[1] : entry) ?? '')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  );

const occurrences = (name: string): number =>
  [...sources.values(), testSources].reduce(
    (n, text) => n + (text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0),
    0,
  );

describe('zulip public export surface', () => {
  const entry = sources.get(ENTRY) ?? '';

  it('finds the package source to read', () => {
    expect(sourceFiles).toContain(ENTRY);
  });

  /**
   * The parser, against a fixture that carries one export of every shape and three non-exports.
   * Naming a REAL export as the witness for a shape grades nothing: `declaredExports` matches any
   * export spelling of a name, so deleting `(?:async\s+)?` from the regex left the suite green (31
   * passed) and so did rewriting the witness itself as an `export const` (31 passed). A
   * name-presence assertion cannot fail for the reason it claims, and the hole it advertised as
   * guarded was already open. An exact expected SET fails the moment a shape branch is dropped, and
   * cannot be satisfied by a differently-spelled real export.
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
    '  export const notAtColumnZero = 1;',
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
    ]);
    expect(reexports(REEXPORT_FIXTURE)).toEqual(['aName', 'renamed', 'AType']);
  });

  it('reads this package with the parser above, so the rows below are not reading an empty set', () => {
    expect([...sources.values()].flatMap(declaredExports).length).toBeGreaterThan(10);
    expect(reexports(entry).length).toBeGreaterThan(0);
  });

  it('the entry publishes only names a test consumes or the allowlist admits', () => {
    const allowed = new Set(ALLOWED_PUBLIC_API.map((e) => e.name));
    const published = [...declaredExports(entry), ...reexports(entry)];
    const orphans = published.filter(
      (name) => !allowed.has(name) && !new RegExp(`\\b${name}\\b`).test(testSources),
    );
    expect(orphans).toEqual([]);
  });

  for (const [file, source] of sources) {
    it(`${file} re-exports nothing wholesale, so the published list stays enumerable`, () => {
      const wildcards = source
        .split('\n')
        .filter((line) => /^export\s+(?:type\s+)?\*/.test(line.trim()));
      expect(wildcards).toEqual([]);
    });

    if (file === ENTRY) continue;

    it(`${file} exports no name the package never uses`, () => {
      const dead = declaredExports(source).filter((name) => occurrences(name) < 2);
      expect(dead).toEqual([]);
    });
  }

  it('admits nothing to the allowlist without a reason', () => {
    expect(ALLOWED_PUBLIC_API.filter((e) => e.because.trim() === '')).toEqual([]);
  });
});

/**
 * The mirror of the block above, and the same CLASS: a name the source declares that nothing
 * consumes. An unused IMPORT is the cheaper half to acquire and the more misleading to read — it
 * asserts a dependency edge on a symbol no code needs, pointing the next reader at the wrong place
 * for a decision — and nothing else in the repo catches one: `tsconfig.base.json` sets neither
 * `noUnusedLocals` nor `noUnusedParameters`, and there is no linter. This grades imports only,
 * which is what a regex over source can grade honestly; the compiler flags cover locals and
 * parameters too and remain the better guard the day the packages they would newly fail are clean.
 */
const IMPORT_STATEMENT = /^import\s+(?!type\s+['"])([\s\S]*?)\s+from\s+['"][^'"]+['"];/gm;

/** Every local name an import clause binds: named, aliased, default and namespace alike. */
function importedNames(clause: string): string[] {
  const braces = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? '';
  const outside = clause.replace(/\{[\s\S]*?\}/, '').replace(/^type\s+/, '');
  const named = braces
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/, ''))
    .filter((entry) => entry !== '')
    .map((entry) => (/\sas\s/.test(entry) ? entry.split(/\sas\s/)[1] : entry) ?? '');
  const bare = outside
    .split(',')
    .map((entry) => entry.trim().replace(/^\*\s+as\s+/, ''))
    .filter((entry) => /^\w+$/.test(entry));
  return [...named, ...bare].map((name) => name.trim()).filter((name) => name !== '');
}

describe('zulip source imports nothing it does not use', () => {
  for (const [file, source] of sources) {
    it(`${file} binds no import name the rest of the file never references`, () => {
      const body = source.replace(IMPORT_STATEMENT, '');
      const dead = [...source.matchAll(IMPORT_STATEMENT)]
        .flatMap((m) => importedNames(m[1] ?? ''))
        .filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
      expect(dead).toEqual([]);
    });
  }

  it('reads the import clauses it claims to grade, so a parse miss cannot pass as a clean file', () => {
    const bound = [...sources.values()].flatMap((source) =>
      [...source.matchAll(IMPORT_STATEMENT)].flatMap((m) => importedNames(m[1] ?? '')),
    );
    expect(bound).toContain('ZulipPlugin'); // cli.ts, a default-shaped named import
    expect(bound).toContain('fetchWithRetry'); // http.ts, a single-line named clause
    expect(bound).toContain('Topic'); // index.ts, a `type`-prefixed entry in a multi-line clause
  });
});
