/**
 * CLAUDE.md puts review history, tracker IDs and alternatives-considered prose in the COMMIT
 * message: a comment that argues with a reviewer or cites a finding rots against the code and
 * cannot be read where a reader looks for history. A comment earns its place only by warning about
 * a risk. This lints the package's own source so the class cannot creep back in one line at a time.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Each pattern is a shape of comment that belongs in a commit message instead. */
const BANNED = [
  { name: 'a tracker or finding ID', re: /\b(BUG|SEC|ISSUE|FINDING|TICKET)[-\s]?\d+\b/i },
  { name: 'an issue reference', re: /\bissues?\s*#\d+\b/i },
  { name: 'a rejected alternative', re: /\b(instead would|would have been|we chose|rather than doing)\b/i },
  { name: 'a note addressed to a reviewer', re: /\b(reviewer|as (?:discussed|requested)|per review)\b/i },
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

describe('discord source comments carry risks, not history', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

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
  }
});
