import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codeOf,
  derivedRows,
  filesUnder,
  withoutComments,
  workspacePackages,
} from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';
import { defaultReadStatePath } from './engine/read-state.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = ['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml'];

const sourceFiles = (dir: string): string[] => filesUnder(dir, SOURCE);

/**
 * A SECOND count of a universe, taken a different way: what git has under these prefixes. A floor
 * only ever proves a table is non-empty — the walks below carry floors of 50, 100 and 200 against
 * real universes of 324, 568 and 547, so most of each could evaporate on its shipped floor with its
 * shipped witnesses intact. The walk is a superset of what git tracks (an untracked file is walked
 * and not counted), so a table that reads FEWER rows than this has stopped reaching tracked ground.
 */
const trackedFiles = (
  areas: ReadonlyArray<readonly [prefix: string, extensions: readonly string[]]>,
): number =>
  execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => areas.some(([prefix, exts]) => file.startsWith(prefix) && exts.some((e) => file.endsWith(e))))
    .filter((file) => !file.endsWith('source-hygiene.test.ts'))
    .length;

/**
 * A raw control byte in a source file makes it `data` to file(1) and makes ripgrep refuse to print
 * its matches, so the file silently disappears from every grep-based search and review pass.
 *
 * This has now happened twice in bridge-matrix, both times as a NUL-prefixed cache-key sentinel
 * written as a literal instead of an escape — the second time in a new location, by an agent
 * remediating a round that had already fixed the first. A comment on the original line did not
 * generalise; this does.
 */
describe('source hygiene', () => {
  const files = sourceFiles(join(REPO, 'packages')).concat(sourceFiles(join(REPO, 'examples')));

  it('finds source files to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each([
    ['NUL', 0x00],
    ['SOH', 0x01],
    ['BEL', 0x07],
    ['BS', 0x08],
    ['VT', 0x0b],
    ['FF', 0x0c],
    ['SUB', 0x1a],
    ['ESC', 0x1b],
  ])('no source file contains a raw %s byte', (name, byte) => {
    const offenders = files
      .filter((f) => readFileSync(f).includes(byte))
      .map((f) => f.slice(REPO.length));
    expect(
      offenders,
      `${name} (0x${byte.toString(16).padStart(2, '0')}) must be written as an escape, not a raw byte`,
    ).toEqual([]);
  });

  /**
   * The UNIVERSE the byte rule runs over, which is the half of a scan like this that decays in
   * silence: a flat `readdirSync(src)` keeps passing the day a package grows a subdirectory, and a
   * `files.length > 0` guard cannot tell that from a full walk. Both halves are derived — the
   * package set from `workspaces`, the depth from the tree — so neither can be satisfied by the
   * layout happening to be flat today.
   */
  it('reaches every workspace package, at every depth', () => {
    const packages = workspacePackages(REPO).map((p) => p.dir);
    expect(packages.length).toBeGreaterThan(10);
    const unscanned = packages.filter((dir) => !files.some((f) => f.startsWith(`${dir}/`)));
    expect(unscanned.map((d) => d.slice(REPO.length)), 'this package is scanned by nothing here').toEqual([]);
    const deepest = Math.max(...files.map((f) => f.slice(REPO.length).split('/').length));
    expect(deepest, 'the walk never left a package root — it is not recursing').toBeGreaterThan(4);
  });

  // The walk itself against a tree built to defeat a flat one, so the depth above cannot become a
  // fact about how `packages/` happens to be arranged.
  it('walks into a nested directory (positive control)', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-hygiene-'));
    mkdirSync(join(root, 'pkg', 'src', 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'src', 'a', 'b', 'deep.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'pkg', 'src', 'shallow.ts'), 'export const y = 1;\n');
    expect(sourceFiles(root).map((f) => f.slice(root.length + 1)).sort()).toEqual([
      'pkg/src/a/b/deep.ts',
      'pkg/src/shallow.ts',
    ]);
  });
});

/**
 * CLASS: someone's own machine baked into a tool, where only running the tool somewhere else says
 * so. Both halves of the review harness carried one — a `/home/user/parley` checkout root and a
 * `/tmp/careening/worktrees` — and each was found by a round failing, never by a test.
 *
 * Only HOME roots, so that a scratch path under `/tmp` — correct on every machine — is not swept up
 * with a checkout path that is correct on one. Judged over comment-stripped source, so that a
 * comment recording the mistake is not itself the violation.
 *
 * Applied to every workspace package as well as to `scripts/` and `.claude/`. The rule used to read
 * the two tool directories alone, from inside a published package's suite; a machine path is no
 * more acceptable in a backend than in a workflow script, and the wider set costs nothing.
 */
