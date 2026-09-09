import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { derivedRows, withoutComments, workspacePackages } from '@sharptrick/parley-net-util/testing';

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

/** Every directory holding a manifest under a declared workspace area — the set, never a member. */
const packageDirs = (root: string): string[] => workspacePackages(root).map((p) => p.dir);

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name)) tsFilesUnder(full, out);
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** What a path segment this scan cannot read stands for: anything, of any depth. */
const UNKNOWN_SEGMENT = '*';

/**
 * The arguments of a `join(...)`/`resolve(...)` call, as written. A comma inside a nested call
 * splits one argument into fragments, and every fragment that is not a quoted literal becomes an
 * {@link UNKNOWN_SEGMENT} — which is the safe direction: it widens what the path could be.
 */
const argumentsOf = (call: string): string[] =>
  call.split(',').map((a) => a.trim()).filter((a) => a !== '');

/**
 * Every relative path a source names, with anything the scan cannot read as a literal standing in
 * as {@link UNKNOWN_SEGMENT}. An interpolation is a WILDCARD rather than a stop: the escape that
 * shipped was a quoted literal, but `../../${pkg}/src`, `'../../' + pkg` and a `join()` whose
 * package segment is a variable all name a sibling package just as effectively, and a scan that
 * reads only fully-literal spellings reports a repository with none of them as clean.
 */
