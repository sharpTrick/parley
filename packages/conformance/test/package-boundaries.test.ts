import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: a file in one package reaching INTO another one by path.
 *
 * A cross-package path — read or imported — makes a behaviour-preserving refactor next door redden
 * this package's suite and report the failure against the wrong one. Renaming `post()`'s first
 * parameter in `bridge-core/src/seam.ts`, a change to an interface declaration and nothing else,
 * left core green and failed a case titled "postgres". A package NAME import is untouched: that is
 * the sanctioned way to reach a sibling, and it moves with the sibling's public surface rather than
 * with its layout.
 *
 * The rule this replaces was "no path may leave my own directory", implemented in one package and
 * scoped to its own `test/`. Repo-wide that rule is wrong in both directions: it cannot see the two
 * packages that were violating it, and it forbids the repo-level guards — this file, the packaging
 * rules, the workflow rules — that legitimately walk `packages/` and read the repo root. What is
 * banned is landing INSIDE another package, so a guard that derives the package SET is fine and a
 * guard that names one member of it is not.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const workspaceAreas = (root: string): string[] => [
  ...new Set(
    (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] })
      .workspaces?.map((w) => w.replace(/\/\*+$/, '')) ?? [],
  ),
];

/** Every directory holding a manifest under a declared workspace area — the set, never a member. */
function packageDirs(root: string): string[] {
  return workspaceAreas(root).flatMap((area) => {
    const at = join(root, area);
    if (!existsSync(at)) return [];
    return readdirSync(at)
      .map((d) => join(at, d))
      .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'package.json')));
  });
}

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name)) tsFilesUnder(full, out);
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A path named in prose is not a read, and this file has to be able to describe what it bans. */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

/**
 * Every relative path a source names. Three spellings, because the escape that shipped used the
 * first and the one this file's own controls need uses the third: a quoted literal, an
 * uninterpolated template literal, and the SEGMENT form (`join(dir, '..', '..', 'other', 'src')`),
 * which a quoted-literal scan misses entirely.
 */
export function relativePathsNamed(source: string): string[] {
  const code = withoutComments(source);
  return [
    ...[...code.matchAll(/(['"])(\.\.?\/[^'"\n]*)\1/g)].map((m) => m[2] as string),
    ...[...code.matchAll(/`(\.\.?\/[^`\n$]*)`/g)].map((m) => m[1] as string),
    ...[...code.matchAll(/\b(?:join|resolve)\(([^)]*)\)/g)]
      .map((m) => [...(m[1] as string).matchAll(/'([^']*)'/g)].map((q) => q[1] as string))
      .filter((segments) => segments[0]?.startsWith('..') === true)
      .map((segments) => segments.join('/')),
  ];
}

/** Which of `file`'s named paths land inside a package other than the one holding `file`. */
export function reachesIntoAnotherPackage(
  file: string,
  source: string,
  own: string,
  packages: string[],
): string[] {
  const inside = (abs: string, dir: string): boolean => abs === dir || abs.startsWith(`${dir}/`);
  return [...new Set(relativePathsNamed(source))].filter((p) => {
    const abs = resolve(dirname(file), p);
    return packages.some((dir) => dir !== own && inside(abs, dir));
  });
}

const PACKAGES = packageDirs(REPO);

describe('no package reaches into another one by path', () => {
  const filesOf = (dir: string): string[] => tsFilesUnder(dir);

  it('sees every package and its sources, so the rows below are not an empty table', () => {
    expect(PACKAGES.length).toBeGreaterThan(10);
    expect(PACKAGES.flatMap(filesOf).length).toBeGreaterThan(100);
    const naming = PACKAGES.flatMap(filesOf).filter(
      (f) => relativePathsNamed(readFileSync(f, 'utf8')).length > 0,
    );
    expect(naming.length, 'no relative path found at all — the extractor stopped matching').toBeGreaterThan(20);
  });

  it.each(PACKAGES.map((dir) => [relative(REPO, dir), dir] as const))('%s', (_name, own) => {
    const offenders = filesOf(own).flatMap((f) =>
      reachesIntoAnotherPackage(f, readFileSync(f, 'utf8'), own, PACKAGES).map(
        (p) => `${relative(REPO, f)} → ${p}`,
      ),
    );
    expect(
      offenders,
      'reaches into another package by path; import the symbol through the package name instead',
    ).toEqual([]);
  });
});

/**
 * Both halves of the rule on a SYNTHETIC tree, because the repo's own layout is what a check like
 * this comes to depend on silently: the shape it must catch is the one that is no longer on disk to
 * catch, and the shapes it must ACCEPT are the repo-level guards a blunter rule would forbid.
 */
describe('the boundary rule on a planted tree', () => {
  const plant = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'boundaries-'));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return root;
  };

  const TWO_PACKAGES = {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'DESIGN.md': 'the design\n',
    'packages/alpha/package.json': '{"name":"@x/alpha"}',
    'packages/beta/package.json': '{"name":"@x/beta"}',
    'packages/beta/src/seam.ts': 'export const x = 1;\n',
  };

  const verdict = (root: string, path: string, body: string): string[] => {
    const packages = packageDirs(root);
    const file = join(root, path);
    const own = packages.find((d) => file.startsWith(`${d}/`)) as string;
    return reachesIntoAnotherPackage(file, body, own, packages);
  };

  it('finds the packages of a planted tree at all', () => {
    const root = plant(TWO_PACKAGES);
    expect(packageDirs(root).map((d) => relative(root, d)).sort()).toEqual([
      'packages/alpha',
      'packages/beta',
    ]);
  });

  it.each([
    ['a quoted read of a sibling source', "readFileSync(new URL('../../beta/src/seam.ts', u))", true],
    ['an import of a sibling source', "import { x } from '../../beta/src/seam.js';", true],
    ['a template literal naming one', 'const p = `../../beta/src/seam.ts`;', true],
    ['the segment form', "const p = join(here, '..', '..', 'beta', 'src');", true],
    ['naming the sibling directory itself', "readdirSync('../../beta')", true],
    // The repo-level shapes a "never leave my directory" rule forbids and this one must not.
    ['the packages root', "const dir = new URL('../../', import.meta.url)", false],
    ['a repo-root document', "readFileSync('../../../DESIGN.md')", false],
    ['a path inside its own package', "import { y } from './helpers.js';", false],
    ['a path outside the repo entirely', "spawnSync('../../../../bin/sh')", false],
    ['a sibling path named only in prose', "// see ../../beta/src/seam.ts\nconst a = 1;", false],
  ])('%s reaches in: %s', (_label, body, reaches) => {
    const root = plant(TWO_PACKAGES);
    expect(verdict(root, 'packages/alpha/test/a.test.ts', body).length > 0).toBe(reaches);
  });

  it('reports the same reach from an example package as from a plugin', () => {
    const root = plant({
      ...TWO_PACKAGES,
      'package.json': JSON.stringify({ workspaces: ['packages/*', 'examples/*'] }),
      'examples/demo/package.json': '{"name":"@x/demo"}',
    });
    const body = "import { x } from '../../../packages/beta/src/seam.js';";
    expect(verdict(root, 'examples/demo/test/a.test.ts', body)).toEqual([
      '../../../packages/beta/src/seam.js',
    ]);
  });
});