describe('no file in this repo names the machine it was written on', () => {
  const MACHINE_PATH = /(?<![\w./])\/(?:home|Users|root|mnt|media)\/[\w./$={}-]+/g;
  const HASH_COMMENT = /^\s*#.*$/gm;

  const named = (source: string, hash = false): string[] => [
    ...(hash ? source.replaceAll(HASH_COMMENT, '') : withoutComments(source)).matchAll(MACHINE_PATH),
  ].map((m) => m[0]);

  it.each([
    ['a checkout root in a constant', "const W = '/home/user/parley/.careening'", ['/home/user/parley/.careening']],
    ['a double-quoted one', 'const R = "/home/user/parley"', ['/home/user/parley']],
    ['an interpolated one', 'const R = `/Users/someone/src/${name}`', ['/Users/someone/src/${name}']],
    ['one narrated in a line comment', "// this said '/home/user/parley', the path on the container", []],
    ['one narrated in a block comment', "/* was '/home/user/parley' once */\nconst ok = 'x'", []],
    ['a tmp path, correct everywhere', "const W = '/tmp/careening/worktrees'", []],
    ['a bare word that is not a path', "const home = 'user/parley'", []],
  ])('reads %s', (_label, source, found) => {
    expect(named(source)).toEqual(found);
  });

  it.each([
    ['a shell assignment', "dir='/home/user/parley'", ['/home/user/parley']],
    ['a shell comment', 'root=$(git rev-parse --show-toplevel)\n# was /home/user/parley', []],
  ])('reads %s', (_label, source, found) => {
    expect(named(source, true)).toEqual(found);
  });

  const HASH_SYNTAX = ['.sh', '.yml', '.yaml'];

  const scanned = derivedRows(
    'every tool and source file',
    () =>
      [
        ...filesUnder(join(REPO, 'packages'), ['.ts', '.js', '.mjs', '.cjs']),
        ...filesUnder(join(REPO, 'examples'), ['.ts', '.js', '.mjs', '.cjs']),
        ...filesUnder(join(REPO, 'scripts'), ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']),
        ...filesUnder(join(REPO, '.claude'), ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']),
      ]
        .filter((f) => !f.endsWith('source-hygiene.test.ts'))
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 100,
      witness: ['packages/bridge-core/src', 'packages/conformance/src', 'scripts/', '.claude/'],
      size: () =>
        trackedFiles([
          ['packages/', ['.ts', '.js', '.mjs', '.cjs']],
          ['examples/', ['.ts', '.js', '.mjs', '.cjs']],
          ['scripts/', ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']],
          ['.claude/', ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']],
        ]),
    },
  );

  it.each(scanned)('%s', (_name, file) => {
    expect(
      named(readFileSync(file, 'utf8'), HASH_SYNTAX.some((ext) => file.endsWith(ext))),
      'this path is correct on one machine — derive it from the repository root instead',
    ).toEqual([]);
  });
});

/**
 * One hop of the value path, shared by the two rules below: a rule that matches a TOKEN inside an
 * assertion grades the spelling rather than the value, and the defect that motivated the first of
 * them was one call deep. `bindingsIn` is deliberately scope-blind — a rule that over-reaches
 * reports a site to look at, while one that under-reaches reports nothing at all, which is the
 * failure being fixed.
 */
const extentFrom = (
  code: string,
  at: number,
  open: string,
  close: string,
  stopAtSemicolon: boolean,
): string => {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    const ch = code[i]!;
    if (open.includes(ch)) depth++;
    else if (close.includes(ch)) {
      if (depth === 0) return code.slice(at, i);
      if (--depth === 0 && !stopAtSemicolon) return code.slice(at, i + 1);
    } else if (stopAtSemicolon && ch === ';' && depth === 0) return code.slice(at, i);
  }
  return code.slice(at);
};

/**
 * Names a callback or function takes as an argument. A scope-blind reader cannot tell which
 * binding an assertion sees when a module-level `const shards` and an `it.each` callback's
 * `shards` share a file, so a shadowed name is left alone rather than guessed at.
 */
const parameterNames = (code: string): Set<string> => {
  const out = new Set<string>();
  const collect = (group: string): void => {
    for (const ident of group.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) out.add(ident[1]!);
  };
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::[^=\n]*)?=>/g)) collect(m[1]!);
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) collect(m[1]!);
  return out;
};

/** Every module-scope name in a file, to the text that defines it. */
const bindingsIn = (code: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g))
    if (!out.has(m[1]!)) out.set(m[1]!, extentFrom(code, m.index + m[0].length, '([{', ')]}', true));
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*/g)) {
    const brace = code.indexOf('{', m.index);
    if (brace > 0) out.set(m[1]!, code.slice(m.index, brace) + extentFrom(code, brace, '{', '}', false));
  }
  return out;
};

