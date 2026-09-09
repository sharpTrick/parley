import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derivedRows } from './derived-rows.js';
import { filesUnder, workspacePackages, workspaceRoot } from './workspace.js';

/**
 * CLASS: one rule, written four times, over four different universes. Four comment lints covered
 * four of twelve packages with DISJOINT rule sets and four private walkers, so the package with the
 * most violations of their union was the one none of them read. A rule is only ever as good as the
 * set it is applied to, and a set each rule derives for itself is one that narrows in private.
 *
 * A rule declares its own positive and negative controls here, so a predicate that has stopped
 * matching anything fails on its own row instead of reporting a clean repository.
 */

export interface LintTarget {
  /** The package folder, e.g. `bridge-core`. */
  pkg: string;
  /** Path from the repository root. */
  path: string;
  text: string;
}

export interface SourceRule {
  name: string;
  /** Everything in `source` the rule refuses, as reportable text. Empty means clean. */
  detect: (source: string) => string[];
  /** What the rule must refuse, as `[label, source]`. A rule with none grades nothing. */
  fires: readonly (readonly [string, string])[];
  /** What the rule must leave alone, as `[label, source]`. */
  passes: readonly (readonly [string, string])[];
  /** What a reader should do about an offence. */
  remedy: string;
}

/** Every `.ts` file of every workspace package, at every depth. */
export function lintTargets(root: string = workspaceRoot()): LintTarget[] {
  return workspacePackages(root).flatMap((pkg) =>
    filesUnder(pkg.dir).map((path) => ({
      pkg: pkg.folder,
      path: relative(root, path),
      text: readFileSync(path, 'utf8'),
    })),
  );
}

/**
 * One rule, applied to every workspace package, with its own controls beside it. The `fires` bodies
 * are re-run QUOTED as string data: a scan that reads a fixture as an offence flags the file that
 * documents the rule, which is how a lint acquires an allowlist it did not need.
 */
export function lintEveryPackage(rule: SourceRule, targets: readonly LintTarget[]): void {
  describe(rule.name, () => {
    it.each(rule.fires)('refuses %s', (_label, source) => {
      expect(rule.detect(source), 'this shape is not matched by its own rule').not.toEqual([]);
    });

    it.each(rule.passes)('leaves %s alone', (_label, source) => {
      expect(rule.detect(source), 'the rule fires on something the code must stay free to write').toEqual([]);
    });

    it.each(rule.fires)('reads %s as data when it is quoted', (_label, source) => {
      expect(rule.detect(`const fixture = ${JSON.stringify(source)};\n`)).toEqual([]);
    });

    const files = derivedRows(rule.name, () => targets.map((t) => [t.path, t] as const), {
      floor: 100,
      witness: ['packages/bridge-core/src', 'packages/conformance/src'],
    });

    it.each(files)('%s', (_path, target) => {
      expect(rule.detect(target.text), rule.remedy).toEqual([]);
    });
  });
}
