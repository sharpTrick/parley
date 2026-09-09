import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  derivedRows,
  filesUnder,
  importsIn,
  withoutComments,
} from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';

/**
 * A binding this package's source never reads is dead, and nothing else catches it:
 * `tsconfig.base.json` sets neither `noUnusedLocals` nor `noUnusedParameters`, and no ESLint or
 * Biome is configured.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const sources = derivedRows(
  'every matrix source module',
  () => filesUnder(SRC).map((f) => [relative(SRC, f), f] as const),
  { floor: 5, witness: ['index.ts', 'config.ts'] },
);

/**
 * A reference whose only purpose is to keep a binding alive. It reads as a use to every scan the
 * repo has, and to a reader it says nothing about why the binding is kept.
 */
const DEAD_REFERENCE = /^\s*void\s+[A-Za-z_$][\w$]*\s*;\s*$/;

/**
 * CLASS: a dead symbol must fail a check, not a reviewer's grep. An import nothing references
 * survives every gate this repo has — `tsconfig.base.json` sets neither `noUnusedLocals` nor
 * `noUnusedParameters`, and no ESLint/Biome is configured — while reading as a live dependency of
 * the code beside it, which invites a second, divergent implementation of what the real one owns.
 */
const IMPORT_SPAN = /\bimport\s+[\s\S]*?\s+from\s+['"][^'"]*['"];?/g;

const unusedImports = (source: string): string[] => {
  const body = withoutComments(source).replaceAll(IMPORT_SPAN, '');
  return importsIn(source)
    .flatMap((binding) => binding.names)
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
};

describe('no matrix source keeps a binding nothing reads', () => {
  it.each([
    ['a reference kept alive by `void`', '    void identity;', true],
    ['a call', 'void loop();', false],
    ['a method call', '    void this.pollBoundedSync(roomId, topic);', false],
  ])('reads %s', (_label, line, dead) => {
    expect(DEAD_REFERENCE.test(line)).toBe(dead);
  });

  it.each([
    ['a name bound and never read', "import { used, dead, other as alias } from 'x';\nconst a = used(alias);\n", ['dead']],
    ['a type used in a position', "import type { T } from 'x';\nlet a: T;\n", []],
    ['a namespace that is read', "import * as ns from 'x';\nns.f();\n", []],
    ['a namespace that is not', "import * as ns from 'x';\n", ['ns']],
    ['a name referenced only in a comment', "import { dead } from 'x';\n// dead is described here\n", ['dead']],
  ])('reads %s', (_label, source, unused) => {
    expect(unusedImports(source)).toEqual(unused);
  });

  it.each(sources)('%s references what it imports, and voids nothing', (
    name,
    file,
  ) => {
    const source = readFileSync(file, 'utf8');
    expect(
      source.split('\n').filter((line) => DEAD_REFERENCE.test(line)),
      `${name} keeps a binding alive with a bare \`void\` — say why the binding is kept, or drop it`,
    ).toEqual([]);
    expect(unusedImports(source), `${name} binds an import nothing references`).toEqual([]);
  });
});