/** Imported name to the specifier it came from, read before the literals are blanked. */
const importSpecifiers = (source: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of withoutComments(source).matchAll(
    /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^'\n]+)'/g,
  ))
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) out.set(name, m[2]!);
    }
  return out;
};

interface ValuePath {
  /** What defines `name` here, or in the sibling module it was imported from. */
  valueOf: (name: string) => string | undefined;
  /** Whether `text`, or the definition of anything it CALLS, matches `pattern`. */
  reaches: (text: string, pattern: RegExp) => boolean;
}

const valuePath = (
  source: string,
  moduleSource: (specifier: string) => string | undefined,
): ValuePath => {
  const local = bindingsIn(codeOf(source));
  const shadowed = parameterNames(codeOf(source));
  const imported = importSpecifiers(source);
  const resolved = new Map<string, string | undefined>();
  const valueOf = (name: string): string | undefined => {
    if (resolved.has(name)) return resolved.get(name);
    resolved.set(name, undefined);
    if (shadowed.has(name)) return undefined;
    let value = local.get(name);
    if (value === undefined) {
      const specifier = imported.get(name);
      const other = specifier === undefined ? undefined : moduleSource(specifier);
      if (other !== undefined) value = bindingsIn(codeOf(other)).get(name);
    }
    resolved.set(name, value);
    return value;
  };
  const reaches = (text: string, pattern: RegExp, depth = 0): boolean => {
    if (new RegExp(pattern.source).test(text)) return true;
    if (depth >= 1) return false;
    for (const call of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const value = valueOf(call[1]!);
      if (value !== undefined && reaches(value, pattern, depth + 1)) return true;
    }
    return false;
  };
  return { valueOf, reaches };
};

