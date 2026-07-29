import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Class 1: coverage that removes itself when its dependency is absent. CI's gate only fails a test
// file where EVERY assertion skipped, so a file that mixes always-running fake-backed tests with a
// server-gated block loses the gated half — the highest-value tests in the package — under a green
// tick. Server-gated tests therefore live in files that hold nothing else.
// Class 2: a comment that narrates history instead of warning about a risk. CLAUDE.md: rationale
// and tracker IDs belong in the commit message, where they cannot rot against the code.
const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', 'src');

const POLICY_FILE = 'hygiene.test.ts';

const testFiles = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts') && f !== POLICY_FILE)
  .map((f) => ({ name: f, source: readFileSync(join(here, f), 'utf8') }));

const srcFiles = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, source: readFileSync(join(srcDir, f), 'utf8') }));

describe('nats test hygiene — a gated file must not carry ungated coverage', () => {
  it('finds the test files it is meant to police', () => {
    expect(testFiles.length).toBeGreaterThan(5);
    expect(testFiles.some((f) => /isNatsUp/.test(f.source))).toBe(true);
  });

  for (const file of testFiles) {
    it(`${file.name} either gates every test or gates none`, () => {
      const gated = /isNatsUp|describe\.skip|it\.skip|test\.skip|skipIf/.test(file.source);
      const topLevel = file.source.match(/^(describe|it|test)(\.each)?\(/gm) ?? [];
      const ungated = gated ? topLevel : [];

      expect({ file: file.name, ungated }).toEqual({ file: file.name, ungated: [] });
    });
  }
});

const trackerIds = /\b(BUG|SEC|CX|FIX)-\d+\b|\bissues?\s*#\d+/i;
const stringLiterals = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

/** Every comment in `source`, trailing ones included — a `// (BUG-01)` tail is the common shape. */
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

describe('nats comment discipline — comments warn, they do not narrate history', () => {
  it('finds the comments it is meant to police', () => {
    const all = srcFiles.flatMap((f) => comments(f.source));
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((c) => c.text.includes('so that'))).toBe(true);
  });

  for (const file of srcFiles) {
    it(`${file.name} cites no tracker ID in a comment`, () => {
      expect(comments(file.source).filter((c) => trackerIds.test(c.text))).toEqual([]);
    });
  }
});
