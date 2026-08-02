/**
 * CLASS: a test in THIS package may not name a path in another one.
 *
 * A cross-package path — read or imported — makes a behaviour-preserving refactor next door redden
 * this suite and report the failure against the wrong package. `documented-scopes.test.ts` regexed
 * `../../bridge-core/src/engine/presence.ts` for a private function's name, its return-type
 * annotation and its closing-brace column: renaming `emitterOf`, or moving presence.ts one
 * directory, failed a test titled "slack documented scopes" while bridge-core's own suite stayed
 * green. CLAUDE.md's standing rule names exactly this — prefer an import of a symbol over a regex
 * that finds it in a particular file — and here it crosses a package boundary, where no
 * package-scoped critic can see both ends.
 *
 * The invariant is PATHS, not filenames: this walks the test tree rather than a list of the files
 * that violate it today, so the next such read fails here instead of being silently accepted. A
 * package NAME import (`@sharptrick/parley-core`) is untouched — that is the sanctioned way to reach
 * a sibling, and it moves with the sibling's public surface rather than with its layout.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Every `.ts` under the package, at any depth — never a hand-listed set of the files that exist today. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every relative path a source names, as a single- or double-quoted literal starting with `./` or
 * `../`. Every disk read and every relative import in this suite is anchored on one of these, so a
 * path that escapes the package is visible here whether it reaches `new URL`, a `read()`-style
 * helper, or an `import` specifier — the escape that shipped went through a helper, so a scan
 * keyed on `new URL` alone would have accepted it.
 */
export function relativePathLiterals(source: string): string[] {
  return [...source.matchAll(/(['"])(\.\.?\/[^'"\n]*)\1/g)].map((m) => m[2]!);
}

/** Which of `paths`, resolved against `fromDir`, land outside `packageDir`. */
export function escapingPaths(paths: string[], fromDir: string, root: string): string[] {
  return paths.filter((p) => {
    const rel = relative(root, resolve(fromDir, p));
    return rel === '..' || rel.startsWith(`..${'/'}`);
  });
}

describe('no bridge-slack test names a path in another package', () => {
  const files = tsFilesUnder(join(packageDir, 'test'));

  it('the scan sees the test tree it is written about', () => {
    expect(files.length, 'no test sources found — the scan would grade nothing').toBeGreaterThan(5);
    const withLiterals = files.filter((f) => relativePathLiterals(readFileSync(f, 'utf8')).length > 0);
    expect(
      withLiterals.length,
      'no relative path literal found at all — the extractor stopped matching',
    ).toBeGreaterThan(5);
  });

  /**
   * Positive control on the extractor + the escape rule, run over synthetic sources rather than the
   * tree: a scanner that quietly stopped matching would otherwise report a clean tree forever, and
   * the shape it must catch is the one that is no longer on disk to catch.
   */
  // Assembled from segments, never written out: a control spelled as a path literal would be found
  // by the tree scan below and fail this file for containing the shape it exists to describe.
  const sibling = (...parts: string[]): string => ['..', '..', ...parts].join('/');

  it.each([
    [`read('${sibling('bridge-core', 'src', 'engine', 'presence.ts')}')`, true],
    [`readFileSync(new URL("${sibling('bridge-matrix', 'src', 'config.ts')}", import.meta.url))`, true],
    [`import { x } from '${sibling('bridge-postgres', 'src', 'seam.js')}'`, true],
    ["read('../README.md')", false],
    ["import { FakeSlack } from './fake-slack.js'", false],
    ["const dir = new URL('../src', import.meta.url)", false],
  ])('%s escapes the package: %s', (source, escapes) => {
    const found = relativePathLiterals(source);
    expect(found, 'the extractor found no path literal at all').not.toEqual([]);
    expect(escapingPaths(found, join(packageDir, 'test'), packageDir).length > 0).toBe(escapes);
  });

  it.each(files.map((f) => [relative(packageDir, f), f] as const))('%s', (_name, file) => {
    const escaped = escapingPaths(
      relativePathLiterals(readFileSync(file, 'utf8')),
      join(file, '..'),
      packageDir,
    );
    expect(escaped, 'reaches outside packages/bridge-slack; import a symbol instead').toEqual([]);
  });
});
