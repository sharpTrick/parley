import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude']);
const SOURCE = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (SOURCE.has(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * A raw control byte in a source file makes it `data` to file(1) and makes ripgrep refuse to print
 * its matches, so the file silently disappears from every grep-based search and review pass.
 *
 * This has now happened twice in bridge-matrix, both times as a NUL-prefixed cache-key sentinel
 * written as a literal instead of an escape — the second time in a new location, by an agent
 * remediating a round that had already fixed the first. A comment on the original line did not
 * generalise; this does.
 */
describe('source hygiene', () => {
  const files = sourceFiles(join(REPO, 'packages')).concat(sourceFiles(join(REPO, 'examples')));

  it('finds source files to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each([
    ['NUL', 0x00],
    ['SOH', 0x01],
    ['BEL', 0x07],
    ['BS', 0x08],
    ['VT', 0x0b],
    ['FF', 0x0c],
    ['SUB', 0x1a],
    ['ESC', 0x1b],
  ])('no source file contains a raw %s byte', (name, byte) => {
    const offenders = files
      .filter((f) => readFileSync(f).includes(byte))
      .map((f) => f.slice(REPO.length));
    expect(
      offenders,
      `${name} (0x${byte.toString(16).padStart(2, '0')}) must be written as an escape, not a raw byte`,
    ).toEqual([]);
  });

  /**
   * A tracker id in a comment or a test name points at an issue a reader of this repository cannot
   * open, and narrates history that CLAUDE.md puts in the commit message. Every round of review has
   * filed it, and it kept coming back under new numbers, so the class is guarded rather than the
   * instances. Test names matter as much as comments: the name is the first thing a human reads
   * when a case fails, and a bare ticket id locates nothing.
   *
   * `docs/findings/` is exempt, so that archived findings records can quote code as it stood.
   */
  const TRACKER = /\b(?:BUG|SEC|CX|D)-\d+\b|\bissue #\d+/;
  const codeFiles = files.filter(
    (f) =>
      ['.ts', '.js', '.mjs', '.cjs'].includes(extname(f)) &&
      !f.includes('/docs/findings/') &&
      !f.endsWith('source-hygiene.test.ts'),
  );

  it('finds code files to check (guards against a broken filter)', () => {
    expect(codeFiles.length).toBeGreaterThan(50);
  });

  /**
   * These rules are about COMMENTS and test NAMES, so scan only those. A sibling comment lint has to
   * quote the shapes it bans — `example: '// as discussed with the reviewer, this stays.'` is a
   * negative control proving its matcher fires — and a line-wide grep reads that fixture as an
   * offence. Exempting the FILE would have excused `connection-hygiene`, `publish-hygiene` and
   * `secret-hygiene` too, which are not comment lints at all; matching the stated scope is narrower
   * and needs no allowlist.
   */
  const STRINGS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const TITLE = /^\s*(?:it|test|describe)(?:\.\w+)*(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:[^\\]|\\.)*?)\1/;

  /**
   * The text these rules govern, and nothing else. Blanking string literals BEFORE looking for `//`
   * is what separates a comment from a fixture that quotes one, and it keeps a TRAILING comment in
   * scope — matching on line shape instead would let `const x = 1; // as of now` through, trading a
   * false positive for a false negative.
   */
  const commentaryOf = (line: string): string => {
    const title = TITLE.exec(line)?.[2] ?? '';
    const code = line.replace(STRINGS, (m) => m[0]!.repeat(m.length));
    const at = Math.min(
      ...[code.indexOf('//'), code.indexOf('/*')].filter((i) => i >= 0).concat(Number.MAX_SAFE_INTEGER),
    );
    const trimmed = line.trim();
    const block = trimmed.startsWith('*') ? trimmed : '';
    return `${title} ${at === Number.MAX_SAFE_INTEGER ? block : line.slice(at)}`;
  };

  it.each([
    ['a whole-line comment', '// as discussed with the reviewer, this stays.', true],
    ['a trailing comment', 'const x = 1; // as of now this is fine', true],
    ['a JSDoc continuation', ' * kept as of today', true],
    ['a test name', "  it('as of today it holds', () => {})", true],
    ['a lint fixture quoting a comment', "  example: '// as discussed with the reviewer, x.',", false],
    ['a pattern declaration', 'const TEMPORAL = /the reviewer/i;', false],
    ['a URL containing //', "const u = 'https://x/as-of-today';", false],
  ])('scans %s', (_label, line, expected) => {
    expect(/the reviewer|as of (?:today|now)|for the time being/i.test(commentaryOf(line))).toBe(
      expected,
    );
  });

  /**
   * The same class one step further out: a comment that dates itself. "unchanged from today" and
   * "as of now" resolve to no date and no baseline for the next reader, and go false the moment the
   * thing they describe moves — while the code they sit above stays correct. CLAUDE.md puts that in
   * the commit message, where it cannot rot against the code.
   */
  const TEMPORAL =
    /unchanged from today|as of (?:today|now|this writing)|at the time of writing|\bin round \d|\bthe reviewer\b|\bas things stand\b|\bfor the time being\b/i;

  /**
   * The prime directive as a prose rule. `bridge-core` must never depend on a backend plugin, and a
   * comment that explains core's behaviour by pointing AT one is that dependency in the only form
   * the import graph cannot catch. It also rots invisibly: the instance that prompted this rule said
   * core's `safeName` hashed "exactly like bridge-postgres channelFor", and the two had long since
   * diverged — truncated sha1 against full md5 — so the sentence was both a violation and false.
   *
   * This file is exempt, so that the rule can name the packages it bans.
   */
  const BACKEND_PACKAGES = [
    'sqlite',
    'redis',
    'postgres',
    'matrix',
    'xmpp',
    'nats',
    'zulip',
    'discord',
    'slack',
    'telegram',
  ];
  const PLUGIN_REFERENCE = new RegExp(`\\bbridge-(?:${BACKEND_PACKAGES.join('|')})\\b`);
  const coreFiles = codeFiles.filter(
    (f) => f.includes('/packages/bridge-core/src/') && !f.endsWith('source-hygiene.test.ts'),
  );

  it('finds core files to check (guards against a broken filter)', () => {
    expect(coreFiles.length).toBeGreaterThan(20);
  });

  it.each([
    ['a plugin package', 'bridge-postgres', true],
    ['a plugin package mid-sentence', 'hashed like bridge-matrix does', true],
    ['the core package itself', 'bridge-core owns this', false],
    ['a backend word that is not a package', 'the postgres backend does this too', false],
  ])('the plugin-reference rule matches %s', (_label, text, expected) => {
    expect(PLUGIN_REFERENCE.test(text)).toBe(expected);
  });

  it('no comment or test name in bridge-core names a backend plugin package', () => {
    const offenders: string[] = [];
    for (const f of coreFiles) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (PLUGIN_REFERENCE.test(commentaryOf(line)))
            offenders.push(`${f.slice(REPO.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(
      offenders,
      'core explains itself without naming a backend — dependencies point one way in prose too',
    ).toEqual([]);
  });

  it.each([
    ['cites an issue tracker', TRACKER, 'cite the behaviour, not the ticket'],
    ['dates itself', TEMPORAL, 'state the risk, not when it was written'],
  ])('no comment or test name %s', (_label, pattern, advice) => {
    const offenders: string[] = [];
    for (const f of codeFiles) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (pattern.test(commentaryOf(line)))
            offenders.push(`${f.slice(REPO.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, `${advice} — put the history in the commit message`).toEqual([]);
  });
});
