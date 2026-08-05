/**
 * CLAUDE.md puts review history and alternatives-considered prose in the COMMIT message: a comment
 * that argues with a reviewer rots against the code and cannot be read where a reader looks for
 * history. A comment earns its place only by warning about a risk.
 *
 * Only what is STRICTER than the repo-wide lint is here. Tracker and issue tags are graded for
 * every package by `bridge-core/src/source-hygiene.test.ts`; what remains is prose that ARGUES a
 * choice is safe rather than warning about a risk, and prose DUPLICATED from the README, where the
 * copy rots independently of the original.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Every `.ts` under `dir` at ANY depth, so a new subdirectory is a linted row the day it appears. */
const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .map((f) => f.split(sep).join('/'))
    .filter((f) => f.endsWith('.ts'));

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const README = fileURLToPath(new URL('../README.md', import.meta.url));

/** Each pattern is a shape of comment that belongs in a commit message instead. */
const BANNED = [
  { name: 'a rejected alternative', re: /\b(instead would|would have been|we chose|rather than doing)\b/i },
  { name: 'a note addressed to a reviewer', re: /\b(reviewer|as (?:discussed|requested)|per review)\b/i },
  {
    name: 'an argument that the code is safe rather than a warning about a risk',
    re: /\b(stays safe|is safe because|only ever|is mutable because|no risk|perfectly (?:safe|fine))\b/i,
  },
];

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

function commentLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  source.split('\n').forEach((raw, i) => {
    const text = raw.trim();
    if (inBlock) {
      out.push({ line: i + 1, text });
      if (text.includes('*/')) inBlock = false;
      return;
    }
    if (text.startsWith('/*')) {
      out.push({ line: i + 1, text });
      if (!text.includes('*/')) inBlock = true;
      return;
    }
    if (text.startsWith('//')) out.push({ line: i + 1, text });
  });
  return out;
}

describe('zulip source comments carry risks, not history', () => {
  const files = sourcesUnder(SRC);

  it('finds the package source to lint', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    for (const banned of BANNED) {
      it(`${file} has no comment carrying ${banned.name}`, () => {
        const offenders = commentLines(readFileSync(`${SRC}${file}`, 'utf8'))
          .filter((c) => banned.re.test(c.text))
          .map((c) => `${file}:${c.line}: ${c.text}`);
        expect(offenders).toEqual([]);
      });
    }

    it(`${file} has no comment prose duplicated from the README`, () => {
      const comments = normalize(
        commentLines(readFileSync(`${SRC}${file}`, 'utf8'))
          .map((c) => c.text)
          .join(' '),
      );
      const readme = runs(normalize(readFileSync(README, 'utf8')), MAX_SHARED_RUN);
      const shared = [...runs(comments, MAX_SHARED_RUN)].filter((r) => readme.has(r));
      expect(shared).toEqual([]);
    });
  }
});

/**
 * The walk against a tree built to defeat a flat one — run through the SAME function the lint runs
 * through, never a second listing typed out here. A `readdirSync(SRC)` that does not recurse keeps
 * passing the day this package grows an `src/` subdirectory, and a `files.length > 0` guard cannot
 * tell that from a full scan.
 */
describe('the lint sees every source file, at every depth', () => {
  it('descends into subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'zulip-lint-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'deep.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'shallow.ts'), 'export const y = 1;\n');
    writeFileSync(join(root, 'notes.md'), 'not a source\n');
    expect(sourcesUnder(root).sort()).toEqual(['a/b/deep.ts', 'shallow.ts']);
    rmSync(root, { recursive: true, force: true });
  });
});
