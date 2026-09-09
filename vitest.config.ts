import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve @sharptrick/parley-* to each package's TypeScript source so unit/conformance tests
// run against source with no pre-build. A test that instead executes a compiled entrypoint must
// build it itself and verify the artifact is newer than its sources, so that it cannot pass
// against a stale `dist/` (packages/bridge-sqlite/src/cli.test.ts is the worked example).
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Derive this from each package's own `exports` map rather than hand-listing it, so that a package
 * or a SUBPATH missing from the table cannot resolve through the workspace symlink and have its
 * tests grade a stale `dist/` build.
 *
 * EVERY entry is an anchored RegExp over the fully-escaped specifier. A vite STRING alias matches by
 * PREFIX, so `<pkg>/testing` left as a string rewrites `<pkg>/testing/anything` to
 * `<pkg>/src/testing/index.ts/anything` — a resolution failure with no message that names the
 * alias. Escaping every regex metacharacter matters for the same reason: a package name carries a
 * `/` and a `-`, and escaping only the first `/` leaves the rest of the pattern unanchored.
 */
export function packageAliases(): { find: RegExp; replacement: string }[] {
  const root = new URL('./packages/', import.meta.url);
  const out: { find: RegExp; replacement: string }[] = [];
  for (const dir of readdirSync(root)) {
    const manifest = new URL(`${dir}/package.json`, root);
    const { name, exports } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string;
      exports?: Record<string, { default?: string } | string>;
    };
    for (const [subpath, target] of Object.entries(exports ?? {})) {
      if (subpath === './package.json') continue;
      const dist = typeof target === 'string' ? target : target.default;
      if (dist === undefined) continue;
      const src = dist.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts');
      const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`;
      out.push({
        find: new RegExp(`^${specifier.replaceAll(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}$`),
        replacement: fromHere(`./packages/${dir}/${src.slice(2)}`),
      });
    }
  }
  return out;
}

export default defineConfig({
  resolve: {
    alias: packageAliases(),
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'examples/**/*.test.ts'],
    // `zz-` is the reserved prefix for a throwaway probe written inside a package while
    // investigating it by hand. Keep it excluded, so that a scratch file cannot silently join the
    // real suite just because it ends in `.test.ts`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/zz-*.test.ts'],
    // SQLite file locks + poll loops want a little headroom over the default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
