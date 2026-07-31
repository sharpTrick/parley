import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Class: a comment that restates the line beneath it. CLAUDE.md makes a comment earn its place only
// by warning a future developer off a RISKY action, phrased as the risk ("keep X, so that Y") —
// anything else belongs in the commit message, where it cannot rot against the code. Review has now
// filed this class twice against this package in new costumes (narrating history, then restating),
// and a per-instance fix leaves the next one to a human reading 1400 lines. Grading it mechanically
// is what stops it recurring: a `//` comment in `src/` must carry a risk connective, or the thing it
// was carrying belongs in a name (`roomStanzaId`, `STATUS_SELF_PRESENCE`) or a JSDoc block instead.
//
// Deliberately scoped to line comments in this package's `src/`: JSDoc is the API surface and is
// governed by truth-in-docs, and the class headers this suite itself uses are a testing convention.
// The repo-wide version of this gate belongs in bridge-core's `source-hygiene.test.ts`, which
// already lints every package — it is not this package's to edit.

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Phrasings that make a comment a warning rather than a restatement: the consequence of doing it
 * the other way. `keep X so that Y`, `never Z`, `a Q cannot R`, `W would break V`, `X rather than Y`.
 */
const RISK = /\b(?:so that|so a|so it|keep|never|cannot|can't|would|rather than|or an?\b|otherwise)\b/i;

interface Comment {
  file: string;
  line: number;
  text: string;
}

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );

/**
 * Everything on a line that is not code. Escape pairs go first — `\\/` inside a regex literal is
 * what makes `.replace(/^\\/\\//, '')` look like a comment — and string literals second, so a `//`
 * inside a URL is not read as one either.
 */
const STRINGS = /'[^']*'|"[^"]*"|`[^`]*`/g;
const codeOf = (line: string): string =>
  line.replace(/\\./g, '__').replace(STRINGS, (m) => m[0]!.repeat(m.length));

/** Consecutive `//` lines are ONE comment: the risk is often stated in the last of them. */
export const lineComments = (source: string, file = ''): Comment[] => {
  const out: Comment[] = [];
  let open: Comment | undefined;
  source.split('\n').forEach((raw, i) => {
    const at = codeOf(raw).indexOf('//');
    if (at === -1) {
      open = undefined;
      return;
    }
    const text = raw.slice(at + 2).trim();
    if (open === undefined) {
      open = { file, line: i + 1, text };
      out.push(open);
    } else {
      open.text = `${open.text} ${text}`;
    }
  });
  return out;
};

describe('every line comment in bridge-xmpp/src states a risk', () => {
  const files = tsFiles(SRC);

  it('finds sources to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it('no comment restates the code instead of warning about it', () => {
    const offenders = files.flatMap((f) =>
      lineComments(readFileSync(f, 'utf8'), f.slice(SRC.length + 1))
        .filter((c) => !RISK.test(c.text))
        .map((c) => `${c.file}:${c.line}: // ${c.text}`),
    );
    expect(
      offenders,
      'a line comment must warn a future developer off a risky action ("keep X, so that Y"); ' +
        'anything else belongs in a name, a JSDoc block, or the commit message',
    ).toEqual([]);
  });

  // The matcher itself, so a green run above is never a dead assertion: each row is a real comment
  // shape, and the fixtures on the left are the exact ones review filed against this package.
  it.each([
    ["The MUC adds <stanza-id by='room'>; pick the one stamped by this room.", false],
    ['Live delivery: every reflected message carrying a room stanza-id.', false],
    ['MAM streamed result? (outer stanza is a normal message addressed to us)', false],
    ['Self-presence: our own nick echoed back, or status code 110.', false],
    ['empty <before/> => last page', false],
    ['Report on stderr, NEVER stdout, so that the JSON-RPC channel stays parseable.', true],
    ['Keep this crypto-random, or an observer can predict the next one.', true],
    ['Settle the loser FROM the successor rather than rejecting it.', true],
    ['An unguarded delete would drop the successor’s registration.', true],
  ])('grades %j as stating a risk: %s', (text, stated) => {
    expect(RISK.test(text)).toBe(stated);
  });

  it('reads a run of // lines as one comment, so the risk may be stated in the last', () => {
    const comments = lineComments('// first half of the sentence,\n// so that the risk is stated.\nx;');
    expect(comments).toHaveLength(1);
    expect(RISK.test(comments[0]!.text)).toBe(true);
  });
});
