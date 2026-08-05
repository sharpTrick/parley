import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Two promises this package makes are kept by configuration rather than by code, so nothing fails
// when the configuration is simply absent. Its ~4700 lines of test source were outside every
// tsconfig, while CI's typecheck step justifies itself by claiming the opposite; and `files:
// ["dist"]` with no LICENSE beside package.json publishes a tarball that declares "license": "MIT"
// and ships no licence text. Both are derived here from the manifest, from CI and from what is on
// disk — never from a list kept by hand, which is the thing that went missing in the first place.

const PKG = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

interface Manifest {
  files?: string[];
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
  exports?: unknown;
}

const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as Manifest;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(PKG, full).split('\\').join('/'));
  }
  return out;
}

const PACKAGE_FILES = walk(PKG);

/** Sources vitest runs and esbuild strips the types from — the surface no build ever compiles. */
const TEST_SOURCES = PACKAGE_FILES.filter(
  (f) => f.endsWith('.test.ts') || (f.startsWith('test/') && f.endsWith('.ts')),
);

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('/')
    .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
    .replace(/\/\.\*\//g, '/(?:.*/)?');
  return new RegExp(`^${body}$`);
}

/** Every tsconfig in this package whose `include` covers all of {@link TEST_SOURCES}. */
function configsCoveringTests(): string[] {
  return PACKAGE_FILES.filter((f) => /^tsconfig[\w.]*\.json$/.test(f)).filter((f) => {
    const include = (JSON.parse(readFileSync(join(PKG, f), 'utf8')) as { include?: string[] })
      .include;
    const patterns = (include ?? []).map(globToRegExp);
    return TEST_SOURCES.every((src) => patterns.some((p) => p.test(src)));
  });
}

/** Script names CI runs across every workspace — the only ones a package's script can be reached by. */
const CI_WORKSPACE_SCRIPTS = [
  ...readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8').matchAll(
    /npm run ([\w:-]+) --workspaces/g,
  ),
].map((m) => m[1] as string);

describe('every source in this package is inside some tsconfig', () => {
  it('there are test sources to cover, and CI has workspace-wide scripts to reach them by', () => {
    expect(TEST_SOURCES.length).toBeGreaterThan(10);
    expect(CI_WORKSPACE_SCRIPTS.length).toBeGreaterThan(0);
  });

  it('a tsconfig here includes the test sources', () => {
    expect(
      configsCoveringTests(),
      'the test sources are outside every tsconfig, so no compiler ever sees them',
    ).not.toEqual([]);
  });

  it('a script CI invokes across the workspaces runs that tsconfig', () => {
    const scripts = Object.entries(manifest.scripts ?? {});
    const covering = configsCoveringTests();
    const wired = scripts.filter(
      ([name, body]) =>
        CI_WORKSPACE_SCRIPTS.includes(name) && covering.some((cfg) => body.includes(cfg)),
    );
    expect(
      wired.map(([name]) => name),
      `declare one of ${CI_WORKSPACE_SCRIPTS.join(' / ')} running ${covering.join(' / ')}, or CI checks nothing`,
    ).not.toEqual([]);
  });
});

/** Paths the manifest promises a consumer can resolve, wherever they are nested. */
function promisedPaths(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' && node.startsWith('./')) out.push(node);
  else if (Array.isArray(node)) for (const v of node) promisedPaths(v, out);
  else if (node !== null && typeof node === 'object') {
    for (const v of Object.values(node)) promisedPaths(v, out);
  }
  return out;
}

const PROMISED = [
  ...new Set([
    ...promisedPaths(manifest.exports),
    ...promisedPaths(Object.values(manifest.bin ?? {})),
  ]),
];

/** Would `files` put this path in the tarball? */
function packed(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return (manifest.files ?? []).some(
    (f) => p === f.replace(/^\.\//, '') || p.startsWith(`${f.replace(/^\.\//, '').replace(/\/$/, '')}/`),
  );
}

/** The source a `dist/` artifact is built from, so a promise nothing can build is caught unbuilt. */
function sourceOf(path: string): string {
  return path
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$|\.js$/, '.ts');
}

describe('the published tarball carries everything the manifest promises', () => {
  it('the manifest promises paths, so the rules below are not vacuous', () => {
    expect(PROMISED.length).toBeGreaterThan(0);
  });

  it.each(PROMISED)('%s is inside the "files" list', (path) => {
    expect(packed(path), `add a "files" entry covering ${path}, or the tarball cannot resolve it`).toBe(
      true,
    );
  });

  it.each(PROMISED)('%s has a source that builds it', (path) => {
    expect(existsSync(join(PKG, sourceOf(path))), `nothing builds ${path}`).toBe(true);
  });
});
