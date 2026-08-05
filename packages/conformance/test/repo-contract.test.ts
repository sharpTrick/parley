import { spawnSync } from 'node:child_process';
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
