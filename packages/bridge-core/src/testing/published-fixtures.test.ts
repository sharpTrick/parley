import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivedRows } from '@sharptrick/parley-net-util/testing';
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

/**
 * The walk descends, in both directions. A flat listing and a walker that skipped any specifier
 * carrying a `/` agreed with each other about a directory that happened to be flat, and a module
 * one level down — `orphan/helper.ts` — was invisible to the listing AND unreachable through the
 * barrel, so the four rows stayed green while the class this file exists to catch shipped.
 */
function reachable(dir: string = DIR): Set<string> {
  const seen = new Set<string>([BARREL]);
  const walk = (file: string): void => {
    for (const spec of specifiers(readFileSync(`${dir}${file}`, 'utf8'))) {
      const name = posix.normalize(posix.join(posix.dirname(file), spec));
      if (name.startsWith('..') || seen.has(name)) continue;
      seen.add(name);
      walk(name);
    }
  };
  walk(BARREL);
  return seen;
}

describe('src/testing publishes only what its barrel reaches', () => {
  const modules = derivedRows(
    'every module under src/testing',
    () => readdirSync(DIR, { recursive: true }).map(String).map((f) => f.split(sep).join('/')).filter(isModule),
    { floor: 2, witness: [BARREL, 'failure-shapes.ts'] },
  );

  it('finds a barrel that reaches some of them, so the row below is not vacuous', () => {
    expect(modules).toContain(BARREL);
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

/**
 * Both halves of the walk on a planted tree, because the shape that shipped is the one no longer on
 * disk to catch: a module the barrel reaches THROUGH a subdirectory, and one nested beside it that
 * nothing reaches.
 */
describe('the reachability walk on a planted tree', () => {
  it('follows a specifier with a slash in it, and stops at what nothing imports', () => {
    const root = `${mkdtempSync(join(tmpdir(), 'published-fixtures-'))}/`;
    mkdirSync(`${root}nested`, { recursive: true });
    writeFileSync(`${root}${BARREL}`, "export { used } from './nested/used.js';\n");
    writeFileSync(`${root}nested/used.ts`, "export { deeper } from './deeper.js';\n");
    writeFileSync(`${root}nested/deeper.ts`, 'export const deeper = 1;\n');
    writeFileSync(`${root}nested/orphan.ts`, 'export const orphan = 1;\n');
    expect([...reachable(root)].sort()).toEqual([BARREL, 'nested/deeper.ts', 'nested/used.ts']);
  });
});
