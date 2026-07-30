import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `tsc -b` builds the publish project, which excludes every `*.test.ts` and all of `test/`, and
 * vitest transpiles with esbuild without checking types. Whatever type-checks this package's test
 * surface therefore has to be asserted here, or the ~2,000 lines that poke private fields through
 * `as unknown as { … }` casts are graded by nothing and a stale plugin API reaches main unreported.
 */

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pkgDir, '..', '..');
const TEST_PROJECT = 'packages/bridge-sqlite/tsconfig.test.json';

function sourcesUnder(dir: string): string[] {
  return readdirSync(join(pkgDir, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourcesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function tsc(args: string[]): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync('npx', ['tsc', ...args], { cwd: repoRoot, encoding: 'utf8' }),
    };
  } catch (e) {
    const failure = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('every TypeScript source in this package is type-checked by some project', () => {
  it('the test project reports no diagnostics', () => {
    const { status, output } = tsc(['-b', TEST_PROJECT]);
    expect(output.trim(), output).toBe('');
    expect(status).toBe(0);
  }, 300_000);

  it('no .ts file is outside every tsconfig project', () => {
    const { status, output } = tsc(['--showConfig', '-p', TEST_PROJECT]);
    expect(status).toBe(0);
    const { files } = JSON.parse(output) as { files: string[] };
    const checked = new Set(files.map((f) => relative(pkgDir, join(pkgDir, f))));

    const present = [...sourcesUnder('src'), ...sourcesUnder('test')].filter((f) =>
      f.endsWith('.ts'),
    );
    expect(present.length).toBeGreaterThan(10);
    expect(present.filter((f) => !checked.has(f))).toEqual([]);
  }, 120_000);
});
