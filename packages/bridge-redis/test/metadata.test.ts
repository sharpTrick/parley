import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// CLASS: shipped npm metadata must match the dependency graph. A dependency nothing imports still
// lands in every install of this package's tarball and contradicts what both packages' npm pages
// claim about each other; an import with no declared dependency breaks on a clean install.

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

const srcDir = new URL('../src/', import.meta.url);
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL(f, srcDir), 'utf8'));

/** Bare package specifiers imported by src (`node:` builtins and relative paths excluded). */
function importedPackages(): Set<string> {
  const found = new Set<string>();
  for (const text of sources) {
    // Anchored at an `import` statement, so prose that merely says `from "…"` in a comment is not
    // mistaken for a dependency.
    for (const m of text.matchAll(/(?:^|\n)\s*import\b[^;]*?['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? '';
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
    }
  }
  return found;
}

describe('bridge-redis package metadata matches the dependency graph', () => {
  const declared = Object.keys(manifest.dependencies ?? {});
  const imported = importedPackages();

  it.each(declared)('%s is actually imported by src', (dep) => {
    expect(imported.has(dep)).toBe(true);
  });

  it.each([...imported])('%s is declared as a dependency', (pkg) => {
    expect(declared).toContain(pkg);
  });
});
