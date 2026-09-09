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
 * Rules about this package's source that the repo-wide lints do not carry. Tracker tags, dated
 * prose, quoted measurements, a rejected alternative, a note to a reviewer and a comparison to an
 * earlier revision are graded for EVERY package by `bridge-core/src/source-hygiene.test.ts`; a copy
 * here would be a second implementation of one rule, with its own universe to fall behind in.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const sources = derivedRows(
  'every matrix source module',
  () => filesUnder(SRC).map((f) => [relative(SRC, f), f] as const),
  { floor: 5, witness: ['index.ts', 'config.ts'] },
);

/** Every comment block in a file: consecutive `//` lines are one block, as is each `/** … *\/`. */
function commentBlocks(source: string): string[] {
  const blocks: string[] = [];
  let line: string[] = [];
  let doc: string[] | undefined;
  for (const raw of source.split('\n')) {
    const text = raw.trim();
    if (doc !== undefined) {
      doc.push(text.replace(/^\*+\/?/, '').replace(/\*\/$/, ''));
      if (text.endsWith('*/')) {
        blocks.push(doc.join(' '));
        doc = undefined;
      }
      continue;
    }
    if (text.startsWith('/*')) {
      doc = [text.replace(/^\/\*+/, '')];
      if (text.endsWith('*/')) {
        blocks.push(doc.join(' ').replace(/\*\/$/, ''));
        doc = undefined;
      }
      continue;
    }
    if (text.startsWith('//')) {
      line.push(text.slice(2));
      continue;
    }
    if (line.length > 0) {
      blocks.push(line.join(' '));
      line = [];
    }
  }
  if (line.length > 0) blocks.push(line.join(' '));
  return blocks;
}

/** How many consecutive words make a restated rationale rather than a coincidence of phrasing. */
const SPAN_WORDS = 12;

const words = (block: string): string[] =>
  block
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** Word spans that appear in more than one comment block of the same file. */
function restatedSpans(source: string): string[] {
  const seen = new Map<string, number>();
  const repeated = new Set<string>();
  commentBlocks(source).forEach((block, blockIndex) => {
    const w = words(block);
    for (let i = 0; i + SPAN_WORDS <= w.length; i++) {
      const span = w.slice(i, i + SPAN_WORDS).join(' ');
      const first = seen.get(span);
      if (first === undefined) seen.set(span, blockIndex);
      else if (first !== blockIndex) repeated.add(span);
    }
  });
  return [...repeated];
}

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

describe('rules this package holds itself to', () => {
  it.each([
    ['a reference kept alive by `void`', '    void identity;', true],
    ['a call', 'void loop();', false],
    ['a method call', '    void this.pollBoundedSync(roomId, topic);', false],
  ])('reads %s', (_label, line, dead) => {
    expect(DEAD_REFERENCE.test(line)).toBe(dead);
  });

  it('reads a rationale restated in a second block, and not one stated once', () => {
    const twice = '// one two three four five six seven eight nine ten eleven twelve\nconst a = 1;\n';
    expect(restatedSpans(twice + twice)).toHaveLength(1);
    expect(restatedSpans(twice)).toEqual([]);
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

  it.each(sources)('%s states each rationale once, references what it imports, and voids nothing', (
    name,
    file,
  ) => {
    const source = readFileSync(file, 'utf8');
    expect(
      restatedSpans(source),
      'a rationale restated in a second comment block drifts against the first',
    ).toEqual([]);
    expect(
      source.split('\n').filter((line) => DEAD_REFERENCE.test(line)),
      `${name} keeps a binding alive with a bare \`void\` — say why the binding is kept, or drop it`,
    ).toEqual([]);
    expect(unusedImports(source), `${name} binds an import nothing references`).toEqual([]);
  });
});
