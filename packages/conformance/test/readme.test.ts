import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUSES, CONTEXT_FIELDS } from '@sharptrick/parley-conformance';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packagesDir = new URL('../../', import.meta.url);

/** Workspace packages whose package.json depends on this one — the suite's real consumer set. */
function consumers(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(packagesDir)) {
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(
        readFileSync(new URL(`${dir}/package.json`, packagesDir), 'utf8'),
      ) as typeof pkg;
    } catch {
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('@sharptrick/parley-conformance' in deps && pkg.name !== undefined) out.push(dir);
  }
  return out.sort();
}

// The README restates the ConformanceContext type and lists the backends it runs against; both
// drifted far enough that its `makeContext()` example no longer compiled against the real type.
/**
 * The fenced `ts` block that restates `ConformanceContext`. Scoped to the block, so that a field
 * named only in surrounding prose does not count as documentation: `toContain('plugin')` over the
 * whole file was satisfied by the intro sentence "run it against every backend plugin", so the
 * declaration — or the entire block — could go with the row still green.
 */
function contextBlock(): string {
  const fences = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  return fences.find((f) => f.includes('interface ConformanceContext')) ?? '';
}

describe('README', () => {
  it('has a ConformanceContext code block to scope the field checks to', () => {
    expect(contextBlock()).toContain('interface ConformanceContext');
    expect(contextBlock().length).toBeGreaterThan(200);
  });

  it.each(Object.keys(CONTEXT_FIELDS))('documents the required field `%s`', (field) => {
    expect(contextBlock()).toMatch(new RegExp(`^\\s*${field}\\??:|^\\s*${field}\\(`, 'm'));
  });

  // The README advertises what the suite checks, and a reader has no way to tell whether it still
  // does. Every clause the suite grades must be named here, in the same words the table uses.
  it.each(CLAUSES.map((c) => [c]))('advertises the clause %s', (clause) => {
    expect(readme).toContain(clause);
  });

  it("documents the 'unsupported' sentinel rather than an optional concurrentPost", () => {
    expect(readme).toContain("'unsupported'");
    expect(readme).not.toMatch(/concurrentPost\?/);
    expect(readme).not.toMatch(/concurrentPost is optional/);
  });

  it('runs its example command against every package that depends on the suite', () => {
    const missing = consumers().filter((dir) => !readme.includes(`packages/${dir}`));
    expect(missing).toEqual([]);
  });

  // The README justified the runtime validator with an absolute "no X in this repo" that this very
  // package falsifies. Recompute the set instead of restating it: what is load-bearing is that no
  // BACKEND typechecks its test sources, which is why a fixture's context literal is runtime-only.
  describe('the claim behind the runtime context validator', () => {
    const typechecksTests = (dir: string): boolean => {
      for (const name of ['tsconfig.json', 'tsconfig.test.json']) {
        let raw: string;
        try {
          raw = readFileSync(new URL(`${dir}/${name}`, packagesDir), 'utf8');
        } catch {
          continue;
        }
        const cfg = JSON.parse(raw) as { include?: string[] };
        if ((cfg.include ?? []).some((g) => g.startsWith('test/'))) return true;
      }
      return false;
    };

    // Assert what keeps the runtime validator NECESSARY, not a count of who has caught up. Pinning
    // "nobody typechecks their tests" makes the suite go red when a backend IMPROVES, which is what
    // happened the moment bridge-sqlite and bridge-slack added a test project. It becomes a real
    // question only when the set empties.
    it('at least one backend running the suite does not typecheck its own test sources', () => {
      const without = consumers().filter((d) => !typechecksTests(d));
      expect(without, 'every consumer now typechecks its tests — the runtime context validator may no longer be load-bearing, so re-justify it or drop it').not.toEqual([]);
    });

    it('does not claim NO tsconfig in the repo covers test/**, while some do', () => {
      expect(readdirSync(packagesDir).filter(typechecksTests)).not.toEqual([]);
      expect(readme).not.toMatch(/no tsconfig[^.]*includes? `?test/i);
    });
  });
});
