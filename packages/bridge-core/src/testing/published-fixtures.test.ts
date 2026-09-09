import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: a module parked under a PUBLISHED directory that nothing published reaches. `files:
 * ["dist"]` uploads whatever tsc emitted, so seven of this directory's eleven modules were core's
 * own internal helpers riding to npm inside a describe titled "every public workspace ships only
 * what a consumer can run" — and the barrel's own doc block justified banning every symbol under
 * here from the root barrel with "they ship from the ./testing subpath instead", which was true of
 * four of about thirty names.
 *
 * They now live under `src/test-support/`, which the build excludes. This keeps that split true by
 * walking the EXPORT GRAPH: a module under `src/testing/` that the subpath barrel cannot reach is
 * either something a consumer is meant to import — and then the barrel should say so — or
 * internal, and belongs where the tarball does not carry it.
 */
const DIR = fileURLToPath(new URL('./', import.meta.url));
const BARREL = 'index.ts';

const isModule = (name: string): boolean =>
  name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');

const specifiers = (text: string): string[] =>
  [...text.matchAll(/\bfrom\s*'(\.[^']*)'/g)].map((m) => (m[1] as string).replace(/\.js$/, '.ts'));

function reachable(): Set<string> {
  const seen = new Set<string>([BARREL]);
  const walk = (file: string): void => {
    for (const spec of specifiers(readFileSync(`${DIR}${file}`, 'utf8'))) {
      const name = spec.replace(/^\.\//, '');
      if (name.includes('/') || seen.has(name)) continue;
      seen.add(name);
      walk(name);
    }
  };
  walk(BARREL);
  return seen;
}

describe('src/testing publishes only what its barrel reaches', () => {
  const modules = readdirSync(DIR).filter(isModule);

  it('finds modules and a barrel that reaches some of them, so the row below is not vacuous', () => {
    expect(modules).toContain(BARREL);
    expect(modules.length).toBeGreaterThan(1);
    expect([...reachable()].length).toBeGreaterThan(1);
  });

  it.each(modules)('%s is reachable from the barrel', (module) => {
    expect(
      reachable().has(module),
      `${module} is under a PUBLISHED directory and nothing the barrel exports reaches it, so it ` +
        'ships to npm as unreachable code. Move it to src/test-support/, or export it here',
    ).toBe(true);
  });
});
