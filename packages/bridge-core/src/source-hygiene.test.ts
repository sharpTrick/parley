import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backendPackages,
  codeOf,
  commentaryLines,
  derivedRows,
  filesUnder,
  withoutComments,
  workspacePackages,
} from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';
import { defaultReadStatePath } from './engine/read-state.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = ['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml'];

const sourceFiles = (dir: string): string[] => filesUnder(dir, SOURCE);

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

/**
 * CLASS: an assertion whose expected value is read off the grading machine. The negative control
 * divided its budget by `availableParallelism()`, so the same commit was RED on one vCPU and GREEN
 * on eight and a developer could add work until CI reddened for a reason their box could not
 * reproduce. It is the same shape as a timing bound calibrated on the developer's laptop, so it is
 * graded as a class rather than at the one site that had it.
 */
describe('no assertion reads the machine it is being graded on', () => {
  const HOST_READS = /\b(?:availableParallelism|cpus|totalmem|freemem|loadavg)\s*\(|\bprocess\.(?:platform|arch)\b|\bprocess\.env\.CI\b/g;

  /**
   * From `expect(` to the end of its statement, so the matcher's argument is scanned too: a bound
   * hidden in `.toBeLessThan(cpus().length)` is the same defect as one hidden in the subject.
   */
  const assertionRegions = (code: string): string[] => {
    const out: string[] = [];
    for (const open of code.matchAll(/\bexpect(?:\.\w+)?\s*\(/g)) {
      let depth = 0;
      let at = open.index + open[0].length - 1;
      for (; at < code.length; at++) {
        const ch = code[at];
        if (ch === '(') depth++;
        else if (ch === ')' && --depth < 0) break;
        else if (ch === ';' && depth === 0) break;
      }
      out.push(code.slice(open.index, at));
    }
    return out;
  };

  const hostReadsInAssertions = (source: string): string[] =>
    assertionRegions(codeOf(source))
      .flatMap((region) => [...region.matchAll(HOST_READS)])
      .map((m) => m[0]);

  it.each([
    ['a core count as the expected value', 'expect(shards).toBe(availableParallelism());', ['availableParallelism(']],
    ['a core count as the subject', 'expect(cpus().length).toBeGreaterThan(0);', ['cpus(']],
    ['a memory read inside the data', 'expect([totalmem()]).toEqual(x);', ['totalmem(']],
    ['a CI flag branching the expectation', 'expect(n).toBe(process.env.CI ? 1 : 2);', ['process.env.CI']],
    ['a platform read in a plain argument', 'expect(a).toBe(process.platform);', ['process.platform']],
    ['a platform read inside a template placeholder', 'expect(a, `on ${process.platform}`).toBe(b);', ['process.platform']],
    ['the same read outside any assertion', 'const shards = availableParallelism();\nexpect(1).toBe(1);', []],
    ['a narrated one', '// expect(n).toBe(cpus().length)\nexpect(1).toBe(1);', []],
  ])('reads %s', (_label, source, found) => {
    expect(hostReadsInAssertions(source)).toEqual(found);
  });

  /**
   * Sites allowed to grade a host read, each with the property that makes it safe. Empty is the
   * intended state; an entry is a debt, not a permission slip.
   */
  const KEEPS: ReadonlyArray<readonly [file: string, why: string]> = [];

  const scanned = derivedRows(
    'every test file in the repo',
    () =>
      workspacePackages(REPO)
        .flatMap((p) => filesUnder(p.dir, ['.ts']))
        .filter((f) => f.endsWith('.test.ts'))
        .sort()
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 50,
      witness: [
        'packages/bridge-core/src/source-hygiene.test.ts',
        'packages/conformance/test/negative-control.test.ts',
      ],
    },
  );

  it.each(scanned)('%s', (name, file) => {
    const kept = KEEPS.find(([f]) => f === name);
    const found = hostReadsInAssertions(readFileSync(file, 'utf8'));
    expect(
      kept ? [] : found,
      'this assertion is graded against the machine running it, so the same commit passes on one ' +
        'host and fails on another — compare against a declared constant instead',
    ).toEqual([]);
    if (kept) expect(found, `${name} is registered as a keep but no longer reads the host`).not.toEqual([]);
  });
});

/**
 * CLASS: a test that reaches a real user directory. `state_path` is optional and falls back to
 * `${XDG_STATE_HOME:-~/.local/state}/parley/<instance>/read-state.json`, so a test that omits it
 * opens the file a person's own bridge writes — reading a stale position, and advancing it. Twelve
 * test files across two packages built a config naming neither; three remembered to redirect.
 *
 * Graded here rather than in the twelve, because the defect IS that a file has to remember.
 */
describe('the suite runs against a sandboxed state directory, not the developer’s', () => {
  const sandbox = process.env.XDG_STATE_HOME ?? '';

  it('has XDG_STATE_HOME redirected under the temp directory', () => {
    expect(
      sandbox,
      'XDG_STATE_HOME is not a temp path — vitest.setup.ts is what puts it there, and without it ' +
        'every config that omits `state_path` opens the real ~/.local/state/parley file',
    ).toMatch(new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('resolves a default read-state path inside that sandbox and nowhere near the real home', () => {
    const path = defaultReadStatePath('probe-instance');
    expect(path.startsWith(sandbox), `${path} is outside ${sandbox}`).toBe(true);
    expect(path.startsWith(join(homedir(), '.local'))).toBe(false);
  });
});

/**
 * CLASS: a table that registers NOTHING, in the one place nothing reports it. `it.each([])` runs no
 * case and the file passes; scripts/assert-no-skipped-tests.mjs cannot see it either — that gate
 * scores the groups it finds in the run's assertion results, and a group that produced no row has no
 * key there. Its file-level check catches a file with no cases at all, not a group inside one:
 * WATCHED at head, planting `it.each([] as string[])(...)` at the end of a 42-case file and feeding
 * the JSON report to the gate printed `ok: 42 cases across 1 test files, none skipped away`, exit 0.
 *
 * The report loses the group. The SOURCE does not, which is why this is a lint.
 */
describe('no it.each table can register nothing', () => {
  /**
   * The second rule is narrowed to tables ROOTED IN A FILESYSTEM READ. "Any `.each(identifier)` not
   * produced by derivedRows" was the wider instruction, and it names 193 sites — almost all of them
   * a `flatMap` over a literal declared beside it, which cannot narrow past what is written there. A
   * register of 193 would be a rubber stamp; a walk that comes back short is the real exposure.
   */
  const FILESYSTEM_READ = /\b(?:readdirSync|filesUnder|workspacePackages|backendPackages|globSync)\s*\(/;

  const bindingOf = (code: string, name: string): string | undefined =>
    new RegExp(`(?:const|let|var)\\s+${name}\\b[^=\\n]*=\\s*([\\s\\S]*?);\\n`).exec(code)?.[1];

  const ungradedTables = (source: string): string[] => {
    const code = codeOf(source);
    const out: string[] = [];
    if (/\.each\(\s*(?:\[\s*\]|\[\s*\]\s+as\b)/.test(code)) out.push('.each([])');
    for (const use of code.matchAll(/\.each\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const name = use[1]!;
      const rhs = bindingOf(code, name);
      if (rhs !== undefined && FILESYSTEM_READ.test(rhs) && !/\bderivedRows\s*\(/.test(rhs))
        out.push(`.each(${name})`);
    }
    return out;
  };

  it.each([
    ['an empty table', 'it.each([])(\'%s\', () => {});', ['.each([])']],
    ['an empty table with a type assertion', "it.each([] as string[])('%s', () => {});", ['.each([])']],
    ['a spaced empty table', 'it.each([ ])(\'%s\', () => {});', ['.each([])']],
    ['a tree walk that is not graded', "const f = readdirSync(D).sort();\nit.each(f)('%s', () => {});", ['.each(f)']],
    ['the same walk through derivedRows', "const f = derivedRows('f', () => readdirSync(D), { floor: 1, witness: ['x'] });\nit.each(f)('%s', () => {});", []],
    ['a literal table', "const f = [['a'], ['b']];\nit.each(f)('%s', () => {});", []],
    ['a walk narrated in a comment', '// it.each([]) would be a hole\nit.each([1])(\'%s\', () => {});', []],
  ])('reads %s', (_label, source, found) => {
    expect(ungradedTables(source)).toEqual(found);
  });

  /** Sites allowed to register a filesystem-rooted table by hand. Empty is the intended state. */
  const KEEPS: ReadonlyArray<readonly [file: string, why: string]> = [];

  const tabled = derivedRows(
    'every source and test file in the repo',
    () =>
      workspacePackages(REPO)
        .flatMap((p) => filesUnder(p.dir, ['.ts']))
        .sort()
        .map((f) => [f.slice(REPO.length), f] as const),
    {
      floor: 200,
      witness: [
        'packages/bridge-core/src/source-hygiene.test.ts',
        'packages/bridge-redis/test/test-hygiene.test.ts',
        'packages/bridge-telegram/test/docs.test.ts',
      ],
    },
  );

  it.each(tabled)('%s', (name, file) => {
    const found = KEEPS.some(([f]) => f === name) ? [] : ungradedTables(readFileSync(file, 'utf8'));
    expect(
      found,
      'this table can come back empty or short with the file reporting success — build it with ' +
        '`derivedRows`, which registers a case of its own for the floor and the witnesses',
    ).toEqual([]);
  });
});
