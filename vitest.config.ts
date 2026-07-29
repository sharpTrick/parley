import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve @sharptrick/parley-* to each package's TypeScript source so unit/conformance tests
// run against source with no pre-build. (The forked multi-process write test and the
// manual channel loop are the only things that need `npm run build` first.)
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * DERIVED, never hand-listed. This map used to be written out package by package, and it drifted:
 * `@sharptrick/parley-net-util` was missing, so anything importing it resolved through the
 * workspace symlink to `dist/` instead. Its tests would then have graded a stale build rather than
 * the source — a suite that passes while the code under it is broken. Scanning `packages/` means a
 * new package is aliased the moment it exists, and the failure mode cannot come back.
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
    // SQLite file locks + poll loops want a little headroom over the default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
