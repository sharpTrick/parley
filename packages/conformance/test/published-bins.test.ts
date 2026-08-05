import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * CLASS: the same entrypoint written N times, drifting in capability.
 *
 * `packages/*\/src/cli.ts` was ten files with ten distinct checksums doing one job. Three parsed
 * argv strictly; seven fell through their loop, so `parley-slack --help` exited 1 printing a
 * config-not-found stack trace and `parley-zulip --confg prod.yaml` silently brought a bridge up
 * against a different deployment. Each package's own suite graded its own copy, so nothing could
 * see that half the shipped bins behaved differently from the other half.
 *
 * Rows are one per manifest that declares a `bin` — derived, never listed — and every one runs the
 * BUILT artifact npm installs, because a parser that refuses correctly guards nothing if the
 * entrypoint does not consult it.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = join(REPO, 'packages');

interface Bin {
  /** `<package>:<bin name>`, the row label. */
  label: string;
  name: string;
  path: string;
  dir: string;
  version: string;
  readme: string;
}

function declaredBins(): Bin[] {
  return readdirSync(PACKAGES)
    .sort()
    .flatMap((pkg) => {
      const dir = join(PACKAGES, pkg);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) return [];
      const m = JSON.parse(readFileSync(manifest, 'utf8')) as {
        bin?: Record<string, string>;
        version?: string;
      };
      return Object.entries(m.bin ?? {}).map(([name, rel]) => ({
        label: `${pkg}:${name}`,
        name,
        path: join(dir, rel),
        dir,
        version: m.version ?? '',
        readme: existsSync(join(dir, 'README.md'))
          ? readFileSync(join(dir, 'README.md'), 'utf8')
          : '',
      }));
    });
}

const BINS = declaredBins();

const absent = (bin: Bin): boolean => !existsSync(bin.path);

/**
 * Build first, so a spawn cannot grade a stale artifact — `tsc -b` is the authority on whether
 * `dist/` matches `src/`, and comparing mtimes instead is a false positive against a builder that
 * keys on content: restoring a file byte-for-byte leaves it newer than a `dist/` tsc will not
 * rewrite, and the whole suite then skips itself away on a build that is in fact current.
 *
 * `--force` only when an artifact is MISSING, which is the one case `tsc -b` gets wrong: the
 * tsbuildinfo sits outside `dist/`, so a deleted `dist/` still reports the project up to date.
 */
beforeAll(() => {
  execFileSync('npx', ['tsc', '-b'], { cwd: REPO, stdio: 'pipe' });
  if (BINS.some(absent)) execFileSync('npx', ['tsc', '-b', '--force'], { cwd: REPO, stdio: 'pipe' });
  expect(BINS.filter(absent).map((b) => b.label), 'run `npm run build`').toEqual([]);
}, 300_000);

const run = (bin: Bin, argv: string[]): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [bin.path, ...argv], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

describe('every published bin answers the same way', () => {
  it('finds the bins the repo declares, so the rows below are not an empty table', () => {
    expect(BINS.length).toBeGreaterThan(8);
    for (const bin of BINS) expect(relative(REPO, bin.path)).toMatch(/^packages\//);
  });

  it.each(BINS.map((b) => [b.label, b] as const))('%s --help exits 0 with usage on stdout', (_l, bin) => {
    const r = run(bin, ['--help']);
    expect(r.status, 'the CLI died on a missing config file instead of printing usage').toBe(0);
    expect(r.stdout).toContain(`usage: ${bin.name}`);
    expect(r.stderr).toBe('');
  }, 30_000);

  it.each(BINS.map((b) => [b.label, b] as const))('%s --version prints its own version', (_l, bin) => {
    const r = run(bin, ['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(bin.version);
    expect(r.stderr).toBe('');
  }, 30_000);

  /**
   * An argv the bin cannot honour, and the argument its refusal has to name. The typo is the case
   * this exists for: silently ignored, it starts a bridge against the DEFAULT config, which names
   * another deployment's server, credential, handle and topic allowlist.
   */
  const REFUSED: [label: string, argv: string[], offender: string][] = [
    ['a mistyped flag', ['--confg', 'parley.prod.yaml'], '--confg'],
    ['a flag whose value the shell ate', ['--config'], '--config'],
    ['an empty --config=', ['--config='], '--config='],
    ['a bare positional', ['parley.prod.yaml'], 'parley.prod.yaml'],
    ['an unknown flag', ['--verbose'], '--verbose'],
  ];

  it.each(
    BINS.flatMap((bin) =>
      REFUSED.map(([label, argv, offender]) => [`${bin.label} refuses ${label}`, bin, argv, offender] as const),
    ),
  )('%s', (_l, bin, argv, offender) => {
    const r = run(bin, argv);
    expect(r.status, 'the CLI started a bridge instead of refusing').toBe(2);
    expect(r.stderr).toContain(offender);
    expect(r.stdout, 'stdout is the JSON-RPC channel — diagnostics belong on stderr').toBe('');
  }, 30_000);

  // An operator meets these flags in the README or not at all, and two of the three packages that
  // implemented them documented them.
  it.each(BINS.map((b) => [b.label, b] as const))('%s documents --help and --version', (_l, bin) => {
    expect(bin.readme).toContain('--help');
    expect(bin.readme).toContain('--version');
  });
});
