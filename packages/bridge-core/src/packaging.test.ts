import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * Every rule below reads `dist/`, and one of them EXECUTES it, so build it here rather than assume
 * a prior `npm run build` — a rule that grades an absent artifact grades nothing at all, which is
 * how a manifest could promise two files no tarball carried under a green suite. `tsc -b` decides
 * whether the artifact matches `src/`; `--force` is only for the case it gets wrong, a deleted
 * `dist/` under a tsbuildinfo that still reports the project up to date.
 */
let PACKED: Record<string, string[]> = {};

/** Throwaway consumer installs built by the typecheck rows below. */
const scratch: string[] = [];

describe('every public workspace ships only what a consumer can run', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsc', '-b'], { cwd: REPO_ROOT, stdio: 'pipe' });
    const emitted = (w: Workspace): boolean => existsSync(join(REPO_ROOT, w.dir, 'dist'));
    if (!WORKSPACES.every(emitted)) {
      execFileSync('npx', ['tsc', '-b', '--force'], { cwd: REPO_ROOT, stdio: 'pipe' });
    }
    PACKED = packedFiles();
  }, 600_000);

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

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
    it('lists every public workspace, so the rows below are not an empty table', () => {
      expect(WORKSPACES.map((w) => w.name).filter((n) => PACKED[n] === undefined)).toEqual([]);
    });

    it.each(WORKSPACES.map((w) => [w.name] as const))('%s packs its LICENSE and README', (name) => {
      expect(PACKED[name]).toContain('LICENSE');
      expect(PACKED[name]).toContain('README.md');
    });
  });

  /**
   * Every path a manifest promises a consumer — every `bin` target and every `exports` condition —
   * must be inside the tarball and must have a source that builds it. This rule existed as two
   * near-identical copies held by two of thirteen workspaces, both of which already satisfied it,
   * so the eight other packages shipping a `bin` were graded by nothing: narrowing one of their
   * `files` lists to the index alone passed every guard in this repo, `npm pack` included, and
   * would have published a CLI that ENOENTs and an import that resolves to no types.
   */
  const promisedPaths = (node: unknown, out: string[] = []): string[] => {
    if (typeof node === 'string' && node.startsWith('./')) out.push(node);
    else if (Array.isArray(node)) for (const v of node) promisedPaths(v, out);
    else if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node)) promisedPaths(v, out);
    }
    return out;
  };

  const promisesOf = (manifest: Record<string, unknown>): string[] => [
    ...new Set([...promisedPaths(manifest.exports), ...promisedPaths(manifest.bin)]),
  ];

  /**
   * Promised paths the tarball does not carry, read from npm's own listing. Asking `files` whether
   * npm WOULD pack the path re-implements npm and answers about the manifest, not the artifact: it
   * is green on a `dist/` that was never built, that emitted a different layout than `exports`
   * names, or that emitted nothing.
   */
  const unpackedPromises = (manifest: Record<string, unknown>, packed: readonly string[]): string[] => {
    const carried = new Set(packed.map((f) => f.replace(/^\.\//, '')));
    return promisesOf(manifest).filter((path) => !carried.has(path.replace(/^\.\//, '')));
  };

  /** The source a `dist/` artifact is built from, so a promise nothing can build is caught unbuilt. */
  const builtFrom = (path: string): string =>
    path
      .replace(/^\.\//, '')
      .replace(/^dist\//, 'src/')
      .replace(/\.d\.ts$|\.js$/, '.ts');

  it.each(WORKSPACES.map((w) => [w.name, w] as const))(
    '%s packs every path its manifest promises',
    (name, w) => {
      const manifest = readJson(join(REPO_ROOT, w.dir, 'package.json'));
      const promised = promisesOf(manifest);
      expect(promised.length, 'this manifest promises nothing, so the row grades nothing').toBeGreaterThan(0);
      expect(
        unpackedPromises(manifest, PACKED[name] ?? []),
        'npm pack does not list it: build what emits it, or widen "files" — a consumer resolving ' +
          'this path gets ERR_MODULE_NOT_FOUND',
      ).toEqual([]);
    },
  );

  /** The module a bare `import '<pkg>'` resolves to, which is the only entrypoint nothing spawns. */
  const entrypointOf = (manifest: Record<string, unknown>): string | undefined => {
    const root = (manifest.exports as Record<string, unknown> | undefined)?.['.'];
    if (typeof root === 'string') return root;
    const conditions = root as Record<string, unknown> | undefined;
    const fallback = conditions?.default ?? conditions?.import ?? conditions?.require;
    return typeof fallback === 'string' ? fallback : undefined;
  };

  /**
   * Packing the file is not shipping a working one. Nothing in this repo ever imported a built
   * entrypoint — every test resolves `src/` through the vitest alias — so a `dist/index.js` that
   * exists and throws on load shipped green, and `version.ts`, whose whole job is to resolve
   * `../package.json` from wherever the emit lands, was graded only at the path `src/` gives it.
   */
  it.each(WORKSPACES.map((w) => [w.name, w] as const))(
    '%s loads the entrypoint its manifest promises',
    async (_name, w) => {
      const manifest = readJson(join(REPO_ROOT, w.dir, 'package.json'));
      const entry = entrypointOf(manifest);
      expect(entry, 'no root export condition names a module to load').toBeTypeOf('string');
      const loaded = (await import(
        pathToFileURL(join(REPO_ROOT, w.dir, entry!)).href
      )) as Record<string, unknown>;
      expect(Object.keys(loaded).length, 'the built entrypoint exports nothing').toBeGreaterThan(0);

      // A version constant that reads its own manifest is the one export whose ANSWER depends on
      // where the emit landed, so grade it from the built module rather than from `src/`.
      for (const [name, value] of Object.entries(loaded)) {
        if (name.endsWith('_VERSION') && typeof value === 'string') {
          expect(value, `${name} is stale against the manifest this package publishes`).toBe(
            manifest.version,
          );
        }
      }
    },
  );

  it.each(WORKSPACES.map((w) => [w.name, w] as const))(
    '%s has a source for every path its manifest promises',
    (_name, w) => {
      const promised = promisesOf(readJson(join(REPO_ROOT, w.dir, 'package.json')));
      expect(
        promised.filter((p) => !existsSync(join(REPO_ROOT, w.dir, builtFrom(p)))),
        'nothing in this package builds it',
      ).toEqual([]);
    },
  );

  it('sees an unpacked promise and an unbuildable one (positive control)', () => {
    const manifest = {
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      bin: { 'parley-x': './dist/cli.js' },
    };
    expect(promisesOf(manifest)).toEqual(['./dist/index.d.ts', './dist/index.js', './dist/cli.js']);
    expect(promisesOf({ bin: './dist/cli.js' })).toEqual(['./dist/cli.js']);
    expect(unpackedPromises(manifest, ['dist/index.d.ts', 'dist/index.js', 'dist/cli.js'])).toEqual([]);
    expect(unpackedPromises(manifest, ['dist/index.d.ts', 'dist/index.js'])).toEqual(['./dist/cli.js']);
    // The layout drifted under the promise — the emit moved a level down. `files: ["dist"]` still
    // covers it, which is exactly why asking `files` cannot see this.
    expect(
      unpackedPromises(manifest, ['dist/index.d.ts', 'dist/src/index.js', 'dist/cli.js']),
    ).toEqual(['./dist/index.js']);
    expect(unpackedPromises(manifest, [])).toEqual([
      './dist/index.d.ts',
      './dist/index.js',
      './dist/cli.js',
    ]);
    expect(unpackedPromises({ exports: { './package.json': './package.json' } }, ['package.json'])).toEqual([]);
    expect(entrypointOf(manifest)).toBe('./dist/index.js');
    expect(entrypointOf({ exports: { '.': './dist/index.js' } })).toBe('./dist/index.js');
    expect(entrypointOf({ exports: { './package.json': './package.json' } })).toBeUndefined();
    expect(builtFrom('./dist/cli.js')).toBe('src/cli.ts');
    expect(builtFrom('./dist/index.d.ts')).toBe('src/index.ts');
  });

  /**
   * The rule above reads `.js` only, so the whole TYPE surface of the tarball was ungraded: three
   * shipped declaration files type-imported `express`, which carries no typings of its own, while
   * `@types/express` sat in devDependencies — a consumer with `skipLibCheck: false` got TS7016 on
   * the documented public API, and one with the usual `skipLibCheck: true` silently got `any`.
   *
   * Nothing static can see that: this repo hoists every `@types/*` into one `node_modules`, so a
   * declaration always resolves here whoever declared it. So COMPILE it — a throwaway consumer whose
   * module resolution sees only what the manifest obliges an install to fetch, and `@types/node`,
   * which by convention is the consumer's own. That reaches any future dependency whose typings live
   * somewhere else, not just this one.
   */
  const AMBIENT = ['@types/node'];
  const INTERNAL = /^@sharptrick\//;

  const declaredDeps = (manifest: Record<string, unknown>): string[] => [
    ...new Set(
      ['dependencies', 'peerDependencies'].flatMap((field) =>
        Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
      ),
    ),
  ];

  const link = (from: string, to: string): void => {
    if (existsSync(to) || !existsSync(from)) return;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);
  };

  /**
   * A consumer's install, as a real directory: workspace packages COPIED (a symlink would realpath
   * back into the repo and resolve the hoisted types this rule exists to withhold), everything else
   * symlinked from the repo's own install, and nothing at all for a type package the manifest does
   * not name. Returns whatever tsc says about it.
   */
  function consumerErrors(entryPackages: string[], seedNodeModules: (nm: string) => void): string[] {
    const root = mkdtempSync(join(tmpdir(), 'parley-consumer-'));
    scratch.push(root);
    const nm = join(root, 'node_modules');
    mkdirSync(nm, { recursive: true });
    seedNodeModules(nm);
    for (const name of AMBIENT) link(join(REPO_ROOT, 'node_modules', name), join(nm, name));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        files: ['consumer.ts'],
      }),
    );
    writeFileSync(
      join(root, 'consumer.ts'),
      entryPackages.map((n, i) => `import * as p${i} from '${n}';\nexport const e${i} = p${i};`).join('\n'),
    );
    const tsc = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
    try {
      execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      return [];
    } catch (e) {
      const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
      const reported = out.split('\n').filter((l) => l.includes('error TS'));
      // A compiler that failed without saying "error TS" — it could not start, or the project is
      // malformed — must not read as a clean typecheck.
      return reported.length > 0 ? reported : [`tsc failed with no diagnostic: ${out.trim()}`];
    }
  }

  /** Copy `w` and every workspace it depends on into `nm`, so none of them resolves via the repo. */
  function installWorkspace(nm: string, name: string): void {
    const w = WORKSPACES.find((x) => x.name === name);
    if (w === undefined || existsSync(join(nm, name))) return;
    const manifest = readJson(join(REPO_ROOT, w.dir, 'package.json'));
    mkdirSync(join(nm, name), { recursive: true });
    cpSync(join(REPO_ROOT, w.dir, 'dist'), join(nm, name, 'dist'), { recursive: true });
    cpSync(join(REPO_ROOT, w.dir, 'package.json'), join(nm, name, 'package.json'));
    for (const dep of declaredDeps(manifest)) {
      if (INTERNAL.test(dep)) installWorkspace(nm, dep);
      else link(join(REPO_ROOT, 'node_modules', dep), join(nm, dep));
    }
  }

  it.each(WORKSPACES.map((w) => [w.name] as const))(
    '%s type-checks in an install holding only what its manifest declares',
    (name) => {
      expect(consumerErrors([name], (nm) => installWorkspace(nm, name))).toEqual([]);
    },
    120_000,
  );

  it('the consumer typecheck sees a declaration a manifest does not pay for (positive control)', () => {
    const leaky = (nm: string): void => {
      const dir = join(nm, '@parley-probe', 'leaky');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: '@parley-probe/leaky',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        }),
      );
      writeFileSync(join(dir, 'dist', 'index.js'), 'export const mounted = true;\n');
      writeFileSync(
        join(dir, 'dist', 'index.d.ts'),
        "import type { Express } from 'express';\nexport declare const mounted: Express;\n",
      );
      // The type it needs is one symlink away and deliberately NOT made, exactly as a consumer's
      // install leaves it when the manifest never asked for it.
      link(join(REPO_ROOT, 'node_modules', 'express'), join(nm, 'express'));
    };
    const errors = consumerErrors(['@parley-probe/leaky'], leaky);
    expect(errors.join('\n')).toContain('TS7016');

    // …and the same probe passes once the type package is there, so the row is not just red always.
    const paid = (nm: string): void => {
      leaky(nm);
      link(join(REPO_ROOT, 'node_modules', '@types', 'express'), join(nm, '@types', 'express'));
    };
    expect(consumerErrors(['@parley-probe/leaky'], paid)).toEqual([]);
  }, 120_000);

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