/** Sibling sources as a rule scanning the real tree sees them: relative specifiers, `.js` to `.ts`. */
const siblingsOf = (file: string) => (specifier: string) => {
  if (!specifier.startsWith('.')) return undefined;
  const path = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

/**
 * CLASS: an assertion whose expected value is read off the grading machine. The negative control
 * divided its budget by `availableParallelism()`, so the same commit was RED on one vCPU and GREEN
 * on eight and a developer could add work until CI reddened for a reason their box could not
 * reproduce. It is the same shape as a timing bound calibrated on the developer's laptop, so it is
 * graded as a class rather than at the one site that had it.
 */
describe('no assertion reads the machine it is being graded on', () => {
  const HOST_READS =
    /\b(?:availableParallelism|cpus|totalmem|freemem|loadavg)\s*\(|\bprocess\.(?:platform|arch)\b|\bprocess\.env\s*(?:\.(?:CI|GITHUB_ACTIONS|RUNNER_[A-Z_]+)\b|\[)/g;

  /**
   * The reads that TRAVEL: what a name is bound to makes every mention of that name a host read.
   * An env read whose KEY the literal mask has blanked is deliberately not one of them — the rule
   * cannot see which variable it names, and a helper that resolves a path out of the environment is
   * not an assertion graded against the box. It stays a host read where it is WRITTEN, inside an
   * assertion.
   */
  const TRAVELLING_HOST_READS =
    /\b(?:availableParallelism|cpus|totalmem|freemem|loadavg)\s*\(|\bprocess\.(?:platform|arch)\b|\bprocess\.env\s*\.(?:CI|GITHUB_ACTIONS|RUNNER_[A-Z_]+)\b/g;

  /**
   * From `expect(` to the end of its statement, so the matcher's argument is scanned too: a bound
   * hidden in `.toBeLessThan(cpus().length)` is the same defect as one hidden in the subject.
   */
  const assertionRegions = (code: string): string[] => {
    const out: string[] = [];
    for (const open of code.matchAll(/\bexpect(?:\.\w+)?\s*\(/g)) {
      let depth = 0;
      let at = open.index + open[0].length - 1;
      for (; at < code.length; at++) {
        const ch = code[at];
        if (ch === '(') depth++;
        else if (ch === ')' && --depth < 0) break;
        else if (ch === ';' && depth === 0) break;
      }
      out.push(code.slice(open.index, at));
    }
    return out;
  };

  /**
   * Where a name's host read lives: in the BODY, so every mention of it is one, or only in a
   * PARAMETER DEFAULT, so only a call that supplies nothing is. `brokenShards(cores)` passing a
   * declared constant is the fix that closed this defect; `brokenShards()` is the defect.
   */
  const hostReadKind = (path: ValuePath, name: string): 'body' | 'default' | 'none' => {
    const value = path.valueOf(name);
    if (value === undefined) return 'none';
    const at = value.indexOf('(');
    const callable = at >= 0 && /^[\s\w<>,:]*$/.test(value.slice(0, at));
    const params = callable ? extentFrom(value, at, '(', ')', false) : '';
    const body = callable ? value.slice(at + params.length) : value;
    if ([...body.matchAll(TRAVELLING_HOST_READS)].length > 0) return 'body';
    if ([...params.matchAll(TRAVELLING_HOST_READS)].length > 0) return 'default';
    return path.reaches(value, TRAVELLING_HOST_READS) ? 'body' : 'none';
  };

  const hostReadsInAssertions = (
    source: string,
    moduleSource: (specifier: string) => string | undefined = () => undefined,
  ): string[] => {
    const code = codeOf(source);
    const path = valuePath(source, moduleSource);
    const found: string[] = [];
    for (const region of assertionRegions(code)) {
      found.push(...[...region.matchAll(HOST_READS)].map((m) => m[0]));
      for (const use of region.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
        const kind = hostReadKind(path, use[1]!);
        const noArgument = /^\s*\(\s*\)/.test(region.slice(use.index + use[1]!.length));
        if (kind === 'body' || (kind === 'default' && noArgument)) found.push(use[1]!);
      }
    }
    return found;
  };

  /**
   * The sibling module of the row below that reads the host, in the shape the real one has: the
   * read is a parameter default, so the same name is a host read at one call site and not at
   * another.
   */
  const FIXTURE_MODULES: Record<string, string> = {
    './reference-plugin.js':
      'export const brokenShards = (cores: number = availableParallelism()): number =>\n' +
      '  Math.min(MAX_BROKEN_SHARDS, BROKEN_VARIANTS.length, cores);\n',
  };
  const fixtureModule = (specifier: string): string | undefined => FIXTURE_MODULES[specifier];

  /**
   * negative-control.test.ts as it stood in the commit that motivated this rule (2f36e7a^), which
   * the token-matching version of the rule reported clean: the host read is one call hop away,
   * through a sibling module, in a matcher's argument.
   */
  const PRE_FIX_NEGATIVE_CONTROL = [
    "import { BROKEN_VARIANTS, brokenShards } from './reference-plugin.js';",
    '',
    'it(\'the budget covers the whole table\', () => {',
    '  expect(',
    '    NESTED_RUN_BUDGET_MS,',
    '    `${BROKEN_VARIANTS.length} variants x ${CLAUSES.length} clauses over ${brokenShards()} ` +',
    "      'shards no longer fit the budget'",
    '  ).toBeGreaterThanOrEqual(',
    '    requiredBudgetMs(BROKEN_VARIANTS.length, CLAUSES.length, brokenShards()),',
    '  );',
    '});',
  ].join('\n');

  it.each([
    ['a core count as the expected value', 'expect(shards).toBe(availableParallelism());', ['availableParallelism(']],
    ['a core count as the subject', 'expect(cpus().length).toBeGreaterThan(0);', ['cpus(']],
    ['a memory read inside the data', 'expect([totalmem()]).toEqual(x);', ['totalmem(']],
    ['a CI flag branching the expectation', 'expect(n).toBe(process.env.CI ? 1 : 2);', ['process.env.CI']],
    ['the same flag reached by index', "expect(n).toBe(process.env['CI'] ? 1 : 2);", ['process.env[']],
    ['the runner flag', 'expect(n).toBe(process.env.GITHUB_ACTIONS ? 1 : 2);', ['process.env.GITHUB_ACTIONS']],
    ['a platform read in a plain argument', 'expect(a).toBe(process.platform);', ['process.platform']],
    ['a platform read inside a template placeholder', 'expect(a, `on ${process.platform}`).toBe(b);', ['process.platform']],
    ['a read one const away', 'const n = cpus().length;\nexpect(x).toBe(n);', ['n']],
    ['a read one local helper away', 'const shardsFor = () => cpus().length;\nexpect(x).toBe(shardsFor());', ['shardsFor']],
    [
      "a read two helpers away",
      'const cores = () => cpus().length;\nconst shardsFor = () => Math.min(4, cores());\nexpect(x).toBe(shardsFor());',
      ['shardsFor'],
    ],
    ['a read one helper away, in a matcher argument', 'const shardsFor = () => cpus().length;\nexpect(x).toBeLessThan(shardsFor());', ['shardsFor']],
    [
      'a read one helper away, in the diagnostic template',
      'const shardsFor = () => cpus().length;\nexpect(x, `over ${shardsFor()} shards`).toBe(y);',
      ['shardsFor'],
    ],
    ['the same read outside any assertion', 'const shards = availableParallelism();\nexpect(1).toBe(1);', []],
    ['a narrated one', '// expect(n).toBe(cpus().length)\nexpect(1).toBe(1);', []],
    [
      'a default-parameter read, called with nothing',
      "import { brokenShards } from './reference-plugin.js';\nexpect(B).toBeGreaterThanOrEqual(need(40, 57, brokenShards()));",
      ['brokenShards'],
    ],
    [
      'the same name called with a declared constant, which is the fix',
      "import { brokenShards } from './reference-plugin.js';\nexpect(brokenShards(GRADED_HOST_CORES)).toBe(2);",
      [],
    ],
  ])('reads %s', (_label, source, found) => {
    expect(hostReadsInAssertions(source, fixtureModule)).toEqual(found);
  });

  it('flags the source that motivated it', () => {
    expect(
      hostReadsInAssertions(PRE_FIX_NEGATIVE_CONTROL, fixtureModule),
      'a rule that cannot flag the commit it was written for is not a ratchet',
    ).not.toEqual([]);
  });

  /**
   * Sites allowed to grade a host read, each with the property that makes it safe. Empty is the
   * intended state; an entry is a debt, not a permission slip.
   */
  const KEEPS: ReadonlyArray<readonly [file: string, why: string]> = [];

  const scanned = derivedRows(
    'every test file in the repo',
    () =>
      workspacePackages(REPO)
        .flatMap((p) => filesUnder(p.dir, ['.ts']))
        .filter((f) => f.endsWith('.test.ts'))
        .sort()
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 50,
      witness: [
        'packages/bridge-core/src/source-hygiene.test.ts',
        'packages/conformance/test/negative-control.test.ts',
      ],
      size: () => trackedFiles([['packages/', ['.test.ts']]]),
    },
  );

  it.each(scanned)('%s', (name, file) => {
    const kept = KEEPS.find(([f]) => f === name);
    const found = hostReadsInAssertions(readFileSync(file, 'utf8'), siblingsOf(file));
    expect(
      kept ? [] : found,
      'this assertion is graded against the machine running it, so the same commit passes on one ' +
        'host and fails on another — compare against a declared constant instead',
    ).toEqual([]);
    if (kept) expect(found, `${name} is registered as a keep but no longer reads the host`).not.toEqual([]);
  });
});

/**
 * CLASS: a witness derived from the thing it witnesses. `witness: [...FAILURE_SHAPE_NAMES]` over
 * `produce: () => [...FAILURE_SHAPE_NAMES]` is satisfied by construction — the two sides narrow
 * together, so the half of a derivation that catches a narrowing is switched off while reading as
 * present. A witness has to be a member NAMED BY HAND: that is the only spelling a scan cannot
 * agree with by accident.
 */
describe('a derived table names its witnesses instead of deriving them', () => {
  const derivedWitnesses = (source: string): string[] => {
    const code = codeOf(source);
    const out: string[] = [];
    for (const spread of code.matchAll(/witness:\s*\[\s*\.\.\.([A-Za-z_$][\w$]*)/g))
      out.push(`witness: [...${spread[1]!}]`);
    for (const collection of code.matchAll(/witness:\s*([A-Z][A-Z0-9_]*)\b/g))
      out.push(`witness: ${collection[1]!}`);
    return out;
  };

  it.each([
    ['a spread of the table it grades', 'witness: [...FAILURE_SHAPE_NAMES],', ['witness: [...FAILURE_SHAPE_NAMES]']],
    ['a spread with a cast after it', 'witness: [...NAMES] as unknown as [string, ...string[]],', ['witness: [...NAMES]']],
    ['the collection itself', 'witness: NAMES,', ['witness: NAMES']],
    ['names written out', "witness: ['index.ts', 'archive.ts'],", []],
    ['a name held in a constant', "witness: [BARREL, 'failure-shapes.ts'],", []],
    ['the field\'s own type', 'witness: readonly [string, ...string[]];', []],
    ['a row\'s witness column, handed to the ruler under test', 'witness: witness as [string, ...string[]],', []],
    ['a rest parameter, which is not a witness', 'const f = (...args: string[]) => args;', []],
  ])('reads %s', (_label, source, found) => {
    expect(derivedWitnesses(source)).toEqual(found);
  });

  const witnessed = derivedRows(
    'every source and test file in the repo',
    () =>
      workspacePackages(REPO)
        .flatMap((p) => filesUnder(p.dir, ['.ts']))
        .sort()
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 200,
      witness: [
        'packages/bridge-net-util/test/derived-rows.test.ts',
        'packages/conformance/test/suite-shape.test.ts',
      ],
      size: () => trackedFiles([['packages/', ['.ts']]]),
    },
  );

  it.each(witnessed)('%s', (_name, file) => {
    expect(
      derivedWitnesses(readFileSync(file, 'utf8')),
      'this witness is derived from the same expression as the rows, so it narrows with them and ' +
        'proves nothing — name the members the scan must reach',
    ).toEqual([]);
  });
});

/**
 * CLASS: two absent values, one of them accepted. `??` stands in for undefined and null only, so an
 * environment variable SET TO EMPTY passes straight through it — and `${XDG_STATE_HOME:-…}`, the
 * shell spelling every one of these doc comments uses, means unset OR empty. Live twice: an empty
 * XDG_STATE_HOME made core's and telegram's "default" state paths RELATIVE to the spawn directory,
 * so a bridge relaunched from elsewhere opened a fresh file beside cursors an agent still held.
 */
describe('an optional environment value is not defaulted with `??`', () => {
  const NULLISH_ENV = /process\.env(?:\.[A-Za-z_][\w]*|\[[^\]]*\])\s*\?\?/g;

  const nullishEnvDefaults = (source: string): string[] =>
    [...withoutComments(source).matchAll(NULLISH_ENV)].map((m) => m[0].replace(/\s+/g, ' '));

  it.each([
    ['a dotted read', "const base = process.env.XDG_STATE_HOME ?? home();", ['process.env.XDG_STATE_HOME ??']],
    ['an indexed read', "const base = process.env['XDG_STATE_HOME'] ?? home();", ["process.env['XDG_STATE_HOME'] ??"]],
    ['a read guarded by trim first', "const set = process.env['X']?.trim() ?? '';", []],
    ['a read compared instead of defaulted', "if (process.env['X'] === undefined) return home();", []],
    ['the same line in a comment', '// process.env.X ?? home()', []],
  ])('reads %s', (_label, source, found) => {
    expect(nullishEnvDefaults(source)).toEqual(found);
  });

  const shipped = derivedRows(
    'every shipped source module',
    () =>
      workspacePackages(REPO)
        .flatMap((p) => filesUnder(join(p.dir, 'src'), ['.ts']))
        .filter((f) => !f.endsWith('.test.ts'))
        .sort()
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 100,
      witness: [
        'packages/bridge-core/src/engine/read-state.ts',
        'packages/bridge-telegram/src/config.ts',
      ],
    },
  );

  it.each(shipped)('%s', (_name, file) => {
    expect(
      nullishEnvDefaults(readFileSync(file, 'utf8')),
      'an environment variable set to the empty string is as absent as an unset one, and `??` ' +
        'passes it through — a blank value then becomes a path segment under the spawn directory',
    ).toEqual([]);
  });
});

/**
 * CLASS: a test that reaches a real user directory. `state_path` is optional and falls back to
 * `${XDG_STATE_HOME:-~/.local/state}/parley/<instance>/read-state.json`, so a test that omits it
 * opens the file a person's own bridge writes — reading a stale position, and advancing it. Twelve
 * test files across two packages built a config naming neither; three remembered to redirect.
 *
 * Graded here rather than in the twelve, because the defect IS that a file has to remember.
 */
describe('the suite runs against a sandboxed state directory, not the developer’s', () => {
  const sandbox = process.env.XDG_STATE_HOME ?? '';

  it('has XDG_STATE_HOME redirected under the temp directory', () => {
    expect(
      sandbox,
      'XDG_STATE_HOME is not a temp path — vitest.setup.ts is what puts it there, and without it ' +
        'every config that omits `state_path` opens the real ~/.local/state/parley file',
    ).toMatch(new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('resolves a default read-state path inside that sandbox and nowhere near the real home', () => {
    const path = defaultReadStatePath('probe-instance');
    expect(path.startsWith(sandbox), `${path} is outside ${sandbox}`).toBe(true);
    expect(path.startsWith(join(homedir(), '.local'))).toBe(false);
  });
});

/**
 * CLASS: a table that registers NOTHING, in the one place nothing reports it. `it.each([])` runs no
 * case and the file passes; scripts/assert-no-skipped-tests.mjs cannot see it either — that gate
 * scores the groups it finds in the run's assertion results, and a group that produced no row has no
 * key there. Its file-level check catches a file with no cases at all, not a group inside one:
 * WATCHED at head, planting `it.each([] as string[])(...)` at the end of a 42-case file and feeding
 * the JSON report to the gate printed `ok: 42 cases across 1 test files, none skipped away`, exit 0.
 *
 * The report loses the group. The SOURCE does not, which is why this is a lint.
 */
describe('no it.each table can register nothing', () => {
  /**
   * The rule is narrowed to tables ROOTED IN AN EXTERNAL ENUMERATION — a tree walk, or a child
   * process asked for one. "Any `.each(identifier)` not produced by derivedRows" was the wider
   * instruction, and it names 193 sites, almost all a `flatMap` over a literal declared beside it,
   * which cannot narrow past what is written there. A register of 193 would be a rubber stamp; a
   * walk that comes back short is the real exposure.
   *
   * It is the ARGUMENT EXPRESSION that is read, and one hop through what the names in it are bound
   * to — including into a sibling module. The version that matched `.each(BAREIDENT)` against a
   * regex-extracted right-hand side saw none of the spellings this repo actually uses: not
   * `.each(readdirSync(D))`, not `.each(WORKSPACES.map(…))`, and not a walk imported from next
   * door.
   */
  const EXTERNAL_ENUMERATION =
    /\b(?:readdirSync|filesUnder|workspacePackages|backendPackages|globSync|execFileSync|execSync|spawnSync)\s*\(/;

  const EMPTY_LITERAL = /^\s*\[\s*\](?:\s+as\b|\s*$)/;

  const ungradedTables = (
    source: string,
    moduleSource: (specifier: string) => string | undefined = () => undefined,
  ): string[] => {
    const code = codeOf(source);
    const path = valuePath(source, moduleSource);
    const out: string[] = [];
    for (const each of code.matchAll(/\.each\s*\(/g)) {
      const argument = extentFrom(code, each.index + each[0].length - 1, '(', ')', false).slice(1, -1);
      if (EMPTY_LITERAL.test(argument)) {
        out.push('.each([])');
        continue;
      }
      if (/\bderivedRows\s*\(/.test(argument)) continue;
      if (EXTERNAL_ENUMERATION.test(argument)) {
        out.push(`.each(${EXTERNAL_ENUMERATION.exec(argument)![0]}…)`);
        continue;
      }
      for (const name of new Set(
        [...argument.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]!),
      )) {
        const bound = path.valueOf(name);
        if (bound === undefined || /\bderivedRows\s*\(/.test(bound)) continue;
        if (EMPTY_LITERAL.test(bound)) {
          out.push('.each([])');
          break;
        }
        if (path.reaches(bound, EXTERNAL_ENUMERATION)) {
          out.push(`.each(${name})`);
          break;
        }
      }
    }
    return out;
  };

  /** The sibling module of the pinned rows below, in the shape the real one has: it walks. */
  const WALKING_MODULE: Record<string, string> = {
    './declared-config-keys.js':
      "import { readdirSync } from 'node:fs';\n" +
      'export function backendConfigDeclarations() {\n' +
      '  return filesUnder(PACKAGES).map((file) => declarationIn(file));\n' +
      '}\n',
  };
  const walkingModule = (specifier: string): string | undefined => WALKING_MODULE[specifier];

  /**
   * Two live tables this rule exists for, verbatim as they stand: packaging.test.ts, whose seven
   * `.each(WORKSPACES.map(…))` rows carry the whole publish gate off a set enumerated by a child
   * process, and refusal-coverage.test.ts, whose rows come from a walk one import hop away. Both
   * read as clean to the version of this rule that matched `.each(BAREIDENT)`.
   */
  const LIVE_SHAPES: ReadonlyArray<readonly [label: string, source: string]> = [
    [
      'packaging.test.ts: a set enumerated by a child process',
      'const WORKSPACES = publicWorkspaces();\n' +
        "it.each(WORKSPACES.map((w) => [w.name, w] as const))(\n" +
        "  '%s compiles no test source into its published output',\n" +
        '  (_name, w) => {},\n' +
        ');\n' +
        'function publicWorkspaces() {\n' +
        '  return JSON.parse(execFileSync(process.execPath, [], { encoding: \'utf8\' }));\n' +
        '}\n',
    ],
    [
      'refusal-coverage.test.ts: a walk one import hop away',
      "import { backendConfigDeclarations } from './declared-config-keys.js';\n" +
        'const declared = backendConfigDeclarations();\n' +
        "it.each(declared.map((d) => [d.pkg] as const))('%s crosses it', (pkg) => {});\n",
    ],
  ];

  it.each([
    ['an empty table', 'it.each([])(\'%s\', () => {});', ['.each([])']],
    ['an empty table with a type assertion', "it.each([] as string[])('%s', () => {});", ['.each([])']],
    ['a spaced empty table', 'it.each([ ])(\'%s\', () => {});', ['.each([])']],
    ['a table declared empty and filled later', "const f: string[] = [];\nit.each(f)('%s', () => {});", ['.each([])']],
    ['a bare identifier bound to a walk', "const f = readdirSync(D).sort();\nit.each(f)('%s', () => {});", ['.each(f)']],
    ['the walk spelled directly in the argument', "it.each(readdirSync(D))('%s', () => {});", ['.each(readdirSync(…)']],
    ['a walk mapped into rows', "const f = readdirSync(D);\nit.each(f.map((x) => [x]))('%s', () => {});", ['.each(f)']],
    [
      'a walk chained through two array methods',
      "const f = filesUnder(D, ['.ts']);\nit.each(f.flatMap((x) => [x]).filter(Boolean))('%s', () => {});",
      ['.each(f)'],
    ],
    [
      'a walk behind a local function',
      "function every() { return readdirSync(D); }\nconst f = every();\nit.each(f)('%s', () => {});",
      ['.each(f)'],
    ],
    [
      'a walk with no semicolon to end its binding',
      "const f = readdirSync(D)\nit.each(f)('%s', () => {})",
      ['.each(f)'],
    ],
    ['the same walk through derivedRows', "const f = derivedRows('f', () => readdirSync(D), { floor: 1, witness: ['x'] });\nit.each(f)('%s', () => {});", []],
    [
      'a derived table mapped into rows',
      "const f = derivedRows('f', () => readdirSync(D), { floor: 1, witness: ['x'] });\nit.each(f.map((x) => [x]))('%s', () => {});",
      [],
    ],
    ['a literal table', "const f = [['a'], ['b']];\nit.each(f)('%s', () => {});", []],
    ['a literal table mapped into rows', "const f = ['a', 'b'];\nit.each(f.map((x) => [x]))('%s', () => {});", []],
    ['a walk narrated in a comment', '// it.each([]) would be a hole\nit.each([1])(\'%s\', () => {});', []],
  ])('reads %s', (_label, source, found) => {
    expect(ungradedTables(source, walkingModule)).toEqual(found);
  });

  it.each(LIVE_SHAPES)('flags %s', (_label, source) => {
    expect(
      ungradedTables(source, walkingModule),
      'this shape is live in the tree and is what the rule was rewritten to see',
    ).not.toEqual([]);
  });

  /**
   * DEBT, not permission: the tables that were already building rows out of a walk when this rule
   * learned to see through a binding. The shipped rule matched `.each(BAREIDENT)` against a
   * regex-extracted right-hand side and so reported every one of them clean. Each owes a
   * `derivedRows` floor and witnesses; the entry is what makes the size of that owing visible, and
   * the case below fails a keep that no longer offends, so an entry cannot outlive its fix.
   */
  const KEEPS: ReadonlyArray<readonly [file: string, why: string]> = [
    ['packages/bridge-core/src/packaging.test.ts', 'seven publish-gate rows off WORKSPACES, a set a child process enumerates'],
    ['packages/bridge-core/src/transport/absent-topic-sites.test.ts', 'SENTINELS, from a walk of the transport sources'],
    ['packages/bridge-core/src/transport/skill-safety.test.ts', 'graded() and teachesTheLoop(), each from a walk of the shipped artifacts'],
    ['packages/bridge-matrix/test/shipped-artifacts.test.ts', 'configs, from a walk of the shipped example configs'],
    ['packages/bridge-net-util/test/refusal-coverage.test.ts', 'declared, from a walk one import hop away'],
    ['packages/bridge-net-util/test/retry-after-header.test.ts', 'clockShapedLiterals, from a walk of the package sources'],
    ['packages/bridge-postgres/test/suite-hygiene.test.ts', 'testFiles and pgMockingFiles, each from a walk'],
    ['packages/bridge-redis/test/readme.test.ts', 'linked, from a walk of the shipped documents'],
    ['packages/bridge-xmpp/test/backend-config.test.ts', 'exampleConfigs, from a walk with no floor at all'],
    ['packages/bridge-xmpp/test/creds-warning.test.ts', 'cells, declared empty and filled by nested loops'],
    ['packages/conformance/test/published-bins.test.ts', 'BINS, from a walk of every published manifest'],
    ['packages/conformance/test/repo-contract.test.ts', 'tested, SCRIPTS and file, each from a walk of the tree'],
  ];

  const tabled = derivedRows(
    'every source and test file in the repo',
    () =>
      workspacePackages(REPO)
        .flatMap((p) => filesUnder(p.dir, ['.ts']))
        .sort()
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 200,
      witness: [
        'packages/bridge-core/src/source-hygiene.test.ts',
        'packages/bridge-redis/test/test-hygiene.test.ts',
        'packages/bridge-telegram/test/docs.test.ts',
      ],
      size: () => trackedFiles([['packages/', ['.ts']]]),
    },
  );

  it.each(tabled)('%s', (name, file) => {
    const kept = KEEPS.find(([f]) => f === name);
    const found = kept ? [] : ungradedTables(readFileSync(file, 'utf8'), siblingsOf(file));
    expect(
      found,
      'this table can come back empty or short with the file reporting success — build it with ' +
        '`derivedRows`, which registers a case of its own for the floor and the witnesses',
    ).toEqual([]);
    if (kept)
      expect(
        ungradedTables(readFileSync(file, 'utf8'), siblingsOf(file)),
        `${name} is registered as debt but no longer builds a table this way — delete the entry`,
      ).not.toEqual([]);
  });
});
