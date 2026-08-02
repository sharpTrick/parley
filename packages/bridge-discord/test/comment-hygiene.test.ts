/**
 * CLAUDE.md puts review history, tracker IDs and alternatives-considered prose in the COMMIT
 * message: a comment that argues a case or cites a finding rots against the code and cannot be read
 * where a reader looks for history. A comment earns its place only by warning about a risk.
 *
 * Two things make a lint like this decay into a green no-op, and both are graded here rather than
 * assumed. Its UNIVERSE: a walk that reads only the top level of `src/` keeps passing the day the
 * package grows a subdirectory, and a `files.length > 0` guard cannot tell that apart from a full
 * scan — so the walk is graded against a synthetic nested tree, which no later reshuffle of `src/`
 * can invalidate. Its RULES: every one declares both the comments it must flag and the comments it
 * must leave alone, so a rule that matches nothing and a rule that matches correct prose both lose
 * a case instead of reading as coverage.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Every `.ts` under `dir` at ANY depth, so a new subdirectory is a linted row the day it appears. */
const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'));

/**
 * A shape of comment that belongs in a commit message, with controls on BOTH sides: `fires` is
 * comment text this rule must flag, `passes` is comment text NO rule may flag. Both run through the
 * same matcher the package source runs through.
 */
interface Rule {
  name: string;
  re: RegExp;
  fires: string[];
  passes: string[];
}

const RULES: Rule[] = [
  {
    name: 'a tracker or finding ID',
    re: /\b(BUG|SEC|ISSUE|FINDING|TICKET)[-\s]?\d+\b/i,
    fires: [
      '// TICKET-4 asked for this clamp.',
      '// FINDING 12 says otherwise.',
      '// BUG-9 is back.',
    ],
    passes: ['// a bug in the decoder, not the encoder.', '// section 4 of the design.'],
  },
  {
    name: 'an issue reference',
    re: /\bissues?\s*#\d+\b/i,
    fires: ['// tracked in issues #12 and #13.', '// see issue #42.'],
    passes: [
      '// one issue with snowflakes: they are not lexically comparable.',
      '// posted to the #discord channel.',
    ],
  },
  {
    name: 'a rejected alternative',
    re: /\b(instead would|would have been|we chose|rather than doing)\b/i,
    fires: [
      '// we chose a Set here; a scan would have been simpler.',
      '// inlining it instead would have cost a round trip.',
    ],
    passes: [
      '// A Set, so that a redelivered id cannot cross the seam twice.',
      '// the caller chose the topic; the plugin resolves the channel.',
    ],
  },
  {
    name: 'a note addressed to a reviewer',
    re: /\b(reviewer|as (?:discussed|requested)|per review)\b/i,
    fires: ['// as discussed with the reviewer, this stays.', '// left as requested.'],
    passes: [
      '// Review the page order before trusting the cursor it yields.',
      '// as documented upstream, the page cap is 100.',
    ],
  },
  {
    /**
     * "used to" is the one shape here with an innocent sense — "the id used to namespace state" is
     * a purpose, not a history — so the rule is anchored on a subject ("this used to", "used to
     * be"). Keep the anchor, so that the lint cannot start refusing correct prose: a lint that
     * fires on what the code should say gets deleted, and the whole class goes back to unguarded.
     */
    name: 'a comparison to an earlier revision',
    re: /\b(?:(?:it|this|that|these|those|they|we)\s+used\s+to|used\s+to\s+be|previously|for historical reasons|before this change|as before|we now)\b/i,
    fires: [
      '// this used to be a plain number.',
      '// previously we packed the sequence by hand.',
      '// we now clamp the page to 100.',
      '// as before, the cursor stays opaque to core.',
      '// kept for historical reasons.',
      '// before this change the socket stayed open.',
      '// they used to share one heartbeat.',
    ],
    passes: [
      '// The instance id used to namespace per-instance read state.',
      '// `server_name`, used to build room aliases.',
      '// the cursor used to page the channel is opaque to core.',
    ],
  },
  {
    name: 'a measurement',
    re: /\b(was measured at|benchmarked at|measured \d+\s*(ms|s)\b)/i,
    fires: ['// was measured at 4ms against the fixture.', '// benchmarked at 12k frames a second.'],
    passes: [
      '// The budget is 4ms, so that a slow page cannot outlive the poll it serves.',
      '// Measure the page before trusting the cap.',
    ],
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

const firedBy = (source: string): string[] =>
  RULES.filter((rule) => offendersIn(source, rule.re).length > 0).map((rule) => rule.name);

describe('the lint sees every source file, at every depth', () => {
  it('descends into subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'parley-comment-lint-'));
    try {
      mkdirSync(join(root, 'deep', 'deeper'), { recursive: true });
      writeFileSync(join(root, 'top.ts'), '');
      writeFileSync(join(root, 'deep', 'middle.ts'), '');
      writeFileSync(join(root, 'deep', 'deeper', 'bottom.ts'), '');
      writeFileSync(join(root, 'deep', 'notes.md'), '');
      expect(
        sourcesUnder(root)
          .map((f) => f.split(sep).join('/'))
          .sort(),
        'a nested source file is invisible to the lint',
      ).toEqual(['deep/deeper/bottom.ts', 'deep/middle.ts', 'top.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds the package source to lint', () => {
    expect(sourcesUnder(SRC).length).toBeGreaterThan(0);
  });
});

describe('discord source comments carry risks, not history', () => {
  for (const file of sourcesUnder(SRC)) {
    for (const rule of RULES) {
      it(`${file} has no comment carrying ${rule.name}`, () => {
        const offenders = offendersIn(readFileSync(join(SRC, file), 'utf8'), rule.re).map(
          (c) => `${file}:${c.line}: ${c.text}`,
        );
        expect(offenders).toEqual([]);
      });
    }
  }
});

describe('the comment lint can actually fire', () => {
  for (const rule of RULES) {
    it.each(rule.fires)(`refuses ${rule.name}: %s`, (text) => {
      expect(
        offendersIn(text, rule.re),
        'this shape of comment is not matched by its own rule',
      ).toHaveLength(1);
    });
  }
});

describe('the comment lint leaves correct prose alone', () => {
  it.each(RULES.flatMap((rule) => rule.passes))('accepts %s', (text) => {
    expect(firedBy(text), 'a rule fires on a comment the code should be free to write').toEqual([]);
  });

  it.each(RULES.flatMap((rule) => rule.fires))(
    'ignores %s when it is code, not a comment',
    (text) => {
      expect(firedBy(`const note = ${JSON.stringify(text)};`)).toEqual([]);
    },
  );
});
