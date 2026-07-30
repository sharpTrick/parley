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
