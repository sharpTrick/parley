import { execFile, spawnSync } from 'node:child_process';
import {
  existsSync,
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
import { promisify } from 'node:util';
import {
  derivedRows,
  filesUnder,
  starReexports,
  workspaceAreas,
  workspacePackages,
  workspaceRoot,
} from '@sharptrick/parley-net-util/testing';
import { beforeAll, describe, expect, it } from 'vitest';

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
  peerDependencies?: Record<string, string>;
}

/**
 * Derived through the shared walker rather than a `readdirSync` of `packages/` wrapped in a
 * `try/catch`: that catch silently dropped any package whose manifest would not parse — the exact
 * hole the AREAS derivation further down was written to document.
 */
function manifests(): { dir: string; pkg: Manifest }[] {
  return workspacePackages(workspaceRoot())
    .filter((p) => p.relative.startsWith('packages/'))
    .map((p) => ({ dir: p.folder, pkg: p.manifest as unknown as Manifest }));
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
 * CLASS: a package.json field that must agree across the thirteen workspaces one merge publishes in
 * lockstep. The discovery-metadata rule above grades four such fields and stops, and the drifts
 * outside it were filed in three consecutive review rounds without ever being graded: `engines.node`
 * asserted only inside the one package that had raised its own floor, `exports["./package.json"]`
 * declared by three of thirteen, and one package carrying a `test` script no sibling and no CI step
 * had. The rows are (field x package) so that a fourth field is a row rather than a new file, and
 * each comparator is exercised against synthetic input in both directions, because a comparator that
 * has gone vacuous reads exactly like a repo that agrees with itself.
 */
describe('the fields that must agree across the lockstep-published workspaces', () => {
  const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));
  const rootManifest = JSON.parse(
    readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'),
  ) as Manifest & { engines?: { node?: string } };

  const FLOOR = /^>=\s*(\d+\.\d+\.\d+)$/;
  const rank = (v: string): number =>
    v.split('.').reduce((acc, part) => acc * 1_000_000 + Number(part), 0);

  /**
   * Node versions that introduced a builtin this repo reaches for — a fact about Node, keyed by the
   * MODULE rather than by the package, so that a second package importing one inherits the floor
   * instead of needing a line here. bridge-sqlite's `>=22.5.0` is `node:sqlite`; the live risk is the
   * mirror case, a package adopting a post-floor builtin and installing cleanly on a Node that
   * throws at require time.
   */
  const BUILTIN_FLOOR: Record<string, string> = { 'node:sqlite': '22.5.0' };

  const requiredFloor = (sources: string[], base: string): string =>
    Object.entries(BUILTIN_FLOOR)
      .filter(([mod]) => sources.some((src) => src.includes(`'${mod}'`) || src.includes(`"${mod}"`)))
      .map(([, floor]) => floor)
      .reduce((hi, floor) => (rank(floor) > rank(hi) ? floor : hi), base);

  const shippedSources = (dir: string): string[] => {
    const walk = (at: string): string[] => {
      try {
        return readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(at, entry.name))
            : /\.(test|spec)\./.test(entry.name)
              ? []
              : [readFileSync(join(at, entry.name), 'utf8')],
        );
      } catch {
        return [];
      }
    };
    return walk(join(ROOT_DIR, 'packages', dir, 'src'));
  };

  /** Script names most of the family declares — the shape a sibling is expected to match. */
  const commonNames = (declared: string[][]): string[] => {
    const counts = new Map<string, number>();
    for (const names of declared) for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    return [...counts]
      .filter(([, count]) => count > declared.length / 2)
      .map(([name]) => name)
      .sort();
  };

  const commonScripts = (): string[] =>
    commonNames(published().map(({ pkg }) => Object.keys(pkg.scripts ?? {})));

  it('has a root floor and a family to compare against, so the rows below are not vacuous', () => {
    expect(FLOOR.exec(rootManifest.engines?.node ?? '')?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(published().length).toBeGreaterThan(10);
    expect(commonScripts().length).toBeGreaterThan(2);
    expect(commonScripts()).toContain('build');
  });

  it.each(published().map(({ dir }) => dir))(
    '%s declares exactly the Node floor its own sources require',
    (dir) => {
      const { pkg } = published().find((p) => p.dir === dir) as {
        pkg: Manifest & { engines?: { node?: string } };
      };
      const declared = FLOOR.exec(pkg.engines?.node ?? '')?.[1];
      expect(declared, `engines.node must be a plain ">=x.y.z" floor, not ${String(pkg.engines?.node)}`).toBeDefined();
      expect(
        declared,
        'a floor above the family installs EBADENGINE for consumers on a Node that runs this fine; ' +
          'a floor below the builtins it imports installs cleanly and throws at require time',
      ).toBe(
        requiredFloor(shippedSources(dir), FLOOR.exec(rootManifest.engines?.node ?? '')?.[1] as string),
      );
    },
  );

  it.each(published().map(({ dir }) => dir))(
    '%s exports its own package.json and types every entry it declares',
    (dir) => {
      const { pkg } = published().find((p) => p.dir === dir) as {
        pkg: Manifest & { exports?: Record<string, unknown> };
      };
      expect(
        pkg.exports?.['./package.json'],
        'a consumer or a tool reading the manifest through the package name gets ERR_PACKAGE_PATH_NOT_EXPORTED without it',
      ).toBe('./package.json');
      for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
        if (typeof conditions === 'string') continue;
        expect(
          Object.keys(conditions as Record<string, unknown>),
          `${subpath} must offer "types" before "default" — conditions resolve in declaration order`,
        ).toEqual(['types', 'default']);
      }
    },
  );

  it.each(published().map(({ dir }) => dir))(
    '%s declares the scripts its siblings declare, and no others',
    (dir) => {
      const { pkg } = published().find((p) => p.dir === dir) as { pkg: Manifest };
      expect(
        Object.keys(pkg.scripts ?? {}).sort(),
        'a script no sibling has is reached by no CI step and no root script; one a sibling has and ' +
          'this package lacks is a `--workspaces --if-present` step silently skipping it',
      ).toEqual(commonScripts());
    },
  );

  it('sees a floor left behind, a floor raised for nothing, and an odd script (positive control)', () => {
    expect(requiredFloor(["const m = require('node:sqlite');"], '22.0.0')).toBe('22.5.0');
    expect(requiredFloor(['import { DatabaseSync } from "node:sqlite";'], '22.0.0')).toBe('22.5.0');
    expect(requiredFloor(["import { readFile } from 'node:fs';"], '22.0.0')).toBe('22.0.0');
    expect(requiredFloor([], '22.0.0')).toBe('22.0.0');
    expect(requiredFloor([], '22.5.0')).toBe('22.5.0');
    expect(rank('22.5.0')).toBeGreaterThan(rank('22.0.0'));
    expect(rank('22.0.0')).toBeGreaterThan(rank('9.99.99'));
    expect(commonNames([['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'c']])).toEqual(['a', 'b']);
    expect(commonNames([['a'], ['a'], ['a']])).toEqual(['a']);
    expect(commonNames([[], [], []])).toEqual([]);
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
/**
 * The authoritative half of two per-package copies that spawned `tsc -b` to re-run a gate ci.yml
 * already runs for every workspace. What the copies uniquely carried is this: `tsc --showConfig`
 * answers with the files the project ACTUALLY includes, where the rule below emulates tsc's
 * include/exclude with globs of its own. Two of thirteen packages paid 2.9s for it; all thirteen
 * now get it, in one round of concurrent `--showConfig` calls.
 */
describe('every tsconfig.test.json really includes its package’s sources', () => {
  const PROJECTS = derivedRows(
    'every package declaring a test project',
    () =>
      workspacePackages(workspaceRoot())
        .filter((p) => existsSync(join(p.dir, 'tsconfig.test.json')))
        .map((p) => [p.relative, p.dir] as const),
    { floor: 10, witness: ['packages/bridge-core', 'packages/conformance'] },
  );

  const included = new Map<string, Set<string>>();

  beforeAll(async () => {
    const shown = await Promise.all(
      PROJECTS.map(async ([relativeDir, dir]) => {
        const { stdout } = await promisify(execFile)(
          'npx',
          ['tsc', '--showConfig', '-p', join(dir, 'tsconfig.test.json')],
          { cwd: workspaceRoot(), maxBuffer: 32 * 1024 * 1024 },
        );
        const { files = [] } = JSON.parse(stdout) as { files?: string[] };
        return [relativeDir, new Set(files.map((f) => relative(dir, join(dir, f))))] as const;
      }),
    );
    for (const [name, files] of shown) included.set(name, files);
  }, 300_000);

  it.each(PROJECTS)('%s leaves no .ts file outside every project', (relativeDir, dir) => {
    const present = ['src', 'test']
      .flatMap((area) => filesUnder(join(dir, area), ['.ts']))
      .map((f) => relative(dir, f));
    expect(present.length, 'no sources found to grade').toBeGreaterThan(0);
    const checked = included.get(relativeDir) as Set<string>;
    expect(present.filter((f) => !checked.has(f))).toEqual([]);
  });
});

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
  const AREAS = workspaceAreas(REPO);

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

const WORKFLOWS = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));

/** A workflow's `on:` block, without the top-level keys that follow it. */
function triggersOf(workflow: string): string {
  const at = workflow.search(/^on:/m);
  if (at < 0) return '';
  const rest = workflow.slice(at + 'on:'.length);
  const end = rest.search(/^[a-z]/m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** A workflow's jobs as `[name, body]`, split on the keys one level under `jobs:`. */
function jobsOf(workflow: string): [string, string][] {
  const at = workflow.search(/^jobs:/m);
  if (at < 0) return [];
  const body = workflow.slice(at);
  const heads = [...body.matchAll(/^ {2}([\w-]+):$/gm)];
  return heads.map((m, i) => [
    m[1] as string,
    body.slice(m.index, i + 1 < heads.length ? (heads[i + 1] as RegExpMatchArray).index : body.length),
  ]);
}

/**
 * What a job runs, as its single-line `run:` commands AND its step names — both, so that a step
 * whose command is a block scalar (the no-skip assertion is one) is still something to compare.
 */
const stepsOf = (job: string): string[] => [
  ...[...job.matchAll(/^[ \t]*-?[ \t]*run:[ \t]*(?!\|)(\S.*)$/gm)].map((m) => (m[1] as string).trim()),
  ...[...job.matchAll(/^[ \t]*-[ \t]*name:[ \t]*(\S.*)$/gm)].map((m) => (m[1] as string).trim()),
];

/** The gate a workflow applies: the steps of whichever job runs the suite. */
function testGateOf(workflow: string): string[] {
  const job = jobsOf(workflow).find(([, body]) => /^[ \t]*-?[ \t]*run:[ \t]*npm test\b/m.test(body));
  return job === undefined ? [] : stepsOf(job[1]);
}

/** Read off the steps a job RUNS, so that a workflow merely naming the release is not one. */
const publishes = (workflow: string): boolean =>
  jobsOf(workflow).some(([, body]) =>
    stepsOf(body).some((step) => /semantic-release|npm publish\b|publish-workspaces/.test(step)),
  );

/** Fires without a human asking — as opposed to a `workflow_dispatch`-only escape hatch. */
const firesAutomatically = (workflow: string): boolean =>
  /^ {2}(?:push|schedule|release):/m.test(triggersOf(workflow));

const missingFrom = (reference: string, candidate: string): string[] =>
  testGateOf(reference).filter((step) => !testGateOf(candidate).includes(step));

/**
 * A workflow that publishes on its own trigger must run every step the pull-request gate runs.
 * release.yml claimed in a comment to mirror ci.yml and did not: it omitted both typecheck steps,
 * so the ~23k lines of test source no compiler sees during `npm test` were graded on the PR and by
 * nothing on the path that actually publishes — and main is reached by a squash-merge commit ci.yml
 * never ran against. Nothing in the suite read release.yml, so the divergence was invisible.
 *
 * Derived from the workflows themselves rather than from a list here: which workflow is the gate,
 * which ones publish, and what either runs are all read off disk, so a fourth workflow is a row the
 * day it lands and neither file's current wording is what is asserted.
 */
describe('no workflow publishes on a gate weaker than the pull-request gate', () => {
  const files = (): string[] => readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
  const read = (file: string): string => readFileSync(join(WORKFLOWS, file), 'utf8');

  const gates = (): string[] =>
    files().filter((f) => /^ {2}pull_request:?/m.test(triggersOf(read(f))) && testGateOf(read(f)).length > 0);
  const autoPublishers = (): string[] =>
    files().filter((f) => publishes(read(f)) && firesAutomatically(read(f)));

  it('finds one pull-request gate and a workflow that publishes unasked, so the rows below grade something', () => {
    expect(files().length).toBeGreaterThan(2);
    expect(gates()).toHaveLength(1);
    const gate = testGateOf(read(gates()[0] as string));
    expect(gate.length).toBeGreaterThan(4);
    expect(gate.some((s) => s.startsWith('npm test'))).toBe(true);
    expect(autoPublishers().length).toBeGreaterThan(0);
  });

  it.each(autoPublishers().map((f) => [f]))('%s runs every step the pull-request gate runs', (file) => {
    expect(
      missingFrom(read(gates()[0] as string), read(file)),
      `${file} publishes without these steps the pull-request gate runs`,
    ).toEqual([]);
  });

  const GATE = [
    '    steps:',
    '      - run: npm ci',
    '      - run: npm run typecheck --workspaces --if-present',
    '      - name: Assert no test file skipped entirely',
    '        run: |',
    '          node -e "1"',
    '      - run: npm test -- --reporter=default',
  ];
  const plantWorkflow = (on: string[], steps: string[]): string =>
    ['on:', ...on, 'jobs:', '  a-job:', ...steps].join('\n');

  const reference = plantWorkflow(['  pull_request:'], GATE);
  const weakened = GATE.filter((s) => !s.includes('typecheck'));
  const onPush = ['  push:', '    branches: [main]'];

  it.each([
    ['a publisher running every step of it', plantWorkflow(onPush, [...GATE, '      - run: npx semantic-release']), []],
    [
      'a publisher missing one',
      plantWorkflow(onPush, [...weakened, '      - run: npx semantic-release']),
      ['npm run typecheck --workspaces --if-present'],
    ],
    [
      'a publisher with no gate job at all',
      plantWorkflow(onPush, ['    steps:', '      - run: npx semantic-release']),
      testGateOf(reference),
    ],
  ])('reports what %s omits', (_label, candidate, missing) => {
    expect(missingFrom(reference, candidate)).toEqual(missing);
  });

  // The classification is what selects the rows above, so it is graded rather than assumed: a
  // dispatch-only escape hatch publishes deliberately and is exempt; the gate itself is not a
  // publisher and must not be asked to be a superset of itself.
  it('separates an unasked publisher from the manual escape hatch and from the gate', () => {
    const manual = plantWorkflow(['  workflow_dispatch:'], [...weakened, '      - run: npx semantic-release']);
    expect(publishes(manual)).toBe(true);
    expect(firesAutomatically(manual)).toBe(false);
    expect(publishes(reference)).toBe(false);
    expect(firesAutomatically(plantWorkflow(onPush, GATE))).toBe(true);
    // A workflow that only NAMES the release in a comment does not publish.
    expect(publishes(`# semantic-release picks the bump\n${reference}`)).toBe(false);
  });
});

/**
 * CLASS: a root document describing the gate as something other than what the gate is. CONTRIBUTING
 * told every new-backend author to have the conformance factory "skip cleanly when no server is
 * reachable" and told everyone that `npm test` alone is the pre-PR check — while the workflow that
 * decides the PR runs two typecheck steps, brings six services up, and fails any `describe` group
 * in which nothing ran. A contributor who followed the doc got a red build for a reason the doc
 * said could not happen, and the natural response to that is to weaken the gate.
 *
 * The rows are the repo's OWN scripts the pull-request workflow invokes — npm scripts by name and
 * checked-in script files by path — read off that workflow rather than listed here, so a step added
 * to CI becomes a row the day it lands and no wording in either file is what is asserted. `npm ci`
 * and `docker compose` are not rows: they are not this repo's scripts, and a contributor cannot be
 * told to run something the repo does not carry.
 */
describe("CONTRIBUTING names every one of the repo's scripts the PR gate runs", () => {
  const CONTRIBUTING = readFileSync(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8');

  /** npm scripts a step invokes by name, plus checked-in executables it invokes by path. */
  function repoScriptsIn(steps: string[]): string[] {
    const found = new Set<string>();
    for (const step of steps) {
      for (const m of step.matchAll(/npm run ([\w:-]+)/g)) found.add(`npm run ${m[1] as string}`);
      if (/^npm test\b/.test(step)) found.add('npm test');
      for (const m of step.matchAll(/\.?\/?((?:scripts|examples)\/[\w./-]+\.(?:mjs|js|sh))/g)) {
        found.add(m[1] as string);
      }
    }
    return [...found].sort();
  }

  const prGate = (): string[] => {
    const file = readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f))
      .find((f) => /^ {2}pull_request:?/m.test(triggersOf(readFileSync(join(WORKFLOWS, f), 'utf8'))));
    if (file === undefined) return [];
    const workflow = readFileSync(join(WORKFLOWS, file), 'utf8');
    return jobsOf(workflow).flatMap(([, body]) => stepsOf(body));
  };

  const SCRIPTS = repoScriptsIn(prGate());

  it('finds the pull-request workflow and the scripts it runs, so the rows are not an empty table', () => {
    expect(SCRIPTS.length, 'no repo script found in the pull-request workflow at all').toBeGreaterThan(4);
    expect(CONTRIBUTING.length).toBeGreaterThan(1000);
  });

  /**
   * Named, not merely contained: `npm run typecheck:test` is a substring of a doc that only ever
   * says `npm run typecheck:tests`, and a plain `includes` reads that typo as coverage.
   */
  const names = (doc: string, script: string): boolean =>
    new RegExp(`${script.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?![\\w:.-])`).test(doc);

  it.each(SCRIPTS.map((script) => [script]))(
    '%s',
    (script) => {
      expect(
        names(CONTRIBUTING, script),
        `CI runs \`${script}\` to decide a PR and CONTRIBUTING never names it — a contributor ` +
          `following the doc cannot reproduce the gate that will judge them`,
      ).toBe(true);
    },
  );

  // Both directions on a SYNTHETIC workflow and a synthetic doc, because the repo's own files are
  // what a scan like this silently comes to depend on.
  const planted = stepsOf(
    [
      '    steps:',
      '      - run: npm ci',
      '      - run: npm run build',
      '      - run: npm run typecheck:test --workspaces --if-present',
      '      - name: Assert nothing skipped',
      '        run: node scripts/assert-no-skipped-tests.mjs /tmp/vitest.json',
      '      - run: ./examples/dev-compose/dev-infra.sh up all',
      '      - run: npm test -- --reporter=json',
      '      - run: docker compose -f examples/dev-compose/docker-compose.yml logs',
    ].join('\n'),
  );

  it('reads exactly the repo scripts out of a planted workflow, and nothing else', () => {
    expect(repoScriptsIn(planted)).toEqual([
      'examples/dev-compose/dev-infra.sh',
      'npm run build',
      'npm run typecheck:test',
      'npm test',
      'scripts/assert-no-skipped-tests.mjs',
    ]);
  });

  it.each([
    ['a doc naming every one of them', repoScriptsIn(planted).join('\n'), []],
    [
      'a doc that stops at `npm test`',
      'Run `npm run build` and `npm test` before opening a PR.',
      ['examples/dev-compose/dev-infra.sh', 'npm run typecheck:test', 'scripts/assert-no-skipped-tests.mjs'],
    ],
    ['a doc naming none of them', 'Be excellent to each other.', repoScriptsIn(planted)],
    [
      'a doc whose spelling of a script merely CONTAINS it',
      'Run `npm run build`, `npm run typecheck:tests`, `npm test`, ' +
        '`./examples/dev-compose/dev-infra.shell` and `node scripts/assert-no-skipped-tests.mjs`.',
      ['examples/dev-compose/dev-infra.sh', 'npm run typecheck:test'],
    ],
  ])('reports what %s omits', (_label, doc, missing) => {
    expect(repoScriptsIn(planted).filter((script) => !names(doc, script))).toEqual(missing);
  });
});

/**
 * The gate that stops a self-skipping suite from reading as a passing one — graded by RUNNING it,
 * not by reading the workflow that calls it.
 *
 * It used to be a `node -e` script pasted into both workflows, and it failed only a test file whose
 * EVERY assertion skipped. Fourteen files across seven packages mix a server-gated block with
 * ungated ones, so the gated half could vanish — `bridge-xmpp`'s MAM paging is that backend's whole
 * catch-up mechanism — while the file still reported passes and the gate printed "0 of N skipped".
 *
 * Rows below are the shapes that distinction turns on, run through the shipped script over planted
 * reports, so neither the rule nor the exit code can drift from what CI executes.
 */
describe('the skip gate CI runs', () => {
  const REPO_DIR = fileURLToPath(new URL('../../../', import.meta.url));

  /** Every `node scripts/*.mjs` step of a workflow's test-gate job — the shape this gate is run as. */
  const scriptSteps = (workflow: string): string[] =>
    testGateOf(workflow).filter((step) => /^node\s+scripts\/\S+\.mjs\b/.test(step));

  const workflowFiles = (): string[] =>
    readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();

  const gating = (): string[] =>
    workflowFiles().filter(
      (f) => testGateOf(readFileSync(join(WORKFLOWS, f), 'utf8')).length > 0,
    );

  const gateSteps = (): string[] =>
    gating().flatMap((f) => scriptSteps(readFileSync(join(WORKFLOWS, f), 'utf8')));

  it('is one script, spelled the same way by every workflow that gates on the suite', () => {
    expect(gating().length).toBeGreaterThan(1);
    expect(gateSteps().length).toBe(gating().length);
    expect(new Set(gateSteps()).size, 'two workflows run different gates').toBe(1);
  });

  /** The script the workflows name, so the rows below cannot grade a different implementation. */
  const GATE_SCRIPT = ((): string => {
    const named = /^node\s+(scripts\/\S+\.mjs)\b/.exec(gateSteps()[0] ?? '')?.[1] ?? '';
    return join(REPO_DIR, named);
  })();

  it('names a script that exists', () => {
    expect(GATE_SCRIPT).toMatch(/\.mjs$/);
    expect(statSync(GATE_SCRIPT).isFile()).toBe(true);
  });

  const CASE = (title: string, status: string, ancestorTitles: string[] = []) => ({
    title,
    fullName: [...ancestorTitles, title].join(' '),
    ancestorTitles,
    status,
  });

  const runGate = (report: unknown): { code: number; err: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-gate-'));
    const path = join(dir, 'report.json');
    writeFileSync(path, JSON.stringify(report));
    const run = spawnSync(process.execPath, [GATE_SCRIPT, path], { encoding: 'utf8' });
    return { code: run.status ?? -1, err: `${run.stderr}${run.stdout}` };
  };

  const file = (name: string, assertions: unknown[]): unknown => ({
    name,
    assertionResults: assertions,
  });

  const GATED = 'reads the most-recent window off a real MAM archive';

  it.each([
    [
      'a file whose gated describe vanished beside two ungated ones',
      [
        file('mam-paging.test.ts', [
          CASE('pages forward', 'passed', ['MAM paging returns each message once']),
          CASE('settles', 'passed', ['MAM paging settles instead of spinning']),
          CASE('reads the window', 'skipped', [GATED]),
          CASE('reads it again', 'skipped', [GATED]),
        ]),
      ],
      true,
    ],
    [
      'a file whose every assertion skipped',
      [file('conformance.test.ts', [CASE('a', 'skipped'), CASE('b', 'skipped')])],
      true,
    ],
    [
      'an inner describe that vanished inside a running outer one',
      [
        file('driver.test.ts', [
          CASE('a', 'passed', ['what an open leaves behind']),
          CASE('b', 'skipped', ['what an open leaves behind', 'with better-sqlite3']),
        ]),
      ],
      true,
    ],
    [
      'a status this gate has never met',
      [file('thing.test.ts', [CASE('a', 'passed'), CASE('b', 'todo', ['a group'])])],
      true,
    ],
    // The half that must NOT fire: the conformance suite skips its concurrency cases for a backend
    // whose context declares one writer. That is a capability stated in the repo, beside siblings
    // that ran — not a dependency that failed to come up.
    [
      'cases the plugin declared unsupported, beside running siblings',
      [
        file('conformance.test.ts', [
          CASE('post round-trips', 'passed', ['seam conformance: telegram']),
          CASE('concurrent writers', 'skipped', ['seam conformance: telegram']),
          CASE('multi-process writes', 'skipped', ['seam conformance: telegram']),
        ]),
      ],
      false,
    ],
    ['a run in which everything ran', [file('a.test.ts', [CASE('a', 'passed')])], false],
    ['a run in which something failed', [file('a.test.ts', [CASE('a', 'failed')])], false],
  ])('refuses %s: %s', (_label, testResults, refused) => {
    const { code } = runGate({ testResults });
    expect(code).toBe(refused ? 1 : 0);
  });

  it('names the group it refuses, so the operator knows which server did not come up', () => {
    const { err } = runGate({
      testResults: [
        file('mam-paging.test.ts', [
          CASE('pages forward', 'passed', ['ungated']),
          CASE('reads the window', 'skipped', [GATED]),
        ]),
      ],
    });
    expect(err).toContain(GATED);
    expect(err).toContain('mam-paging.test.ts');
    expect(err).not.toContain('ungated');
  });

  // A gate handed nothing has nothing to disagree with, and every report shape above would pass it.
  it('refuses a report with no test files at all', () => {
    expect(runGate({ testResults: [] }).code).toBe(1);
    expect(runGate({}).code).toBe(1);
  });
});


/**
 * CLASS: a module-resolution table whose entries do not all match the way they are read. Vitest
 * resolves `@sharptrick/parley-*` to each package's TypeScript SOURCE so no test grades a stale
 * `dist/`, and a vite STRING alias matches by PREFIX — so an entry left as a string silently
 * rewrites `<specifier>/anything` under the source path of the specifier itself. Only the bare
 * package name had become an anchored RegExp; every SUBPATH was still a string, and the escape it
 * used (`.replace('/', '\\/')`) replaced the first `/` only.
 *
 * Graded by DRIVING the config's own builder over vite's matching rule, not by reading the file:
 * a text check cannot tell an anchored pattern from one that merely looks like one.
 */
describe('every workspace alias matches its specifier and nothing under it', () => {
  const loadAliases = async (): Promise<{ find: string | RegExp; replacement: string }[]> => {
    const mod = (await import(
      new URL('../../../vitest.config.ts', import.meta.url).href
    )) as unknown as { packageAliases: () => { find: string | RegExp; replacement: string }[] };
    return mod.packageAliases();
  };

  /** Vite's own rule: a string alias is a PREFIX, a RegExp is a test. */
  const matches = (find: string | RegExp, id: string): boolean =>
    typeof find === 'string' ? id.startsWith(find) : find.test(id);

  /** Every specifier the workspace publishes, from the same manifests the config reads. */
  const specifiers = (): string[] =>
    manifests().flatMap(({ pkg }) => {
      const exports = (pkg as { exports?: Record<string, unknown> }).exports ?? {};
      return Object.keys(exports)
        .filter((sub) => sub !== './package.json')
        .map((sub) => (sub === '.' ? (pkg.name as string) : `${pkg.name}${sub.slice(1)}`));
    });

  it('finds specifiers and aliases, so the rows below are not reading empty sets', async () => {
    expect(specifiers().length).toBeGreaterThan(5);
    expect(specifiers()).toContain('@sharptrick/parley-core/testing');
    expect(await loadAliases()).toHaveLength(specifiers().length);
  });

  it('resolves each specifier through exactly one alias', async () => {
    const aliases = await loadAliases();
    const wrong = specifiers()
      .map((id) => [id, aliases.filter((a) => matches(a.find, id)).length] as const)
      .filter(([, n]) => n !== 1);
    expect(wrong, 'a specifier no alias resolves, or one that two resolve').toEqual([]);
  });

  it('resolves nothing UNDER a specifier through that specifier’s alias', async () => {
    const aliases = await loadAliases();
    const leaked = specifiers()
      .flatMap((id) => [`${id}/anything`, `${id}-other`, `${id}.js`])
      .filter((id) => aliases.some((a) => matches(a.find, id)));
    expect(
      leaked,
      'an alias matched a path UNDER its specifier. A vite string alias is a prefix, so the id is ' +
        "rewritten to the specifier's own source file with the rest appended — a resolution " +
        'failure whose message names neither the alias nor the file',
    ).toEqual([]);
  });
});

/**
 * CLASS: a published surface nothing can enumerate. `export * from './x.js'` republishes whatever
 * that module happens to export, so every guard built on reading the barrel — the README rule, the
 * dead-export rule, the semver surface count — reads a name that is not there and misses one that
 * is. A type-only name republished that way is invisible to a runtime key enumeration too, and
 * ships as a `.d.ts` compatibility obligation nobody documented or noticed.
 *
 * One package had this rule over its own sources. It belongs to every published entry point,
 * derived from the `exports` map so a second subpath is covered the day the manifest declares it.
 */
describe('no published entry point re-exports wholesale', () => {
  /** Each entry the manifest publishes, as the SOURCE the build compiles it from. */
  const entryPoints = (): { specifier: string; path: string }[] =>
    published().flatMap(({ dir, pkg }) =>
      Object.entries((pkg as { exports?: Record<string, unknown> }).exports ?? {})
        .filter(([sub]) => sub !== './package.json')
        .map(([sub, target]) => {
          const built = typeof target === 'object' && target !== null
            ? ((target as Record<string, string>).default ?? '')
            : String(target);
          return {
            specifier: sub === '.' ? (pkg.name as string) : `${pkg.name as string}${sub.slice(1)}`,
            path: join(packagesDir.pathname, dir, built.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')),
          };
        }),
    );

  const rows = derivedRows(
    'every published entry point',
    () => entryPoints().map((e) => [e.specifier, e.path] as const),
    { floor: 13, witness: ['@sharptrick/parley-core', '@sharptrick/parley-net-util/testing'] },
  );

  it('resolves every entry point to a source file that exists', () => {
    expect(rows.filter(([, path]) => !existsSync(path))).toEqual([]);
  });

  it.each(rows)('%s enumerates what it publishes', (_specifier, path) => {
    expect(
      starReexports(readFileSync(path, 'utf8')),
      'a wholesale re-export from a published entry point; name what it publishes instead, so the ' +
        'surface stays countable',
    ).toEqual([]);
  });
});
