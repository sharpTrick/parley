import { readFileSync } from 'node:fs';

/**
 * The published package version, read from `package.json` at runtime. The release pipeline
 * (`scripts/stamp-version.mjs`) stamps only `package.json` versions, never `.ts` source — so a
 * hardcoded constant would drift on the first bump. Reading it here keeps it accurate: `dist/`
 * sits one level under the package root, so `../package.json` resolves to the (stamped) manifest,
 * which npm always ships. Kept in its own module so `index` ⇄ `transport` can both import it
 * without an import cycle.
 */
export const CORE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
