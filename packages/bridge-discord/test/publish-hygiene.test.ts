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

  it('every already-built artifact in dist is publishable', () => {
    if (!existsSync(join(pkgDir, 'dist'))) return;
    const built = sourcesUnder('dist');
    expect(built.filter((f) => /\.(test|spec)\./.test(f))).toEqual([]);
    for (const f of built.filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(join(pkgDir, 'dist', f), 'utf8')).not.toMatch(/from ['"]vitest['"]/);
    }
  });
});
