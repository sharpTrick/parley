import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  backendPackages,
  derivedRows,
  filesUnder,
  importsIn,
  SUITE,
  type WorkspacePackage,
  workspacePackages,
  workspaceRoot,
} from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: the prime directive with nothing behind it. "`bridge-core` must never import from a
 * backend plugin. Dependencies point one way: plugins depend on core, never the reverse" is the
 * first rule in CLAUDE.md and half of the project's Definition of Done, and until this file it was
 * enforced by nothing. Planted at branch HEAD — `import '@sharptrick/parley-postgres';` at
 * allowlist.ts:1 with the same name in core's DEPENDENCIES — package-boundaries, repo-contract,
 * source-hygiene and index.test ran 1844 tests and none of them failed.
 *
 * Each miss was principled on its own: package-boundaries matches by PATH and deliberately admits
 * a package NAME import, which is the sanctioned way for a backend to reach a sibling;
 * source-hygiene's "names a backend plugin package" rule grades COMMENTARY, so a comment naming
 * bridge-postgres failed while an import of it passed; and packaging only reddens on an UNDECLARED
 * import, so declaring the dependency turned the one accidental guard off.
 *
 * So state the invariant as a GRAPH question and ask it here, at the repository level, rather than
 * inside the package it is mostly about — a package cannot be exempted from a repo-level rule by
 * living somewhere else. Both halves are derived: the offender set is the backends, and the set
 * that must not reach them is whatever the backends depend on. A backend added tomorrow joins the
 * day its manifest declares the suite.
 */

const REPO = workspaceRoot();

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** The package head of a specifier: `@scope/name/deep/path.js` -> `@scope/name`. */
const packageHead = (specifier: string): string =>
  specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

interface Edge {
  /** The package name depended on. */
  to: string;
  /** Where the dependency is written, relative to the repository root. */
  at: string;
}

/** Every workspace package this one names in a manifest dependency field. */
function declaredEdges(pkg: WorkspacePackage, known: ReadonlySet<string>): Edge[] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys((pkg.manifest[field] as Record<string, string> | undefined) ?? {})
      .filter((name) => known.has(name))
      .map((name) => ({ to: name, at: `${pkg.relative}/package.json ${field} -> ${name}` })),
  );
}

/**
 * Every workspace package this one's sources BIND, however the specifier is spelled.
 *
 * Read off the parse tree rather than a pattern, so that a side-effect import, an `import type`, a
 * dynamic `import()`, a `require()`, an alias and an `export … from` are the same fact — and so
 * that a backend name quoted inside a string, which is what a fixture and a lint table are made
 * of, is not one.
 */
function importedEdges(
  pkg: WorkspacePackage,
  known: ReadonlySet<string>,
  byDir: ReadonlyMap<string, string>,
): Edge[] {
  const out: Edge[] = [];
  for (const dir of ['src', 'test']) {
    for (const file of filesUnder(join(pkg.dir, dir), ['.ts', '.mts', '.cts', '.js', '.mjs'])) {
      for (const { specifier } of importsIn(readFileSync(file, 'utf8'))) {
        const at = `${relative(REPO, file)} -> ${specifier}`;
        if (specifier.startsWith('.')) {
          const landing = resolve(dirname(file), specifier);
          for (const [other, name] of byDir)
            if (landing.startsWith(`${other}/`) && other !== pkg.dir) out.push({ to: name, at });
          continue;
        }
        const head = packageHead(specifier);
        if (known.has(head) && head !== pkg.name) out.push({ to: head, at });
      }
    }
  }
  return out;
}

/** The workspace as a directed graph: package name -> what it depends on, and where it says so. */
export function packageGraph(root: string): Map<string, Edge[]> {
  const packages = workspacePackages(root);
  const known = new Set(packages.map((p) => p.name));
  const byDir = new Map(packages.map((p) => [p.dir, p.name] as const));
  return new Map(
    packages.map((p) => [p.name, [...declaredEdges(p, known), ...importedEdges(p, known, byDir)]]),
  );
}

/**
 * Every backend `from` can reach, and the chain of dependency edges that gets there. Transitive,
 * because a second package standing between the two is not a different violation: core importing a
 * helper that re-exports a backend is core depending on that backend.
 */
export function backendsReachableFrom(
  from: string,
  graph: ReadonlyMap<string, Edge[]>,
  backends: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set([from]);
  const queue: { name: string; chain: string[] }[] = [{ name: from, chain: [] }];
  while (queue.length > 0) {
    const { name, chain } = queue.shift() as { name: string; chain: string[] };
    for (const edge of graph.get(name) ?? []) {
      const path = [...chain, edge.at];
      if (backends.has(edge.to)) {
        out.push(path.join(' -> '));
        continue;
      }
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push({ name: edge.to, chain: path });
    }
  }
  return out;
}

/** The packages a backend depends on — the ones the arrow must never come back through. */
export const upstreamOfBackends = (root: string): string[] => {
  const backends = backendPackages(root);
  const names = new Set(backends.map((p) => p.name));
  const known = new Set(workspacePackages(root).map((p) => p.name));
  return [
    ...new Set(
      backends.flatMap((p) =>
        DEPENDENCY_FIELDS.flatMap((field) =>
          Object.keys((p.manifest[field] as Record<string, string> | undefined) ?? {}),
        ),
      ),
    ),
  ]
    .filter((name) => known.has(name) && !names.has(name))
    .sort();
};

