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
   *
   * Block state carries ACROSS lines, so that a `/* … *\/` whose continuations do not start with
   * `*` is still commentary — the prime-directive rule below is the one form of backend dependency
   * the import graph can never catch, and half the comment grammar was invisible to it. Clearing
   * the state on `*\/` is as load-bearing as setting it: a flag never cleared reports the whole
   * rest of a file as commentary, which is worse than the hole.
   */
  const commentaryOf = (line: string, inBlock = false): { text: string; inBlock: boolean } => {
    const title = TITLE.exec(line)?.[2] ?? '';
    const code = line.replace(STRINGS, (m) => m[0]!.repeat(m.length));
    const said = (text: string, open: boolean): { text: string; inBlock: boolean } => ({
      text: `${title} ${text}`,
      inBlock: open,
    });
    if (inBlock) {
      const end = code.indexOf('*/');
      if (end < 0) return said(line, true);
      const after = code.slice(end + 2).indexOf('//');
      return said(line.slice(0, end + 2) + (after >= 0 ? line.slice(end + 2 + after) : ''), false);
    }
    const at = Math.min(
      ...[code.indexOf('//'), code.indexOf('/*')].filter((i) => i >= 0).concat(Number.MAX_SAFE_INTEGER),
    );
    const trimmed = line.trim();
    if (at === Number.MAX_SAFE_INTEGER) return said(trimmed.startsWith('*') ? trimmed : '', false);
    return said(line.slice(at), code.indexOf('/*') === at && code.indexOf('*/', at + 2) < 0);
  };

  /** Every line's commentary, with the block state threaded through the file as the lints see it. */
  const commentaryLines = (source: string): string[] => {
    let inBlock = false;
    return source.split('\n').map((line) => {
      const seen = commentaryOf(line, inBlock);
      inBlock = seen.inBlock;
      return seen.text;
    });
  };

  const PROBE = /the reviewer|as of (?:today|now)|for the time being/i;

  /**
   * Parameterised by the SHAPE a comment is written in rather than by the words in it. Every row
   * appears twice — once carrying the banned phrase, once with the same shape carrying it inside a
   * string literal, which is code and must stay out of scope. Rows that are all shapes the scanner
   * already sees cannot tell a working scanner from one blind to half the grammar.
   */
  const SHAPES: readonly (readonly [label: string, flagged: string, ignored: string])[] = [
    [
      'a whole-line comment',
      '// as discussed with the reviewer, this stays.',
      "  example: '// as discussed with the reviewer, x.',",
    ],
    ['a trailing comment', 'const x = 1; // as of now this is fine', "const u = 'https://x/as-of-today';"],
    ['a JSDoc continuation', '/**\n * kept as of today\n */', 'const TEMPORAL = /the reviewer/i;'],
    ['a one-line block comment', '/* kept as of today */', "const s = '/* kept as of today */';"],
    [
      'a block comment continued without a leading star',
      '/*\n   kept as of today,\n   and tomorrow\n*/',
      "const s = ['/*', 'kept as of today', '*/'].join('');",
    ],
    [
      'a block continuation carrying a quote character',
      "/*\n   the reviewer's note\n*/",
      'const s = "/* the reviewer\'s note */";',
    ],
    [
      'a test name',
      "  it('as of today it holds', () => {})",
      "  it('holds', () => { const s = 'as of today'; })",
    ],
  ];

  it.each(SHAPES)('scans %s', (_label, flagged, ignored) => {
    expect(commentaryLines(flagged).some((text) => PROBE.test(text))).toBe(true);
    expect(commentaryLines(ignored).some((text) => PROBE.test(text))).toBe(false);
  });

  /**
   * The clear half graded on its own: everything after a closed block is code again. A scanner that
   * sets the flag and never clears it satisfies every row above and then flags the whole repository.
   */
  it('stops treating a file as commentary once the block closes', () => {
    const lines = commentaryLines('/*\n   a note\n*/\nconst asOfToday = 1;\nconst reviewer = 2;\n');
    expect(lines[1]).toContain('a note');
    expect(lines.slice(3).join('\n')).not.toMatch(/asOfToday|reviewer/);
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

  /**
   * Each rule below is a regex PLUS the sentence a reader gets when it fires, and the two drift
   * apart in silence: a message that claims more than its matcher checks is counted as coverage the
   * suite does not provide, and a matcher that has stopped firing at all reads exactly like a clean
   * repository. So every rule declares the lines it must flag and the lines it must not, phrased as
   * its own message phrases the claim — and the plugin rule's positives are GENERATED from the
   * package list, so a package added there but not reachable by the regex fails here.
   *
   * The plugin rule's message names a PACKAGE for the same reason: that is the dependency the
   * import graph cannot catch, while naming a wire protocol (a Matrix room alias, a NATS subject)
   * is how core describes the shapes it maps onto — a `passes` row, not an offence.
   */
  interface Lint {
    label: string;
    pattern: RegExp;
    files: string[];
    advice: string;
    fires: string[];
    passes: string[];
  }

  const LINTS: Lint[] = [
    {
      label: 'in bridge-core, names a backend plugin package',
      pattern: PLUGIN_REFERENCE,
      files: coreFiles,
      advice:
        'core explains itself without naming a backend PACKAGE — dependencies point one way in prose too',
      fires: BACKEND_PACKAGES.map((p) => `hashed exactly like bridge-${p} does`).concat([
        'bridge-postgres',
        '// see bridge-redis for the same shape',
      ]),
      passes: [
        'bridge-core owns this',
        'bridge-net-util shares the retry policy',
        'the postgres backend does this too',
        'a Matrix room alias, a NATS subject, an XMPP MUC JID',
      ],
    },
    {
      label: 'cites an issue tracker',
      pattern: TRACKER,
      files: codeFiles,
      advice: 'cite the behaviour, not the ticket',
      fires: ['fixed by BUG-12', 'SEC-3 tracks this', 'CX-9 again', 'D-1 covers it', 'closes issue #42'],
      passes: ['a bug in the decoder', 'SECTION-3 of the design', 'D-day', 'issue 42 is stale'],
    },
    {
      label: 'dates itself',
      pattern: TEMPORAL,
      files: codeFiles,
      advice: 'state the risk, not when it was written',
      fires: [
        'unchanged from today',
        'as of today it holds',
        'as of now this is fine',
        'as of this writing',
        'at the time of writing',
        'added in round 3',
        'the reviewer asked for this',
        'as things stand',
        'kept for the time being',
      ],
      passes: [
        'today the cursor advances',
        'reviewers read this first',
        'in round numbers, a page is 100',
        'the round trip is lossless',
      ],
    },
  ];

  it('every rule declares controls on both sides, and the package list drives the plugin rule', () => {
    expect(LINTS.map((l) => l.label)).toEqual([
      'in bridge-core, names a backend plugin package',
      'cites an issue tracker',
      'dates itself',
    ]);
    for (const lint of LINTS) {
      expect(lint.fires.length, lint.label).toBeGreaterThan(0);
      expect(lint.passes.length, lint.label).toBeGreaterThan(0);
      expect(lint.files.length, lint.label).toBeGreaterThan(20);
    }
    expect(LINTS[0]!.fires.length).toBeGreaterThan(BACKEND_PACKAGES.length);
  });

  it.each(LINTS.flatMap((l) => l.fires.map((text) => [l.label, text, l.pattern] as const)))(
    'the rule "%s" fires on %j',
    (_label, text, pattern) => {
      expect(pattern.test(text)).toBe(true);
    },
  );

  it.each(LINTS.flatMap((l) => l.passes.map((text) => [l.label, text, l.pattern] as const)))(
    'the rule "%s" leaves %j alone',
    (_label, text, pattern) => {
      expect(pattern.test(text)).toBe(false);
    },
  );

  it.each(LINTS.map((l) => [l.label, l] as const))('no comment or test name %s', (_label, lint) => {
    const offenders: string[] = [];
    for (const f of lint.files) {
      const source = readFileSync(f, 'utf8');
      commentaryLines(source).forEach((text, i) => {
        if (lint.pattern.test(text))
          offenders.push(`${f.slice(REPO.length)}:${i + 1}: ${source.split('\n')[i]!.trim()}`);
      });
    }
    expect(offenders, `${lint.advice} — put the history in the commit message`).toEqual([]);
  });
});
