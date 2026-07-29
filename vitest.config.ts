import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve @sharptrick/parley-* to each package's TypeScript source so unit/conformance tests
// run against source with no pre-build. (The forked multi-process write test and the
// manual channel loop are the only things that need `npm run build` first.)
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Derive this from `packages/` rather than hand-listing it, so that a package missing from the map
 * cannot resolve through the workspace symlink and have its tests grade a stale `dist/` build.
 */
function packageAliases(): Record<string, string> {
  const root = new URL('./packages/', import.meta.url);
  const out: Record<string, string> = {};
  for (const dir of readdirSync(root)) {
    const manifest = new URL(`${dir}/package.json`, root);
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string };
    out[name] = fromHere(`./packages/${dir}/src/index.ts`);
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
