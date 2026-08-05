import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NODE_SQLITE_MIN } from '../src/driver.js';

/**
 * What ships to npm is decided by `files` + the tsconfig's emit set, both of which are easy to
 * widen by accident. A consumer install must not carry test code (each file imports `vitest`, a
 * devDependency that will not resolve there) and must carry the license the manifest declares.
 */

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const tsconfig = JSON.parse(readFileSync(join(pkgDir, 'tsconfig.json'), 'utf8')) as {
  include?: string[];
  exclude?: string[];
};
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  license?: string;
  files?: string[];
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function sourcesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(pkgDir, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourcesUnder(join(dir, e.name), `${prefix}${e.name}/`)
      : [`${prefix}${e.name}`],
  );
}

/** Mirrors tsc's `include`/`exclude` for the only pattern shape this package uses. */
function emittedFrom(rootDir: string): string[] {
  const excluded = (tsconfig.exclude ?? []).map((p) => p.replace(`${rootDir}/**/`, ''));
  return sourcesUnder(rootDir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !excluded.some((p) => matches(f, p)));
}

function matches(file: string, pattern: string): boolean {
  const rx = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`);
  return rx.test(file.split('/').at(-1) ?? file);
}

describe('published tarball hygiene', () => {
  it('no test source is compiled into the published output', () => {
    const emitted = emittedFrom('src');
    expect(emitted.filter((f) => /\.(test|spec)\.ts$/.test(f))).toEqual([]);
    expect(emitted.length).toBeGreaterThan(0);
  });

  const shippedSources = sourcesUnder('src').filter(
    (f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f),
  );
  const readSource = (f: string): string => readFileSync(join(pkgDir, 'src', f), 'utf8');

  /**
   * A lazy `require()` is this package's whole degraded-mode story: every third-party module
   * reached that way is one it is willing to run WITHOUT, falling back to the `node:` builtin. A
   * hard `dependencies` entry makes that fallback unreachable through the manifest — npm treats a
   * failing install script on a non-optional dependency as fatal, so an install with no prebuilt
   * binary and no toolchain aborts before a line of plugin code runs, and the README's graceful
   * path is a promise only an already-working install can keep.
   *
   * Scanned across every shipped source rather than the one file that happens to hold the loader
   * today, so that moving or adding a lazy `require()` cannot carry the check away with it.
   */
  const FALLBACK_FROM = [
    ...new Set(
      shippedSources.flatMap((f) =>
        [...readSource(f).matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] as string),
      ),
    ),
  ].filter((id) => !id.startsWith('node:'));

  it('the package loads at least one module it can fall back from', () => {
    expect(FALLBACK_FROM.length).toBeGreaterThan(0);
  });

  for (const mod of FALLBACK_FROM) {
    it(`${mod} is an optionalDependency, so a failed native install is survivable`, () => {
      expect(Object.keys(manifest.optionalDependencies ?? {})).toContain(mod);
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(mod);
    });
  }

  /**
   * `engines` is what npm installs against, and this package reaches for a `node:` builtin that is
   * NEWER than the runtime floor every other package here declares. A floor below the builtin
   * admits an install where the optional native module was skipped and the advertised fallback
   * cannot exist — the manifest promising a runtime the degraded path cannot run on.
   *
   * A specifier absent from this table fails rather than defaulting to "ancient": deciding a
   * builtin's floor is the check, and `node:sqlite` outran the manifest once already.
   */
  const BUILTIN_SINCE: Record<string, string> = {
    'node:child_process': '0.0.0',
    'node:crypto': '0.0.0',
    'node:fs': '0.0.0',
    'node:module': '0.0.0',
    'node:os': '0.0.0',
    'node:path': '0.0.0',
    'node:process': '0.0.0',
    'node:sqlite': NODE_SQLITE_MIN,
    'node:url': '0.0.0',
  };

  const BUILTINS_USED = [
    ...new Set(
      shippedSources.flatMap((f) =>
        [...readSource(f).matchAll(/['"](node:[a-z_/]+)['"]/g)].map((m) => m[1] as string),
      ),
    ),
  ].sort();

  const cmp = (a: string, b: string): number => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  it('the manifest declares a runtime floor at all', () => {
    expect(BUILTINS_USED.length).toBeGreaterThan(0);
    expect(manifest.engines?.node).toMatch(/^>=\s*\d+\.\d+\.\d+$/);
  });

  for (const builtin of BUILTINS_USED) {
    it(`engines.node is not below the Node that introduced ${builtin}`, () => {
      const since = BUILTIN_SINCE[builtin];
      expect(since, `no known introduction version for ${builtin} — add one`).toBeDefined();
      const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(manifest.engines?.node ?? '')?.[1];
      expect(floor).toBeDefined();
      expect(cmp(floor as string, since as string), `${floor} must be >= ${since}`).toBeGreaterThanOrEqual(0);
    });
  }

  it('every already-built artifact in dist is publishable', () => {
    if (!existsSync(join(pkgDir, 'dist'))) return;
    const built = sourcesUnder('dist');
    expect(built.filter((f) => /\.(test|spec)\./.test(f))).toEqual([]);
    for (const f of built.filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(join(pkgDir, 'dist', f), 'utf8')).not.toMatch(/from ['"]vitest['"]/);
    }
  });
});
