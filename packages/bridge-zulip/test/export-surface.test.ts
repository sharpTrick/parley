/**
 * Every named export of `src/index.ts` ships in the published `.d.ts` and becomes a compatibility
 * obligation semantic-release has to version. An internal helper that is exported and used by nobody
 * acquires that obligation by accident, so each name must earn it: either a test consumes it (which
 * is what an exported test seam is FOR) or it is listed below with the reason it is public.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TEST = fileURLToPath(new URL('./', import.meta.url));

/** Exports with no test consumer that are nonetheless public API, each with why. */
const ALLOWED_PUBLIC_API: Array<{ name: string; because: string }> = [];

const NAMED_EXPORT =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm;

const sourceFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const testSources = readdirSync(TEST)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(`${TEST}${f}`, 'utf8'))
  .join('\n');

describe('zulip public export surface', () => {
  it('finds the package source to read', () => {
    expect(sourceFiles).toContain('index.ts');
  });

  for (const file of sourceFiles) {
    const source = readFileSync(`${SRC}${file}`, 'utf8');
    const names = [...source.matchAll(NAMED_EXPORT)].map((m) => m[1] ?? '');

    it(`${file} exports only names a test consumes or the allowlist admits`, () => {
      const allowed = new Set(ALLOWED_PUBLIC_API.map((e) => e.name));
      const orphans = names.filter(
        (name) => !allowed.has(name) && !new RegExp(`\\b${name}\\b`).test(testSources),
      );
      expect(orphans).toEqual([]);
    });

    it(`${file} re-exports nothing wholesale, so this list stays complete`, () => {
      const wildcards = source
        .split('\n')
        .filter((line) => /^export\s+(?:\*|\{)/.test(line.trim()));
      expect(wildcards).toEqual([]);
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
  for (const file of sourceFiles) {
    it(`${file} binds no import name the rest of the file never references`, () => {
      const source = readFileSync(`${SRC}${file}`, 'utf8');
      const body = source.replace(IMPORT_STATEMENT, '');
      const dead = [...source.matchAll(IMPORT_STATEMENT)]
        .flatMap((m) => importedNames(m[1] ?? ''))
        .filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
      expect(dead).toEqual([]);
    });
  }

  it('reads the import clauses it claims to grade, so a parse miss cannot pass as a clean file', () => {
    const bound = sourceFiles.flatMap((file) =>
      [...readFileSync(`${SRC}${file}`, 'utf8').matchAll(IMPORT_STATEMENT)].flatMap((m) =>
        importedNames(m[1] ?? ''),
      ),
    );
    expect(bound).toContain('ZulipPlugin'); // cli.ts, a default-shaped named import
    expect(bound).toContain('fetchWithRetry'); // index.ts, a multi-line named clause
    expect(bound).toContain('Topic'); // index.ts, a `type`-prefixed entry inside that clause
  });
});
