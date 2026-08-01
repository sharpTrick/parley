import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the release actually ships, for EVERY public workspace.
 *
 * Four packages each carry their own copy of this check, and all four are packages that already
 * satisfy it — an invariant asserted only where it already holds is an invariant nobody is
 * enforcing. `@sharptrick/parley-core` had no copy, tests live under its `src/`, and its tsconfig
 * had no `exclude`, so 176 compiled test files were 47% of its tarball, every one of them importing
 * `vitest` — a devDependency that cannot resolve in a consumer's install. Nine of thirteen packages
 * declare MIT and ship no LICENSE text.
 *
 * So drive the rows off `scripts/lib/workspaces.mjs`'s `publicWorkspaces()` — the same set the
 * release publishes, read out of the release's own module rather than restated — and a package added
 * tomorrow is graded the day it lands.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Workspace {
  name: string;
  dir: string;
}

/** The release's own set, obtained by running its module — never a second list to drift from it. */
function publicWorkspaces(): Workspace[] {
  const json = execFileSync(
    process.execPath,
    [
      '-e',
      "import('./scripts/lib/workspaces.mjs').then((m) => console.log(JSON.stringify(m.publicWorkspaces())))",
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return JSON.parse(json) as Workspace[];
}

const WORKSPACES = publicWorkspaces();

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** tsconfig include/exclude globs, for the pattern shapes tsc actually accepts here. */
function globToRe(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*/g, (tok) =>
      tok === '**/' ? '(?:[^/]*\\/)*' : tok === '**' ? '.*' : '[^/]*',
    );
  return new RegExp(`^${body}$`);
}

/** Whether `file` (package-relative) lands in the package's compiled output. */
function isEmitted(tsconfig: Record<string, unknown>, file: string): boolean {
  const include = (tsconfig.include as string[] | undefined) ?? ['**/*'];
  const exclude = (tsconfig.exclude as string[] | undefined) ?? [];
  return (
    include.some((g) => globToRe(g).test(file)) && !exclude.some((g) => globToRe(g).test(file))
  );
}

/**
 * Every third-party module a built file imports — the set a consumer's install has to satisfy.
 * Anchored at statement starts, so that the word "from" inside a prose string is not read as one.
 */
const IMPORT_STATEMENT =
  /^\s*(?:import|export)\b[^'"\n]*\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm;

function bareImports(js: string): string[] {
  const specifiers = [...js.matchAll(IMPORT_STATEMENT)].map((m) => m[1] ?? m[2] ?? m[3]!);
  return [
    ...new Set(
      specifiers
        .filter((id) => !id.startsWith('.') && !id.startsWith('node:'))
        .map((id) => id.split('/').slice(0, id.startsWith('@') ? 2 : 1).join('/')),
    ),
  ];
}

const IS_TEST_SOURCE = /\.(?:test|spec)\.[cm]?tsx?$/;
const IS_TEST_ARTIFACT = /\.(?:test|spec)\./;

/**
 * Packages that declare a license and ship no LICENSE text. Pinned EXACTLY, so closing one forces
 * its removal here and a new package that repeats the mistake fails as an unexpected entry — the
 * `if (license === undefined) return` escape hatch the per-package copies use never fires at all.
 */
const LICENSE_GAPS = [
  '@sharptrick/parley-conformance',
  '@sharptrick/parley-matrix',
  '@sharptrick/parley-nats',
  '@sharptrick/parley-net-util',
  '@sharptrick/parley-slack',
  '@sharptrick/parley-telegram',
  '@sharptrick/parley-xmpp',
  '@sharptrick/parley-zulip',
];

describe('every public workspace ships only what a consumer can run', () => {
  it('reads the release set from the release, and it is the whole repo', () => {
    expect(WORKSPACES.length).toBeGreaterThan(10);
    expect(WORKSPACES.map((w) => w.name)).toContain('@sharptrick/parley-core');
    for (const w of WORKSPACES) expect(existsSync(join(REPO_ROOT, w.dir, 'package.json'))).toBe(true);
  });

  it.each(WORKSPACES.map((w) => [w.name, w] as const))(
    '%s compiles no test source into its published output',
    (_name, w) => {
      const dir = join(REPO_ROOT, w.dir);
      const tsconfig = readJson(join(dir, 'tsconfig.json'));
      const sources = filesUnder(join(dir, 'src')).map((f) => `src/${f}`);
      expect(sources.length, 'no sources found to grade').toBeGreaterThan(0);
      const emitted = sources.filter((f) => isEmitted(tsconfig, f));
      expect(emitted.length, 'the include/exclude match emits nothing at all').toBeGreaterThan(0);
      expect(emitted.filter((f) => IS_TEST_SOURCE.test(f))).toEqual([]);
    },
  );

  it.each(WORKSPACES.map((w) => [w.name, w] as const))(
    '%s has no already-built artifact a consumer could not resolve',
    (_name, w) => {
      const dist = join(REPO_ROOT, w.dir, 'dist');
      const built = filesUnder(dist);
      expect(built.filter((f) => IS_TEST_ARTIFACT.test(f))).toEqual([]);

      // Not a `vitest` denylist: the rule is that everything the tarball imports is something the
      // manifest makes npm install. `@sharptrick/parley-conformance` ships vitest imports LEGALLY,
      // because it declares vitest as a peerDependency; bridge-core's 176 packed test files did not.
      const manifest = readJson(join(REPO_ROOT, w.dir, 'package.json'));
      const declared = new Set(
        ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
          Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
        ),
      );
      const undeclared = built
        .filter((f) => f.endsWith('.js'))
        .flatMap((f) =>
          bareImports(readFileSync(join(dist, f), 'utf8')).map((id) => `${f}: ${id}`),
        )
        .filter((row) => !declared.has(row.split(': ')[1]!));
      expect(undeclared).toEqual([]);
    },
  );

  it('the artifact rule can see a violation at all (positive control)', () => {
    expect(IS_TEST_ARTIFACT.test('auth/keycloak.e2e.test.js')).toBe(true);
    expect(IS_TEST_SOURCE.test('src/engine/presence.test.ts')).toBe(true);
    expect(IS_TEST_SOURCE.test('src/engine/presence.ts')).toBe(false);
    expect(isEmitted({ include: ['src/**/*'] }, 'src/a/b.test.ts')).toBe(true);
    expect(isEmitted({ include: ['src/**/*'], exclude: ['src/**/*.test.ts'] }, 'src/a/b.test.ts')).toBe(false);
    expect(isEmitted({ include: ['src/**/*'], exclude: ['src/**/*.test.ts'] }, 'src/a/b.ts')).toBe(true);
    expect(bareImports("import { it } from 'vitest';\nimport x from './y.js';")).toEqual(['vitest']);
    expect(bareImports("import { z } from '@sharptrick/parley-core/deep.js';")).toEqual([
      '@sharptrick/parley-core',
    ]);
    expect(bareImports("import { readFileSync } from 'node:fs';")).toEqual([]);
  });

  it('a declared license ships its text with the package, everywhere it already does', () => {
    const declaring = WORKSPACES.filter(
      (w) => typeof readJson(join(REPO_ROOT, w.dir, 'package.json')).license === 'string',
    );
    expect(declaring.length).toBeGreaterThan(10);
    const missing = declaring
      .filter((w) => !existsSync(join(REPO_ROOT, w.dir, 'LICENSE')))
      .map((w) => w.name);
    expect(missing.sort()).toEqual([...LICENSE_GAPS].sort());
  });
});