export function relativePathsNamed(source: string): string[] {
  const code = withoutComments(source);
  const wildcarded = (body: string): string =>
    body.replaceAll(/\$\{[^}]*\}/g, UNKNOWN_SEGMENT);
  return [
    ...[...code.matchAll(/(['"])(\.\.?\/[^'"\n]*)\1(\s*\+)?/g)].map(
      (m) => (m[2] as string) + (m[3] === undefined ? '' : UNKNOWN_SEGMENT),
    ),
    ...[...code.matchAll(/`(\.\.?\/[^`\n]*)`/g)].map((m) => wildcarded(m[1] as string)),
    ...[...code.matchAll(/\b(?:join|resolve)\(([^)]*)\)/g)]
      .map((m) => argumentsOf(m[1] as string))
      .map((args) => {
        const first = args.findIndex((a) => /^'\.\.?(\/|')/.test(a));
        return first === -1 ? [] : args.slice(first);
      })
      .filter((args) => args[0]?.startsWith("'..") === true)
      .map((args) =>
        args
          .map((a) => (/^'[^']*'$/.test(a) ? a.slice(1, -1) : UNKNOWN_SEGMENT))
          .join('/'),
      ),
  ];
}

/**
 * Which of `file`'s named paths land inside a package other than the one holding `file`.
 *
 * A path carrying an {@link UNKNOWN_SEGMENT} is judged on the literal HEAD it resolves to, and any
 * package under that head counts as reached: the segment the scan could not read may hold a
 * package name, a path with slashes in it, or the caller's own variable, and a rule that assumed
 * the harmless reading would be a rule with a hole rather than a rule. Resolving it against the
 * values actually passed, or writing the path as a literal, is what clears it.
 */
export function reachesIntoAnotherPackage(
  file: string,
  source: string,
  own: string,
  packages: string[],
): string[] {
  const inside = (abs: string, dir: string): boolean => abs === dir || abs.startsWith(`${dir}/`);
  return [...new Set(relativePathsNamed(source))].filter((p) => {
    const wildcard = p.indexOf(UNKNOWN_SEGMENT);
    if (wildcard === -1) {
      const abs = resolve(dirname(file), p);
      return packages.some((dir) => dir !== own && inside(abs, dir));
    }
    // Cut at the last complete directory, so that a wildcard inside a segment (`../../beta-${x}`)
    // is judged from the directory that segment lives in rather than from a prefix of its name.
    const literal = p.slice(0, p.lastIndexOf('/', wildcard) + 1);
    const head = resolve(dirname(file), literal === '' ? '.' : literal);
    return packages.some((dir) => dir !== own && inside(dir, head));
  });
}

/**
 * `const NAME = …` bindings this scan can resolve to a directory.
 *
 * Judging only paths that BEGIN with `..` left the repo-root spelling walking straight through —
 * `const REPO = fileURLToPath(new URL('../../../', import.meta.url))` and then
 * `readFileSync(join(REPO, 'packages', 'bridge-core', 'src', 'seam.ts'))`. That is the spelling the
 * repo's own meta-guards use, so it is the one the next author copies. A head this scan cannot
 * resolve — a `mkdtempSync` root, a caller's argument — stays unjudged, because a planted tree is
 * where the rules below are graded and flagging one would make the rule unusable.
 */
export function rootBindings(file: string, source: string): Map<string, string> {
  const code = withoutComments(source);
  const known = new Map<string, string>();
  const segments = (args: string): string[] =>
    [...args.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]+);/g)) {
    const name = m[1] as string;
    const expression = m[2] as string;
    const literals = segments(expression);
    if (/import\.meta\.url/.test(expression) && literals.length > 0) {
      known.set(name, resolve(dirname(file), literals[0] as string));
      continue;
    }
    const url = /new URL\(\s*(?:'([^'\n]*)'|"([^"\n]*)")\s*,\s*(\w+)\s*\)/.exec(expression);
    const from = url === null ? undefined : known.get(url[3] as string);
    if (url !== null && from !== undefined) {
      known.set(name, resolve(from, (url[1] ?? url[2]) as string));
      continue;
    }
    const rooted = /\b(?:join|resolve)\(\s*(\w+)\s*,([^)]*)\)/.exec(expression);
    const head = rooted === null ? undefined : known.get(rooted[1] as string);
    if (rooted !== null && head !== undefined) {
      const rest = segments(rooted[2] as string);
      if (rest.length > 0) known.set(name, resolve(head, rest.join('/')));
    }
  }
  return known;
}

/** Every absolute path a source builds from a head this scan resolved, whatever that head is called. */
export function rootedPathsNamed(file: string, source: string): string[] {
  const known = rootBindings(file, source);
  const code = withoutComments(source);
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:join|resolve)\(([^)]*)\)/g)) {
    const args = argumentsOf(m[1] as string);
    const head = known.get(args[0] ?? '');
    if (head === undefined || args.length < 2) continue;
    out.push(
      resolve(
        head,
        args
          .slice(1)
          .map((a) => (/^(?:'[^']*'|"[^"]*")$/.test(a) ? a.slice(1, -1) : UNKNOWN_SEGMENT))
          .join('/'),
      ),
    );
  }
  for (const m of code.matchAll(/new URL\(\s*(?:'([^'\n]*)'|"([^"\n]*)")\s*,\s*(\w+)\s*\)/g)) {
    const head = known.get(m[3] as string);
    if (head !== undefined) out.push(resolve(head, (m[1] ?? m[2]) as string));
  }
  return out;
}

/**
 * Which of `file`'s rooted paths land inside a package other than the one holding it.
 *
 * A path carrying a segment this scan could not read is a DERIVATION — `join(REPO, area, folder)`
 * over what `readdirSync` returned — and deriving the package set is the sanctioned shape. Only a
 * path that names a member as a literal is judged here; the `..`-headed rule above keeps its own
 * conservative reading of a wildcard, where the segment is one the author wrote.
 */
export function rootedReaches(
  file: string,
  source: string,
  own: string,
  packages: string[],
): string[] {
  const inside = (abs: string, dir: string): boolean => abs === dir || abs.startsWith(`${dir}/`);
  return [...new Set(rootedPathsNamed(file, source))]
    .filter((abs) => !abs.includes(UNKNOWN_SEGMENT))
    .filter((abs) => packages.some((dir) => dir !== own && inside(abs, dir)));
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

  const rows = derivedRows(
    'every workspace package',
    () => PACKAGES.map((dir) => [relative(REPO, dir), dir] as const),
    { floor: 11, witness: ['packages/bridge-core', 'packages/conformance'] },
  );

  it.each(rows)('%s', (_name, own) => {
    const offenders = filesOf(own).flatMap((f) => {
      const source = readFileSync(f, 'utf8');
      return [
        ...reachesIntoAnotherPackage(f, source, own, PACKAGES),
        ...rootedReaches(f, source, own, PACKAGES).map((abs) => relative(REPO, abs)),
      ].map((p) => `${relative(REPO, f)} → ${p}`);
    });
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

  /**
   * The control bodies below name a path with a segment this scan cannot read, and this file is
   * scanned by the rule it declares. Keep these prefixes out of the bodies as literals, so that
   * this file's own controls are not read as this file reaching into every package in the repo.
   */
  const UP2 = '../' + '../';
  const UP3 = '../' + '../' + '../';
  const UP2_SEGMENTS = "'..', '..'";

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
    ['a resolve() of a sibling source', "import.meta.resolve('../../beta/src/seam.js')", true],
    // One row per SPELLING of the same reach, so the next way to write it is a row rather than a
    // rediscovery.
    ['an interpolated template', `const p = \`${UP2}\${which}/src/seam.ts\`;`, true],
    ['a concatenation', `const p = '${UP2}' + which;`, true],
    ['a URL built from a concatenation', `const p = new URL('${UP2}' + which + '/src', u);`, true],
    ['a join() with a variable segment', `const p = join(here, ${UP2_SEGMENTS}, which, 'src');`, true],
    ['an interpolated package name', `const p = \`${UP2}beta-\${flavour}/src\`;`, true],
    // The mirror rows: an interpolation that cannot leave its own package, and one whose head is a
    // repo directory holding no package, must both stay accepted or the rule is unusable.
    ['an interpolated path inside its own package', `const p = \`./fixtures/\${name}.json\`;`, false],
    ['an interpolated path under its own src', `const p = \`../src/\${name}.ts\`;`, false],
    ['an interpolated path under a non-package directory', `const p = \`${UP3}docs/\${f}.md\`;`, false],
    ['an interpolated sibling path named only in prose', `// see \`${UP2}\${p}/src\`\nconst a = 1;`, false],
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

  /**
   * The same rule reached from a HEAD the scan has to resolve. Every row here starts at a repo root
   * rather than at `..`, which is the spelling the repository's own guards use and therefore the one
   * the next author copies — and it walked through the `..`-only rule untouched.
   */
  const ROOT_OF = (up: string): string =>
    `const REPO = fileURLToPath(new URL('${up}', import.meta.url));\n`;
  const FROM_ALPHA = ROOT_OF('../' + '../' + '../');

  const rootedVerdict = (root: string, path: string, body: string): string[] => {
    const packages = packageDirs(root);
    const file = join(root, path);
    const own = packages.find((d) => file.startsWith(`${d}/`)) as string;
    return rootedReaches(file, body, own, packages).map((abs) => relative(root, abs));
  };

  it.each([
    ['a segment list off the repo root', `${FROM_ALPHA}readFileSync(join(REPO, 'packages', 'beta', 'src', 'seam.ts'));`, ['packages/beta/src/seam.ts']],
    ['one literal off the repo root', `${FROM_ALPHA}readFileSync(join(REPO, 'packages/beta/src/seam.ts'));`, ['packages/beta/src/seam.ts']],
    ['a URL off the repo root', `${FROM_ALPHA}readFileSync(new URL('packages/beta/src/seam.ts', REPO));`, ['packages/beta/src/seam.ts']],
    ['a root resolved one binding at a time', `${FROM_ALPHA}const BETA = join(REPO, 'packages', 'beta');\nreadFileSync(join(BETA, 'src', 'seam.ts'));`, ['packages/beta', 'packages/beta/src/seam.ts']],
    ['naming the sibling package directory itself', `${FROM_ALPHA}readdirSync(join(REPO, 'packages', 'beta'));`, ['packages/beta']],
    // The mirror rows. Deriving the package SET is the sanctioned shape, and a head this scan
    // cannot resolve — a planted tree, a caller's argument — is not a statement about this repo.
    ['a derived member of the package set', `${FROM_ALPHA}readdirSync(join(REPO, 'packages', folder, 'src'));`, []],
    ['the packages root itself', `${FROM_ALPHA}readdirSync(join(REPO, 'packages'));`, []],
    ['a repo-root document', `${FROM_ALPHA}readFileSync(join(REPO, 'DESIGN.md'));`, []],
    ['a path under its own package', `${FROM_ALPHA}readFileSync(join(REPO, 'packages', 'alpha', 'src', 'x.ts'));`, []],
    ['a temporary tree the scan cannot resolve', "const root = mkdtempSync('x');\nwriteFileSync(join(root, 'packages', 'beta', 'package.json'), '{}');", []],
    ['a sibling named only in prose', `${FROM_ALPHA}// join(REPO, 'packages', 'beta')\nconst a = 1;`, []],
  ])('judges %s', (_label, body, reached) => {
    const root = plant({ ...TWO_PACKAGES, 'packages/alpha/src/probe.ts': '' });
    expect(rootedVerdict(root, 'packages/alpha/src/probe.ts', body)).toEqual(reached);
  });
});
