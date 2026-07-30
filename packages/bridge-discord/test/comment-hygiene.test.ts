/**
 * CLAUDE.md puts review history, tracker IDs and alternatives-considered prose in the COMMIT
 * message: a comment that argues with a reviewer or cites a finding rots against the code and
 * cannot be read where a reader looks for history. A comment earns its place only by warning about
 * a risk. This lints the package's own source, as a FLOOR under that rule — a shape nobody thought
 * to list still gets in, so the list grows whenever one is found.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Each pattern is a shape of comment that belongs in a commit message instead, paired with an
 * example of that shape. The example is fed through the SAME matcher below and asserted to be
 * refused, so a pattern that can only match phrasings nobody writes cannot masquerade as coverage.
 */
const BANNED: Array<{ name: string; re: RegExp; example: string }> = [
  {
    name: 'a tracker or finding ID',
    re: /\b(BUG|SEC|ISSUE|FINDING|TICKET)[-\s]?\d+\b/i,
    example: '// TICKET-4 asked for this clamp.',
  },
  {
    name: 'an issue reference',
    re: /\bissues?\s*#\d+\b/i,
    example: '// tracked in issues #12 and #13.',
  },
  {
    name: 'a rejected alternative',
    re: /\b(instead would|would have been|we chose|rather than doing)\b/i,
    example: '// we chose a Set here; a scan would have been simpler.',
  },
  {
    name: 'a note addressed to a reviewer',
    re: /\b(reviewer|as (?:discussed|requested)|per review)\b/i,
    example: '// as discussed with the reviewer, this stays.',
  },
  {
    name: 'a comparison to an earlier revision',
    re: /\b(used to|previously|for historical reasons|before this change|as before|we now)\b/i,
    example: '// this used to be a plain number; previously we packed it by hand.',
  },
  {
    name: 'a measurement',
    re: /\b(was measured at|benchmarked at|measured \d+\s*(ms|s)\b)/i,
    example: '// was measured at 4ms against the fixture.',
  },
];

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

const offendersIn = (source: string, re: RegExp): Array<{ line: number; text: string }> =>
  commentLines(source).filter((c) => re.test(c.text));

describe('discord source comments carry risks, not history', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it('finds the package source to lint', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    for (const banned of BANNED) {
      it(`${file} has no comment carrying ${banned.name}`, () => {
        const offenders = offendersIn(readFileSync(`${SRC}${file}`, 'utf8'), banned.re).map(
          (c) => `${file}:${c.line}: ${c.text}`,
        );
        expect(offenders).toEqual([]);
      });
    }
  }
});

describe('the comment lint can actually fire', () => {
  // A predicate that never matches real input is worse than no guard: every row above passes, and
  // the suite reads as coverage of a class it cannot see. These are the negative controls.
  for (const banned of BANNED) {
    it(`refuses ${banned.name}`, () => {
      expect(
        offendersIn(banned.example, banned.re),
        'the example of this shape is not matched by its own pattern',
      ).toHaveLength(1);
    });
  }

  it('accepts a comment that states a risk', () => {
    const risk = '// Keep the busy timeout, so that a concurrent writer retries instead of erroring.';
    expect(BANNED.filter((b) => b.re.test(risk)).map((b) => b.name)).toEqual([]);
  });

  it('ignores banned prose that is code rather than a comment', () => {
    expect(offendersIn('const note = "we chose a Set";', /\bwe chose\b/i)).toEqual([]);
  });
});
