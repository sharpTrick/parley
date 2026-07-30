import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('a declared license ships with the package', () => {
    if (manifest.license === undefined) return;
    expect(existsSync(join(pkgDir, 'LICENSE'))).toBe(true);
  });

  /**
   * `driver.ts` is the whole of this package's degraded-mode story: every third-party module it
   * loads is one it is willing to run WITHOUT, falling back to the `node:` builtin. A hard
   * `dependencies` entry makes that fallback unreachable through the manifest — npm treats a
   * failing install script on a non-optional dependency as fatal, so an install with no prebuilt
   * binary and no toolchain aborts before a line of plugin code runs, and the README's graceful
   * path is a promise only an already-working install can keep.
   */
  const driverSource = readFileSync(join(pkgDir, 'src', 'driver.ts'), 'utf8');
  const FALLBACK_FROM = [...driverSource.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)]
    .map((m) => m[1] as string)
    .filter((id) => !id.startsWith('node:'));

  it('the driver loads at least one module it can fall back from', () => {
    expect(FALLBACK_FROM.length).toBeGreaterThan(0);
  });

  for (const mod of FALLBACK_FROM) {
    it(`${mod} is an optionalDependency, so a failed native install is survivable`, () => {
      expect(Object.keys(manifest.optionalDependencies ?? {})).toContain(mod);
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(mod);
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
