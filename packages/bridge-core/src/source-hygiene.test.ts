import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backendPackages,
  derivedRows,
  filesUnder,
  withoutComments,
  workspacePackages,
} from '@sharptrick/parley-net-util/testing';
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
  const TRACKER =
    /\b(?:BUG|SEC|CX|D|FIX|ISSUE|FINDING|TICKET)[-#]\d+\b|\b(?:BUG|FIX|FINDING|TICKET)\s\d+\b|\bissues?\s*#\d+\b/i;
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
   * The UNIVERSE, which is the half of a lint like this that decays in silence. The same rule was
   * re-implemented in five packages, three of them over a flat `readdirSync(src)` — a walk that
   * keeps passing the day the package grows a subdirectory, and that a `files.length > 0` guard
   * cannot tell from a full scan. Eight of thirteen packages had no such lint at all.
   *
   * So assert what the rules below are actually applied to: EVERY workspace package, and a file
   * nested more than one directory down. Both derived — the package set from `workspaces`, the
   * depth from the tree — so neither can be satisfied by the layout happening to be flat today.
   */
  it('reaches every workspace package, at every depth', () => {
    const packages = workspacePackages(REPO).map((p) => p.dir);
    expect(packages.length).toBeGreaterThan(10);
    const unlinted = packages.filter((dir) => !codeFiles.some((f) => f.startsWith(`${dir}/`)));
    expect(unlinted.map((d) => d.slice(REPO.length)), 'this package is graded by no rule here').toEqual([]);
    const deepest = Math.max(...codeFiles.map((f) => f.slice(REPO.length).split('/').length));
    expect(deepest, 'the walk never left a package root — it is not recursing').toBeGreaterThan(4);
  });

  // The walk itself against a tree built to defeat a flat one, so the depth above cannot become a
  // fact about how `packages/` happens to be arranged.
  it('walks into a nested directory (positive control)', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-hygiene-'));
    mkdirSync(join(root, 'pkg', 'src', 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'src', 'a', 'b', 'deep.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'pkg', 'src', 'shallow.ts'), 'export const y = 1;\n');
    expect(sourceFiles(root).map((f) => f.slice(root.length + 1)).sort()).toEqual([
      'pkg/src/a/b/deep.ts',
      'pkg/src/shallow.ts',
    ]);
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
   * The same class again, one number wide. CLAUDE.md routes "what a number was measured at" to the
   * commit message: a latency quoted in a comment is a claim about a machine nobody else has, and
   * the code above it stays correct while the number silently stops being true.
   */
  const MEASUREMENT = /\b(?:was measured at|benchmarked at|measured \d+\s*m?s\b)/i;

  /**
   * The three rules four per-package comment lints enforced over four private walkers, covering
   * four of twelve packages. Widening them is the point of the consolidation, and the price of
   * widening is that two clauses had to go: `only ever` matched 65 sites and `used to be` 33, nearly
   * all of them describing what the code does rather than narrating a revision, so keeping them
   * would have meant either a rule the repository cannot satisfy or a per-package allowlist.
   */
  const REJECTED_ALTERNATIVE = /\bwe chose\b|\brather than doing\b/i;
  const REVIEWER_NOTE =
    /\bas (?:discussed|requested)\b|\bper review\b|\bthe reviewer (?:asked|wanted|suggested|requested|filed)\b/i;
  const EARLIER_REVISION =
    /\bfor historical reasons\b|\bbefore this change\b|\bas before\b|\bwe now\b|\bpreviously we\b/i;
  const SAFETY_CLAIM =
    /\b(?:stays safe|is safe because|is mutable because|no risk|perfectly (?:safe|fine))\b/i;

  /**
   * The prime directive as a prose rule. `bridge-core` must never depend on a backend plugin, and a
   * comment that explains core's behaviour by pointing AT one is that dependency in the only form
   * the import graph cannot catch. It also rots invisibly: the instance that prompted this rule said
   * core's `safeName` hashed "exactly like bridge-postgres channelFor", and the two had long since
   * diverged — truncated sha1 against full md5 — so the sentence was both a violation and false.
   *
   * This file is exempt, so that the rule can name the packages it bans.
   *
   * The backend package set is DERIVED, the way the rest of the repository derives it — a backend is a package
   * that declares the shared conformance suite — so that a backend added or renamed after this rule
   * was written is one the rule covers rather than one it silently exempts. Restating it here would
   * make the rule's own coverage a thing nobody grades: the generated rows below are built from
   * whatever that set holds, so they agree with it however wrong it is.
   */
  const SUITE = '@sharptrick/parley-conformance';

  const backends = (repo: string = REPO): { dir: string; name: string }[] =>
    backendPackages(repo).map((p) => ({ dir: p.folder, name: p.name }));

  const BACKEND_PACKAGES = backends();
  const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /**
   * Both spellings core could name a backend by: the package directory and the published name.
   * Keep the LEFT boundary a lookbehind rather than `\b`, so that a scoped name — which begins
   * with a character no word boundary precedes — is matched rather than silently never found; and
   * keep it at `\\w` alone, so that a name reached through a PATH (`packages/bridge-x/src`, or a
   * relative import of one) still is.
   */
  const ruleFor = (packages: { dir: string; name: string }[]): RegExp =>
    new RegExp(
      `(?<!\\w)(?:${packages.flatMap((p) => [p.dir, p.name]).map(escaped).join('|')})\\b`,
    );
  const PLUGIN_REFERENCE = ruleFor(BACKEND_PACKAGES);
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
      fires: BACKEND_PACKAGES.flatMap((p) => [
        `hashed exactly like ${p.dir} does`,
        `re-exported from ${p.name}`,
        `see packages/${p.dir}/src/schema.ts for the same shape`,
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
      fires: [
        'fixed by BUG-12',
        'SEC-3 tracks this',
        'CX-9 again',
        'D-1 covers it',
        'closes issue #42',
        'tracked in issues #12 and #13',
        'TICKET-4 asked for this clamp',
        'FINDING 12 says otherwise',
        'issue 4 is filed as ISSUE-4',
        'BUG 12 is back',
        'see SEC#3',
        'FIX-7 landed',
        'TICKET 9 again',
      ],
      passes: [
        'a bug in the decoder',
        'SECTION-3 of the design',
        'D-day',
        'issue 42 is stale',
        'posted to the #discord channel',
        '(d2) a bounded quantifier',
        'one issue with snowflakes: they are not lexically comparable',
      ],
    },
    {
      label: 'quotes a measurement',
      pattern: MEASUREMENT,
      files: codeFiles,
      advice: 'state the bound the code relies on, not the number a machine once produced',
      fires: [
        'this was measured at 40ms',
        'benchmarked at 12 ms on the CI box',
        'measured 900ms before the fix',
      ],
      passes: [
        'the budget is 40ms',
        'a page is measured in messages, not bytes',
        'capped at 60s server-side',
      ],
    },
    {
      label: 'argues that the code is safe instead of warning about a risk',
      pattern: SAFETY_CLAIM,
      files: codeFiles,
      advice: 'a comment warns a future developer off a risky action; it does not reassure one',
      fires: [
        'the cast stays safe here',
        'this is safe because the caller holds the lock',
        'the array is mutable because nothing else reads it',
        'there is no risk of a torn write',
        'reusing the buffer is perfectly safe',
        'dropping the row is perfectly fine',
      ],
      passes: [
        'keep the lock held, so a torn write cannot happen',
        'a safe default, so an unconfigured deployment refuses rather than guesses',
        'the risk is a lost wakeup',
      ],
    },
    {
      label: 'records a rejected alternative',
      pattern: REJECTED_ALTERNATIVE,
      files: codeFiles,
      advice: 'why one approach beat another belongs in the commit message',
      fires: ['we chose a Set here', 'rather than doing it per message'],
      passes: [
        'the caller chose the topic; the plugin resolves the channel',
        'choose the stricter arm, so a backend cannot weaken its own grade',
      ],
    },
    {
      label: 'addresses a reviewer',
      pattern: REVIEWER_NOTE,
      files: codeFiles,
      advice: 'a comment is read by whoever changes the code next, not by whoever reviewed it',
      fires: [
        'as discussed, this stays',
        'left as requested',
        'kept per review',
        'the reviewer asked for this clamp',
      ],
      passes: [
        'Review the page order before trusting the cursor it yields',
        'as documented upstream, the page cap is 100',
        'a frozen record of what a reviewer said',
      ],
    },
    {
      label: 'compares the code to an earlier revision',
      pattern: EARLIER_REVISION,
      files: codeFiles,
      advice: 'describe what the code does; what it did belongs in the commit message',
      fires: [
        'kept for historical reasons',
        'before this change the socket stayed open',
        'as before, the cursor stays opaque to core',
        'we now clamp the page to 100',
        'previously we packed the sequence by hand',
      ],
      passes: [
        'the instance id used to namespace per-instance read state',
        'the cursor used to page the channel is opaque to core',
        'now that the lock is held, the read is stable',
      ],
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
      'quotes a measurement',
      'argues that the code is safe instead of warning about a risk',
      'records a rejected alternative',
      'addresses a reviewer',
      'compares the code to an earlier revision',
      'dates itself',
    ]);
    for (const lint of LINTS) {
      expect(lint.fires.length, lint.label).toBeGreaterThan(0);
      expect(lint.passes.length, lint.label).toBeGreaterThan(0);
      expect(lint.files.length, lint.label).toBeGreaterThan(20);
    }
    expect(
      BACKEND_PACKAGES.length,
      'the backend package set derived from the manifests came back short — the scan, not the repo',
    ).toBeGreaterThan(8);
    expect(LINTS[0]!.fires.length).toBe(BACKEND_PACKAGES.length * 3);
  });

  /**
   * The derivation on a planted tree, because the package set this rule covers is exactly the
   * thing that used to be wrong here: a backend the repo gains must join the rule the day it
   * lands, and a package that merely sits under the same prefix must not.
   */
  it('derives a backend added to a planted tree, and the rule it builds names it', () => {
    const root = mkdtempSync(join(tmpdir(), 'backends-'));
    const plant = (path: string, body: string): void => {
      mkdirSync(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    const backend = (name: string): string =>
      JSON.stringify({ name: `@x/${name}`, devDependencies: { [SUITE]: '^0.1.0' } });
    plant('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    plant('packages/bridge-signal/package.json', backend('bridge-signal'));
    plant('packages/bridge-core/package.json', JSON.stringify({ name: '@x/bridge-core' }));
    plant('packages/bridge-net-util/package.json', JSON.stringify({ name: '@x/bridge-net-util' }));

    expect(backends(root)).toEqual([{ dir: 'bridge-signal', name: '@x/bridge-signal' }]);
    const rule = ruleFor(backends(root));
    expect(rule.test('hashed exactly like bridge-signal does')).toBe(true);
    expect(rule.test('re-exported from @x/bridge-signal')).toBe(true);
    expect(rule.test('see packages/bridge-signal/src/schema.ts for the same shape')).toBe(true);
    expect(rule.test('bridge-core owns this')).toBe(false);
    expect(rule.test('bridge-net-util shares the retry policy')).toBe(false);
    expect(rule.test('bridge-signalling is a different word')).toBe(false);
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

/**
 * CLASS: someone's own machine baked into a tool, where only running the tool somewhere else says
 * so. Both halves of the review harness carried one — a `/home/user/parley` checkout root and a
 * `/tmp/careening/worktrees` — and each was found by a round failing, never by a test.
 *
 * Only HOME roots, so that a scratch path under `/tmp` — correct on every machine — is not swept up
 * with a checkout path that is correct on one. Judged over comment-stripped source, so that a
 * comment recording the mistake is not itself the violation.
 *
 * Applied to every workspace package as well as to `scripts/` and `.claude/`. The rule used to read
 * the two tool directories alone, from inside a published package's suite; a machine path is no
 * more acceptable in a backend than in a workflow script, and the wider set costs nothing.
 */
describe('no file in this repo names the machine it was written on', () => {
  const MACHINE_PATH = /(?<![\w./])\/(?:home|Users|root|mnt|media)\/[\w./$={}-]+/g;
  const HASH_COMMENT = /^\s*#.*$/gm;

  const named = (source: string, hash = false): string[] => [
    ...(hash ? source.replaceAll(HASH_COMMENT, '') : withoutComments(source)).matchAll(MACHINE_PATH),
  ].map((m) => m[0]);

  it.each([
    ['a checkout root in a constant', "const W = '/home/user/parley/.careening'", ['/home/user/parley/.careening']],
    ['a double-quoted one', 'const R = "/home/user/parley"', ['/home/user/parley']],
    ['an interpolated one', 'const R = `/Users/someone/src/${name}`', ['/Users/someone/src/${name}']],
    ['one narrated in a line comment', "// this said '/home/user/parley', the path on the container", []],
    ['one narrated in a block comment', "/* was '/home/user/parley' once */\nconst ok = 'x'", []],
    ['a tmp path, correct everywhere', "const W = '/tmp/careening/worktrees'", []],
    ['a bare word that is not a path', "const home = 'user/parley'", []],
  ])('reads %s', (_label, source, found) => {
    expect(named(source)).toEqual(found);
  });

  it.each([
    ['a shell assignment', "dir='/home/user/parley'", ['/home/user/parley']],
    ['a shell comment', 'root=$(git rev-parse --show-toplevel)\n# was /home/user/parley', []],
  ])('reads %s', (_label, source, found) => {
    expect(named(source, true)).toEqual(found);
  });

  const HASH_SYNTAX = ['.sh', '.yml', '.yaml'];

  const scanned = derivedRows(
    'every tool and source file',
    () =>
      [
        ...filesUnder(join(REPO, 'packages'), ['.ts', '.js', '.mjs', '.cjs']),
        ...filesUnder(join(REPO, 'examples'), ['.ts', '.js', '.mjs', '.cjs']),
        ...filesUnder(join(REPO, 'scripts'), ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']),
        ...filesUnder(join(REPO, '.claude'), ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']),
      ]
        .filter((f) => !f.endsWith('source-hygiene.test.ts'))
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 100,
      witness: ['packages/bridge-core/src', 'packages/conformance/src', 'scripts/', '.claude/'],
    },
  );

  it.each(scanned)('%s', (_name, file) => {
    expect(
      named(readFileSync(file, 'utf8'), HASH_SYNTAX.some((ext) => file.endsWith(ext))),
      'this path is correct on one machine — derive it from the repository root instead',
    ).toEqual([]);
  });
});
