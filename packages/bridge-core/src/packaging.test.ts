import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the release actually ships, for EVERY public workspace.
 *
 * Four packages each carried their own copy of this check, and all four were packages that already
 * satisfied it — an invariant asserted only where it already holds is an invariant nobody is
 * enforcing. `@sharptrick/parley-core` had no copy, tests live under its `src/`, and its tsconfig
 * had no `exclude`, so 176 compiled test files were 47% of its tarball, every one of them importing
 * `vitest` — a devDependency that cannot resolve in a consumer's install.
 *
 * So drive the rows off `scripts/lib/workspaces.mjs`'s `publicWorkspaces()` — the same set the
 * release publishes, read out of the release's own module rather than restated — and a package added
 * tomorrow is graded the day it lands. Grade the TARBALL as well as the checkout: `files` decides
 * what npm uploads, so a rule read off the working tree can pass on bytes the registry never gets.
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

/** The tarball npm would upload for every public workspace, as npm itself lists it. */
function packedFiles(): Record<string, string[]> {
  const json = execFileSync('npm', ['pack', '--dry-run', '--json', '--workspaces'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const packs = JSON.parse(json) as { name: string; files: { path: string }[] }[];
  return Object.fromEntries(packs.map((p) => [p.name, p.files.map((f) => f.path)]));
}

/**
 * A module-level array of workspace NAMES is the shape this file fell into: a repo-wide invariant
 * recorded as the list of packages that break it. Nine tarballs claimed MIT and carried no licence
 * text under a green suite, because the assertion compared the gap against a register of the gap.
 * A register like that goes green by growing, and the next package to repeat the mistake is one
 * line from being excused — so the shape itself is what is banned here.
 */
const registriesOfWorkspaceNames = (source: string): string[] =>
  [...source.matchAll(/^const (\w+)(?::[^=]*)? = \[([\s\S]*?)^\];/gm)]
    .map(([, name, body]) => ({
      name: name as string,
      entries: [...(body as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string),
    }))
    .filter(
      ({ entries }) =>
        entries.length > 0 && entries.every((e) => WORKSPACES.some((w) => w.name === e)),
    )
    .map(({ name }) => name);

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

  it('a declared license ships its text with the package', () => {
    const declaring = WORKSPACES.filter(
      (w) => typeof readJson(join(REPO_ROOT, w.dir, 'package.json')).license === 'string',
    );
    expect(declaring.length).toBeGreaterThan(10);
    const missing = declaring
      .filter((w) => !existsSync(join(REPO_ROOT, w.dir, 'LICENSE')))
      .map((w) => w.name);
    expect(
      missing.sort(),
      '`files: ["dist"]` packs LICENSE only from the package directory — the repo-root one is not ' +
        'in a workspace tarball. `cp LICENSE` into the package',
    ).toEqual([]);
  });

  /**
   * The working tree is not the tarball: `files` decides what npm uploads, and the two answers
   * differed for every package here. Graded through `npm pack` itself, so the rule is what the
   * registry would receive rather than what the checkout happens to hold.
   */
  describe('what npm would upload', () => {
    const PACKED = packedFiles();

    it('lists every public workspace, so the rows below are not an empty table', () => {
      expect(WORKSPACES.map((w) => w.name).filter((n) => PACKED[n] === undefined)).toEqual([]);
    });

    it.each(WORKSPACES.map((w) => [w.name] as const))('%s packs its LICENSE and README', (name) => {
      expect(PACKED[name]).toContain('LICENSE');
      expect(PACKED[name]).toContain('README.md');
    });
  });

  it('records no package as excused from a rule this file grades', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(
      registriesOfWorkspaceNames(source),
      'close the gap rather than registering it: a list of the packages that fail a rule is how ' +
        'this file went green about eight tarballs with no licence text',
    ).toEqual([]);
  });

  it('would see such a register if one came back (positive control)', () => {
    const planted = `const GAPS = [\n  '${WORKSPACES[0]?.name ?? ''}',\n];\n`;
    expect(registriesOfWorkspaceNames(planted)).toEqual(['GAPS']);
    expect(registriesOfWorkspaceNames(`const GAPS = [\n];\n`)).toEqual([]);
    expect(registriesOfWorkspaceNames(`const WORDS = [\n  'not-a-workspace',\n];\n`)).toEqual([]);
  });
});
