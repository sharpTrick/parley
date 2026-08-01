import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Every test source in the repo must be inside some tsconfig, and something CI runs must compile it:
 * vitest transpiles with esbuild and never typechecks, so a fixture outside every project is graded
 * by no compiler at all and every `as unknown as XPrivate` cast in it silently stops meaning
 * anything. A `tsconfig.test.json` that resolves its own package through node_modules compounds it —
 * it then typechecks the BUILT dist/ rather than the sources vitest runs.
 *
 * Rows are derived from the packages that HAVE TEST SOURCES, never from the presence of the artifact
 * that satisfies the rule. Keyed the other way round — one row per `tsconfig.test.json` found — four
 * packages holding 23,572 lines of fixture were excused by construction, because a package that
 * simply never opted in was not a row.
 */
describe('every test source in the repo is inside a tsconfig some CI step compiles', () => {
  const isTestSource = (f: string): boolean =>
    f.endsWith('.test.ts') || (f.startsWith('test/') && f.endsWith('.ts'));

  const walk = (dir: string, base = dir, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, base, out);
      else out.push(relative(base, full).split('\\').join('/'));
    }
    return out;
  };

  const globToRegExp = (glob: string): RegExp => {
    const body = glob
      .split('/')
      .map((part) =>
        part === '**'
          ? '.*'
          : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
      )
      .join('/')
      .replace(/\/\.\*\//g, '/(?:.*/)?');
    return new RegExp(`^${body}$`);
  };

  interface Tested {
    dir: string;
    pkg: Manifest;
    files: string[];
    testSources: string[];
  }

  const testedPackages = (root: string): Tested[] =>
    readdirSync(root)
      .sort()
      .map((dir) => {
        const at = join(root, dir);
        if (!statSync(at).isDirectory()) return undefined;
        let pkg: Manifest;
        try {
          pkg = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')) as Manifest;
        } catch {
          return undefined;
        }
        const files = walk(at);
        return { dir, pkg, files, testSources: files.filter(isTestSource) };
      })
      .filter((p): p is Tested => p !== undefined && p.testSources.length > 0);

  /**
   * Configs of this package whose `include` covers every one of its test sources and whose `exclude`
   * puts none of them back out. Matched on the include patterns rather than on the FILENAME
   * `tsconfig.test.json`, so that a package naming its project anything else is graded the same.
   */
  const configsCoveringTests = (root: string, p: Tested): string[] =>
    p.files
      .filter((f) => /^tsconfig[\w.]*\.json$/.test(f))
      .filter((f) => {
        const { include, exclude } = JSON.parse(
          readFileSync(join(root, p.dir, f), 'utf8'),
        ) as { include?: string[]; exclude?: string[] };
        const covers = (include ?? []).map(globToRegExp);
        const omits = (exclude ?? []).map(globToRegExp);
        return p.testSources.every(
          (src) => covers.some((r) => r.test(src)) && !omits.some((r) => r.test(src)),
        );
      });

  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  /** Script names CI runs across every workspace — the only ones a package's script is reached by. */
  const CI_WORKSPACE_SCRIPTS = [...ci.matchAll(/npm run ([\w:-]+)\s+--workspaces/g)].map(
    (m) => m[1] as string,
  );

  /** Whether some script CI actually invokes compiles one of {@link configsCoveringTests}. */
  const compiledByCi = (root: string, p: Tested): boolean => {
    const covering = configsCoveringTests(root, p);
    return Object.entries(p.pkg.scripts ?? {}).some(
      ([name, body]) =>
        covering.some((cfg) => body.includes(cfg)) &&
        (CI_WORKSPACE_SCRIPTS.includes(name) ||
          new RegExp(`npm run ${name}\\b[^\\n]*\\b${p.dir}\\b`).test(ci)),
    );
  };

  const REPO = fileURLToPath(new URL('../../../', import.meta.url));

  /**
   * Every workspace root the repo declares, read from `workspaces` rather than named here: vitest's
   * `include` runs `examples/**` too, and scanning only `packages/` would rebuild the same hole one
   * directory across.
   */
  const AREAS = [
    ...new Set(
      (
        JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { workspaces?: string[] }
      ).workspaces?.map((w) => w.replace(/\/\*+$/, '')) ?? [],
    ),
  ];

  interface Row extends Tested {
    area: string;
    root: string;
  }

  const tested = (): Row[] =>
    AREAS.flatMap((area) =>
      testedPackages(join(REPO, area)).map((p) => ({ ...p, area, root: join(REPO, area) })),
    );

  const rowOf = (label: string): Row => tested().find((p) => `${p.area}/${p.dir}` === label) as Row;

  it('reads a CI workflow that builds, tests and runs workspace-wide scripts', () => {
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/npm test/);
    expect(CI_WORKSPACE_SCRIPTS.length).toBeGreaterThan(0);
  });

  it('finds every workspace area and its test sources, so the rows below are not an empty table', () => {
    expect(AREAS.length).toBeGreaterThan(1);
    expect(tested().length).toBeGreaterThan(8);
    expect(tested().flatMap((p) => p.testSources).length).toBeGreaterThan(50);
    for (const area of AREAS) expect(tested().map((p) => p.area)).toContain(area);
  });

  it.each(tested().map((p) => `${p.area}/${p.dir}`))(
    '%s: a tsconfig includes its test sources',
    (label) => {
      const p = rowOf(label);
      expect(
        configsCoveringTests(p.root, p),
        `${label} holds ${p.testSources.length} test sources that no tsconfig includes, so no ` +
          'compiler ever sees them',
      ).not.toEqual([]);
    },
  );

  it.each(tested().map((p) => `${p.area}/${p.dir}`))(
    '%s: a script CI invokes compiles that tsconfig',
    (label) => {
      const p = rowOf(label);
      expect(
        compiledByCi(p.root, p),
        `no CI step compiles ${label}'s test sources — declare one of ` +
          `${CI_WORKSPACE_SCRIPTS.join(' / ')} running ${configsCoveringTests(p.root, p).join(' / ')}`,
      ).toBe(true);
    },
  );

  /**
   * A config that typechecks a package's own tests must resolve that package to `src`, or it grades
   * the built dist/ while vitest grades the sources and the gate passes against a stale artifact.
   * Rows are the packages that HAVE an entry point to resolve, so an example app with no `src/` is
   * out of scope by what it is rather than by being named here.
   */
  it.each(
    tested()
      .filter((p) => p.files.includes('src/index.ts'))
      .flatMap((p) =>
        configsCoveringTests(p.root, p).map(
          (cfg) => [`${p.area}/${p.dir}`, cfg] as [string, string],
        ),
      ),
  )('%s/%s aliases its own name to src', (label, cfg) => {
    const p = rowOf(label);
    const parsed = JSON.parse(readFileSync(join(p.root, p.dir, cfg), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    expect(parsed.compilerOptions?.paths?.[p.pkg.name as string]).toEqual(['./src/index.ts']);
  });

  /**
   * The negative control on the derivation itself. A guard enumerated by the artifact that satisfies
   * it cannot fail for a package that never opts in, and nothing about a green run distinguishes the
   * two — so the checker is run against a package built to be uncovered, and must report it.
   */
  describe('a package that does not opt in is still a row', () => {
    const plant = (files: Record<string, string>): string => {
      const root = mkdtempSync(join(tmpdir(), 'repo-contract-'));
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      return root;
    };

    const MANIFEST = JSON.stringify({ name: '@x/opt-out', scripts: { build: 'tsc -b' } });
    const SRC_ONLY = JSON.stringify({ include: ['src/**/*'] });

    it('reports a package whose tests no tsconfig includes', () => {
      const root = plant({
        'opt-out/package.json': MANIFEST,
        'opt-out/tsconfig.json': SRC_ONLY,
        'opt-out/test/thing.test.ts': 'export const x = 1;\n',
      });
      const [p] = testedPackages(root);
      expect(p?.dir).toBe('opt-out');
      expect(configsCoveringTests(root, p as Tested)).toEqual([]);
    });

    it('reports a package whose covering tsconfig no CI script compiles', () => {
      const root = plant({
        'opt-out/package.json': MANIFEST,
        'opt-out/tsconfig.json': SRC_ONLY,
        'opt-out/tsconfig.checks.json': JSON.stringify({ include: ['src/**/*', 'test/**/*'] }),
        'opt-out/test/thing.test.ts': 'export const x = 1;\n',
      });
      const [p] = testedPackages(root);
      expect(configsCoveringTests(root, p as Tested)).toEqual(['tsconfig.checks.json']);
      expect(compiledByCi(root, p as Tested)).toBe(false);
    });

    // The config is named anything but `tsconfig.test.json`, so a checker matching that literal
    // would report this package as uncovered when it is in fact fine.
    it('accepts a covering tsconfig whose name is not tsconfig.test.json', () => {
      const script = CI_WORKSPACE_SCRIPTS[0] as string;
      const root = plant({
        'opt-in/package.json': JSON.stringify({
          name: '@x/opt-in',
          scripts: { [script]: 'tsc -p tsconfig.checks.json' },
        }),
        'opt-in/tsconfig.checks.json': JSON.stringify({ include: ['src/**/*', 'test/**/*'] }),
        'opt-in/test/thing.test.ts': 'export const x = 1;\n',
      });
      const [p] = testedPackages(root);
      expect(configsCoveringTests(root, p as Tested)).toEqual(['tsconfig.checks.json']);
      expect(compiledByCi(root, p as Tested)).toBe(true);
    });
  });
});
