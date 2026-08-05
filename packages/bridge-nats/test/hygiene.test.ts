import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Class: a shared fixture module exists and a file bypasses it. The gate and the stream cleanup
// are the fixtures most often re-typed, and they are exactly the ones whose drift is invisible: a
// gate tightened in one copy leaves the other files admitting a server the suite can no longer
// use, under a green tick. Checked against whatever helpers.ts exports today, not a fixed list.
/** Every `.ts` under `dir` at ANY depth, so a new subdirectory is a linted row the day it appears. */
const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .map((f) => f.split(sep).join('/'))
    .filter((f) => f.endsWith('.ts'));

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', 'src');

const POLICY_FILE = 'hygiene.test.ts';

const helperModules = ['helpers.ts', 'fake-jetstream.ts', 'tcp-proxy.ts'];

const exportsOf = (source: string): string[] => [
  ...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm),
].map((m) => m[1] as string);

const shared = helperModules.flatMap((name) =>
  exportsOf(readFileSync(join(here, name), 'utf8')).map((symbol) => ({ symbol, from: name })),
);

const testFiles = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts') && f !== POLICY_FILE)
  .map((f) => ({ name: f, source: readFileSync(join(here, f), 'utf8') }));

const srcFiles = sourcesUnder(srcDir).map((f) => ({
  name: f,
  source: readFileSync(join(srcDir, f), 'utf8'),
}));

describe('nats test hygiene — one shared fixture, not a copy per file', () => {
  it('finds the test files it is meant to police', () => {
    expect(testFiles.length).toBeGreaterThan(5);
    expect(testFiles.some((f) => /isNatsUp/.test(f.source))).toBe(true);
  });

  it('finds the shared fixtures it is meant to police', () => {
    expect(shared.map((s) => s.symbol)).toContain('isNatsUp');
    expect(shared.map((s) => s.symbol)).toContain('dropStreams');
    expect(shared.length).toBeGreaterThan(8);
  });

  for (const file of testFiles) {
    it(`${file.name} imports the shared fixtures instead of re-declaring them`, () => {
      const redeclared = shared
        .filter(({ symbol }) =>
          new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|class)\\s+${symbol}\\b`, 'm').test(
            file.source,
          ),
        )
        .map(({ symbol, from }) => `${symbol} (already in ${from})`);

      expect({ file: file.name, redeclared }).toEqual({ file: file.name, redeclared: [] });
    });
  }
});

const stringLiterals = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

/** Every comment in `source`, trailing ones included — a tail on a code line is the usual shape. */
function comments(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let inBlock = false;
  source.split('\n').forEach((raw, i) => {
    const bare = raw.replace(stringLiterals, '""');
    const entry = { line: i + 1, text: raw.trim() };
    if (inBlock) {
      found.push(entry);
      if (bare.includes('*/')) inBlock = false;
      return;
    }
    const block = bare.indexOf('/*');
    if (block >= 0) {
      found.push(entry);
      inBlock = !bare.includes('*/', block);
      return;
    }
    if (bare.includes('//')) found.push(entry);
  });
  return found;
}

// Tracker IDs are graded for every package by `bridge-core/src/source-hygiene.test.ts`; what is
// kept here is the evidence that this package HAS the commentary that rule is applied to.
describe('nats comment discipline — comments warn, they do not narrate history', () => {
  it('finds the comments it is meant to police', () => {
    const all = srcFiles.flatMap((f) => comments(f.source));
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((c) => c.text.includes('so that'))).toBe(true);
  });
});

/**
 * The walk against a tree built to defeat a flat one — run through the SAME function the lint runs
 * through, never a second listing typed out here. A `readdirSync(SRC)` that does not recurse keeps
 * passing the day this package grows an `src/` subdirectory, and a `files.length > 0` guard cannot
 * tell that from a full scan.
 */
describe('the lint sees every source file, at every depth', () => {
  it('descends into subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'nats-lint-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'deep.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'shallow.ts'), 'export const y = 1;\n');
    writeFileSync(join(root, 'notes.md'), 'not a source\n');
    expect(sourcesUnder(root).sort()).toEqual(['a/b/deep.ts', 'shallow.ts']);
    rmSync(root, { recursive: true, force: true });
  });
});