describe('dependencies point one way', () => {
  const backends = new Set(backendPackages(REPO).map((p) => p.name));
  const graph = packageGraph(REPO);
  const upstream = upstreamOfBackends(REPO);

  it('finds the backends and the packages they depend on, so the rows below are not an empty table', () => {
    expect(backends.size).toBeGreaterThan(5);
    expect(upstream.length).toBeGreaterThan(1);
    expect(upstream).toContain('@sharptrick/parley-core');
    expect([...graph.values()].flat().length).toBeGreaterThan(20);
  });

  const rows = derivedRows(
    'every package a backend depends on',
    () => upstream.map((name) => [name] as const),
    { floor: 2, witness: ['@sharptrick/parley-core'] },
  );

  it.each(rows)('%s reaches no backend', (name) => {
    expect(
      backendsReachableFrom(name, graph, backends),
      'a backend plugin depends on this package, so this package must never depend on one — fix the seam, not with a branch in core',
    ).toEqual([]);
  });
});

/**
 * Both halves on a SYNTHETIC tree, one row per SPELLING, because the shape this rule exists to
 * catch is the one that is not on disk to catch — and because the rule it replaces had 31 planted
 * rows and not one of them was a package-NAME import.
 */
describe('the direction rule on a planted tree', () => {
  const plant = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'direction-'));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return root;
  };

  const manifest = (name: string, deps: Record<string, string> = {}): string =>
    JSON.stringify({ name, dependencies: deps });

  /** `beta` is the backend: it declares the shared suite, which is what makes one structurally. */
  const TREE = {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/core/package.json': manifest('@x/core'),
    'packages/core/src/index.ts': 'export const core = 1;\n',
    'packages/helper/package.json': manifest('@x/helper'),
    'packages/helper/src/index.ts': 'export const helper = 1;\n',
    'packages/beta/package.json': manifest('@x/beta', { [SUITE]: '^1', '@x/core': '^1' }),
    'packages/beta/src/index.ts': "import { core } from '@x/core';\nexport const beta = core;\n",
  };

  const reaches = (root: string, from: string): string[] =>
    backendsReachableFrom(
      from,
      packageGraph(root),
      new Set(backendPackages(root).map((p) => p.name)),
    );

  it('finds the backend of a planted tree at all', () => {
    expect(backendPackages(plant(TREE)).map((p) => p.name)).toEqual(['@x/beta']);
    expect(upstreamOfBackends(plant(TREE))).toEqual(['@x/core']);
  });

  it.each([
    ['a bare package-name import', "import { beta } from '@x/beta';", true],
    ['a deep path into the package', "import { beta } from '@x/beta/dist/deep.js';", true],
    ['a side-effect import', "import '@x/beta';", true],
    ['a type-only import', "import type { Beta } from '@x/beta';", true],
    ['an aliased import', "import { beta as b } from '@x/beta';", true],
    ['a namespace import', "import * as beta from '@x/beta';", true],
    ['a dynamic import', "const m = await import('@x/beta');", true],
    ['a require call', "const m = require('@x/beta');", true],
    ['an import-equals', "import m = require('@x/beta');", true],
    ['a re-export', "export { beta } from '@x/beta';", true],
    ['a wholesale re-export', "export * from '@x/beta';", true],
    ['a relative path into the package directory', "import { beta } from '../../beta/src/index.js';", true],
    // The mirror rows. The arrow is allowed to point the OTHER way, and a name that is only
    // spelled is not an edge — a lint table naming every backend is how this repository states a
    // rule about them.
    ['a sibling that is not a backend', "import { helper } from '@x/helper';", false],
    ['its own package', "import { core } from '@x/core';", false],
    ['a third-party module', "import ts from 'typescript';", false],
    ['a relative path inside itself', "import { core } from './other.js';", false],
    ['the backend named inside a string', "const banned = ['@x/beta'];", false],
    ['the backend named in a comment', "// never import '@x/beta'\nconst a = 1;", false],
  ])('core reaching a backend by %s is reported: %s', (_label, body, reported) => {
    const root = plant({ ...TREE, 'packages/core/src/index.ts': body });
    expect(reaches(root, '@x/core').length > 0).toBe(reported);
  });

  it.each(
    (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const).map(
      (field) => [field] as const,
    ),
  )("a backend declared in core's %s is reported", (field: string) => {
    const root = plant({
      ...TREE,
      'packages/core/package.json': JSON.stringify({ name: '@x/core', [field]: { '@x/beta': '^1' } }),
    });
    expect(reaches(root, '@x/core')).toHaveLength(1);
  });

  it('reports a backend reached through a second package', () => {
    const root = plant({
      ...TREE,
      'packages/core/src/index.ts': "export { beta } from '@x/helper';\n",
      'packages/helper/src/index.ts': "export { beta } from '@x/beta';\n",
    });
    const [chain] = reaches(root, '@x/core');
    expect(chain).toContain('packages/core/src/index.ts');
    expect(chain).toContain('packages/helper/src/index.ts');
  });

  it('reports a backend reached through a cycle without hanging', () => {
    const root = plant({
      ...TREE,
      'packages/core/src/index.ts': "export { helper } from '@x/helper';\n",
      'packages/helper/src/index.ts': "import { core } from '@x/core';\nexport { beta } from '@x/beta';\n",
    });
    expect(reaches(root, '@x/core')).toHaveLength(1);
  });

  it('leaves the backend free to depend on what it is built from', () => {
    const root = plant(TREE);
    expect(reaches(root, '@x/beta')).toEqual([]);
    expect(upstreamOfBackends(root)).not.toContain('@x/beta');
  });

  it('grades a package no backend depends on by nothing, so an example may drive one', () => {
    const root = plant({
      ...TREE,
      'packages/demo/package.json': manifest('@x/demo', { '@x/beta': '^1' }),
      'packages/demo/src/index.ts': "import { beta } from '@x/beta';\n",
    });
    expect(upstreamOfBackends(root)).toEqual(['@x/core']);
  });
});
