import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packagesDir = new URL('../../', import.meta.url);

interface Manifest {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  description?: string;
  keywords?: string[];
  files?: string[];
  repository?: { directory?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifests(): { dir: string; pkg: Manifest }[] {
  const out: { dir: string; pkg: Manifest }[] = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    try {
      out.push({
        dir,
        pkg: JSON.parse(readFileSync(new URL(`${dir}/package.json`, packagesDir), 'utf8')) as Manifest,
      });
    } catch {
      continue;
    }
  }
  return out;
}

const published = (): { dir: string; pkg: Manifest }[] =>
  manifests().filter(({ pkg }) => pkg.private !== true);

// Everything here publishes in lockstep from one merge, so per-package manifest drift is invisible
// until a consumer cannot find the package. Asserted over EVERY workspace package rather than the
// one that was wrong, so the next package cannot ship without the same metadata.
describe('every published package carries the same discovery metadata', () => {
  it.each(published().map(({ dir }) => dir))('%s ships it', (dir) => {
    const { pkg } = published().find((p) => p.dir === dir) as { pkg: Manifest };
    expect(pkg.keywords ?? []).toContain('mcp');
    expect((pkg.keywords ?? []).length).toBeGreaterThanOrEqual(5);
    expect(pkg.description ?? '').not.toBe('');
    expect((pkg.description ?? '').toLowerCase()).not.toMatch(/^(todo|internal)/);
    expect(pkg.repository?.directory).toBe(`packages/${dir}`);
    expect((pkg.files ?? []).length).toBeGreaterThan(0);
  });
});

/**
 * "Which packages are backends" is derived in several places, and deriving it from the `bridge-*`
 * DIRECTORY prefix needs a growing exception list — neither `bridge-core` nor `bridge-net-util` is a
 * `BackendPlugin` — so the next non-backend added under that prefix joins the set silently. The
 * manifest is the honest source: a backend is a package GRADED by this suite. Cross-checked here
 * against the independent evidence, the fixture that actually runs it.
 */
describe('the backend set is derived from the manifests, not from a directory prefix', () => {
  const SUITE = '@sharptrick/parley-conformance';

  const dependsOnSuite = (): string[] =>
    manifests()
      .filter(({ pkg }) => SUITE in { ...pkg.dependencies, ...pkg.devDependencies })
      .map(({ dir }) => dir)
      .sort();

  const runsTheSuite = (): string[] =>
    manifests()
      .filter(({ dir, pkg }) => {
        if (pkg.name === SUITE) return false; // the suite's own controls are not a backend
        try {
          return readFileSync(
            new URL(`${dir}/test/conformance.test.ts`, packagesDir),
            'utf8',
          ).includes('runConformanceSuite(');
        } catch {
          return false;
        }
      })
      .map(({ dir }) => dir)
      .sort();

  it('every package that declares the suite runs it, and every package that runs it declares it', () => {
    expect(dependsOnSuite().length).toBeGreaterThan(5);
    expect(dependsOnSuite()).toEqual(runsTheSuite());
  });

  it('excludes what a `bridge-*` prefix would have needed an exception for', () => {
    for (const dir of ['bridge-core', 'bridge-net-util', 'conformance']) {
      expect(dependsOnSuite()).not.toContain(dir);
    }
  });
});

// A `tsconfig.test.json` that resolves its own package through node_modules typechecks the BUILT
// dist/, not the sources vitest runs — so the one gate that would have caught a changed public
// surface grades a stale artifact and passes.
describe('a test tsconfig typechecks its own sources, not its dist', () => {
  const withTestTsconfig = (): { dir: string; cfg: string }[] =>
    manifests()
      .map(({ dir }) => {
        try {
          return { dir, cfg: readFileSync(new URL(`${dir}/tsconfig.test.json`, packagesDir), 'utf8') };
        } catch {
          return undefined;
        }
      })
      .filter((v): v is { dir: string; cfg: string } => v !== undefined);

  it('there is at least one, so this check is not vacuous', () => {
    expect(withTestTsconfig().length).toBeGreaterThan(0);
  });

  it.each(withTestTsconfig().map(({ dir }) => dir))('%s aliases its own name to src', (dir) => {
    const { cfg } = withTestTsconfig().find((c) => c.dir === dir) as { cfg: string };
    const { name } = manifests().find((m) => m.dir === dir)?.pkg as { name: string };
    const parsed = JSON.parse(cfg) as { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(parsed.compilerOptions?.paths?.[name]).toEqual(['./src/index.ts']);
  });

  // The half that decides whether any of the above is alive. The configs and the scripts existed and
  // were asserted correct, while CI ran `npm ci`, `tsc -b` (src only) and vitest (which transpiles
  // without typechecking) — so a type error in any fixture in this repo passed CI in full, and the
  // gate this file calls "the one that would have caught a changed public surface" never ran.
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  it('reads a CI workflow that builds and tests, so the rows below grade something', () => {
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/npm test/);
  });

  // Keyed on the script that COMPILES the config, not on one blessed script name: the four packages
  // that have one do not agree on what to call it, and a hard-coded name would grade three of them
  // and silently excuse the fourth.
  const compilesItsTests = (pkg: Manifest): string[] =>
    Object.entries(pkg.scripts ?? {})
      .filter(([, cmd]) => cmd.includes('tsconfig.test.json'))
      .map(([name]) => name);

  it.each(withTestTsconfig().map(({ dir }) => dir))('CI runs %s’s test typecheck', (dir) => {
    const { pkg } = manifests().find((m) => m.dir === dir) as { pkg: Manifest };
    const scripts = compilesItsTests(pkg);
    expect(
      scripts,
      `packages/${dir} ships a tsconfig.test.json but no script compiles it`,
    ).not.toEqual([]);
    const invoked = scripts.some(
      (name) =>
        new RegExp(`npm run ${name}\\s+--workspaces`).test(ci) ||
        new RegExp(`npm run ${name}\\b[^\\n]*\\b${dir}\\b`).test(ci),
    );
    expect(
      invoked || ci.includes(`packages/${dir}/tsconfig.test.json`),
      `no CI step invokes packages/${dir}'s ${scripts.join('/')}, so its fixture is never compiled`,
    ).toBe(true);
  });
});
