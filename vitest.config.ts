import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve @parley/* to each package's TypeScript source so unit/conformance tests
// run against source with no pre-build. (The forked multi-process write test and the
// manual channel loop are the only things that need `npm run build` first.)
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@parley/core': fromHere('./packages/bridge-core/src/index.ts'),
      '@parley/conformance': fromHere('./packages/conformance/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'examples/**/*.test.ts'],
    // SQLite file locks + poll loops want a little headroom over the default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
