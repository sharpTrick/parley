import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packagesDir = new URL('../../', import.meta.url);

interface Manifest {
  name?: string;
  private?: boolean;
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

// A `tsconfig.test.json` that resolves its own package through node_modules typechecks the BUILT
// dist/, not the sources vitest runs — so the one gate that would have caught a changed public
// surface grades a stale artifact and passes.
describe('a test tsconfig typechecks its own sources, not its dist', () => {
  const withTestTsconfig = (): { dir: string; cfg: string }[] =>
    manifests()
      .map(({ dir }) => {
        try {
          return { dir, cfg: readFileSync(new URL(`${dir}/tsconfig.test.json`, packagesDir), 'utf8') };
        } catch {
          return undefined;
        }
      })
      .filter((v): v is { dir: string; cfg: string } => v !== undefined);

  it('there is at least one, so this check is not vacuous', () => {
    expect(withTestTsconfig().length).toBeGreaterThan(0);
  });

  it.each(withTestTsconfig().map(({ dir }) => dir))('%s aliases its own name to src', (dir) => {
    const { cfg } = withTestTsconfig().find((c) => c.dir === dir) as { cfg: string };
    const { name } = manifests().find((m) => m.dir === dir)?.pkg as { name: string };
    const parsed = JSON.parse(cfg) as { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(parsed.compilerOptions?.paths?.[name]).toEqual(['./src/index.ts']);
  });
});
