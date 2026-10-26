import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  derivedRows,
  workspacePackages,
  workspaceRoot,
} from '@sharptrick/parley-net-util/testing';

/**
 * CLASS: a release whose notes are the PR title. A merge to `main` publishes, merges are
 * squash-only, and release-notes-generator renders the GitHub Release from the commits since the
 * last tag — which is that one squashed commit. CHANGELOG.md is therefore the only place a user
 * upgrading from the last release can read what left the published surface, and nothing else in
 * this repo reads it: it went untouched across the 130 commits that removed presence, withdrew
 * `block_ms` from eight backends and made push lossy.
 *
 * So the file is graded from the two ends independently: the barrels as they stood at the last tag
 * (git), and the `## Unreleased` section as it stands now (markdown).
 */
const REPO = workspaceRoot();

const git = (...args: string[]): string => {
  try {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      `this rule reads the last release tag out of git (\`git ${args.join(' ')}\` failed: ` +
        `${err instanceof Error ? err.message : String(err)}). A shallow or tagless clone cannot ` +
        'grade a changelog against the release it is written for — fetch tags (CI checks out with ' +
        '`fetch-depth: 0`).',
    );
  }
};

/** The last release this branch descends from: the baseline every "since" claim is measured against. */
const BASELINE = git('describe', '--tags', '--abbrev=0').trim();

const atBaseline = (path: string): string | undefined => {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `${BASELINE}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/**
 * Every name a module publishes, over the AST rather than a regex: a barrel re-exports through
 * `export { … } from`, `export *` and plain declarations, and a reader that sees only one of those
 * spellings reports a surface narrower than the one npm ships.
 */
function exportedNamesOf(
  path: string,
  read: (path: string) => string | undefined,
  seen = new Set<string>(),
): string[] {
  if (seen.has(path)) return [];
  seen.add(path);
  const source = read(path);
  if (source === undefined) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.push(element.name.text);
      } else if (!statement.exportClause && statement.moduleSpecifier !== undefined) {
        const spec = (statement.moduleSpecifier as ts.StringLiteral).text.replace(/\.js$/, '.ts');
        names.push(...exportedNamesOf(normalize(join(dirname(path), spec)), read, seen));
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        names.push(declaration.name.getText(file));
    } else if ('name' in statement && statement.name !== undefined) {
      names.push((statement.name as ts.Node).getText(file));
    }
  }
  return names;
}

/** Every entry-point source a published manifest points npm at, derived from its `exports` map. */
const barrelsOf = (manifest: Record<string, unknown>, dir: string): string[] =>
  Object.values((manifest['exports'] ?? {}) as Record<string, unknown>)
    .filter((entry): entry is { types?: string } => typeof entry === 'object' && entry !== null)
    .map((entry) => entry.types)
    .filter((types): types is string => typeof types === 'string')
    .map((types) => join(dir, types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts')));

describe('the changelog names what the next release withdraws', () => {
  const published = workspacePackages(REPO).filter((p) => p.manifest.private !== true);

  const baseline = derivedRows(
    `every name a published barrel exported at ${BASELINE}`,
    () =>
      published.flatMap((p) =>
        barrelsOf(p.manifest as Record<string, unknown>, p.relative).flatMap((barrel) =>
          exportedNamesOf(barrel, atBaseline).map((name) => [p.name, name] as const),
        ),
      ),
    {
      floor: 80,
      witness: ['runConformanceSuite', 'ReadStateStore', '@sharptrick/parley-core'],
    },
  );

  it('measures against a released commit, not against this one', () => {
    expect(
      git('rev-parse', `${BASELINE}^{commit}`).trim(),
      `${BASELINE} resolves to HEAD, so every "removed since the last release" set is empty by ` +
        'construction and this file grades nothing',
    ).not.toEqual(git('rev-parse', 'HEAD').trim());
  });

  it('names every export withdrawn since the last release', () => {
    const current = new Set(
      published.flatMap((p) =>
        barrelsOf(p.manifest as Record<string, unknown>, join(REPO, p.relative)).flatMap((barrel) =>
          exportedNamesOf(barrel, (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)),
        ),
      ),
    );
    const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
    const unreleased = /^## Unreleased$([\s\S]*?)^## /m.exec(changelog)?.[1] ?? '';
    const undocumented = [
      ...new Set(baseline.filter(([, name]) => !current.has(name)).map(([, name]) => name)),
    ].filter((name) => !unreleased.includes(name));
    expect(
      undocumented,
      `these names were published at ${BASELINE} and are not exported today, and the ` +
        '`## Unreleased` section of CHANGELOG.md does not mention them — a squash merge makes that ' +
        'section the only account of this release a user upgrading will ever read',
    ).toEqual([]);
  });
});
