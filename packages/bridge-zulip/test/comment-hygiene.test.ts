import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentaryLines, derivedRows, filesUnder } from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';

/**
 * One rule about this package's source that the repo-wide lints do not carry. The banned PHRASINGS
 * this file used to hold — a rejected alternative, a note addressed to a reviewer, an argument that
 * the code is safe — are graded for every package by `bridge-core/src/source-hygiene.test.ts`; a
 * copy here would be a second implementation of one rule, with its own universe to fall behind in.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/**
 * A duplicated stretch this long is prose that was moved, not a phrase two authors landed on: the
 * `ONE INEXACTNESS` block ran to 20 shared words against the README, while the longest incidental
 * overlap left in the source is 10.
 */
const MAX_SHARED_RUN = 12;

const normalize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

const runs = (words: string[], n: number): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
};

const sharedWithReadme = (source: string, readme: string): string[] => {
  const inReadme = runs(normalize(readme), MAX_SHARED_RUN);
  return [...runs(normalize(commentaryLines(source).join(' ')), MAX_SHARED_RUN)].filter((r) =>
    inReadme.has(r),
  );
};

describe('no comment restates the README', () => {
  const TWELVE = 'the cursor is opaque to core and is never ordered or deduped on a timestamp';

  it('reads a moved paragraph, and leaves an incidental overlap alone', () => {
    expect(sharedWithReadme(`// ${TWELVE}\n`, `prose ${TWELVE} prose`)).not.toEqual([]);
    expect(sharedWithReadme('// the cursor is opaque to core\n', `prose ${TWELVE} prose`)).toEqual([]);
    expect(sharedWithReadme(`const s = '${TWELVE}';\n`, `prose ${TWELVE} prose`)).toEqual([]);
  });

  const files = derivedRows(
    'every zulip source module',
    () => filesUnder(SRC).map((f) => [relative(SRC, f), f] as const),
    { floor: 5, witness: ['index.ts', 'http.ts'] },
  );

  it.each(files)('%s carries no prose lifted from the README', (_name, file) => {
    expect(
      sharedWithReadme(readFileSync(file, 'utf8'), README),
      'this paragraph lives in the README; a second copy in a comment drifts against it',
    ).toEqual([]);
  });
});
