import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTEXT_FIELDS } from '@sharptrick/parley-conformance';

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
describe('README', () => {
  it.each(Object.keys(CONTEXT_FIELDS))('documents the required field `%s`', (field) => {
    expect(readme).toContain(field);
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

    it('no backend that runs the suite typechecks its own test sources', () => {
      expect(consumers().filter(typechecksTests)).toEqual([]);
    });

    it('does not claim NO tsconfig in the repo covers test/**, while some do', () => {
      expect(readdirSync(packagesDir).filter(typechecksTests)).not.toEqual([]);
      expect(readme).not.toMatch(/no tsconfig[^.]*includes? `?test/i);
    });
  });
});
