import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as harness from './pg-harness.js';

// This package's real-server harness — the DSN, the reachability gate, the admin connection, the
// table cleanup, the backend-leak count — used to be copied into eight files, and the copies drifted:
// one pool mock quietly answered [] for every windowed SELECT, which made the file's recovery
// assertion pass whether the plugin recovered or not. A forked harness changes what a whole file is
// asserting without a reviewer seeing a single assertion change, so the sharing is enforced rather
// than asked for.

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = 'pg-harness.ts';
const FAKE = 'fake-pg.ts';

const SELF = 'suite-hygiene.test.ts';

function testFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.ts') && f !== SELF)
    .sort();
}

/**
 * What a test file must take from the harness, READ OUT of the harness rather than listed here: a
 * hand-kept list drifts into naming something the harness does not export, and an entry that has to
 * be exempted to pass grades nothing at all.
 *
 * Every declaration form the harness uses has to be in this alternation. It once read `function`
 * only, so the three `export const` helpers — including `sleep`, the most restated one in the
 * package — were invisible to the rule written to stop exactly that, and it reported green while
 * nine files carried their own copy.
 */
const SHARED_HELPERS = [
  ...readFileSync(join(HERE, HARNESS), 'utf8').matchAll(
    /export\s+(?:const|let|async\s+function|function)\s+(\w+)/g,
  ),
]
  .map((m) => m[1] as string)
  .sort();

describe('the real-server harness is shared, not restated', () => {
  // Derived from the harness, so also pinned BY VALUE: deleting a helper from the harness would
  // otherwise shrink the rule above to whatever is left, silently.
  it('the harness still owns every real-server helper this rule enforces', () => {
    expect(SHARED_HELPERS).toEqual([
      'PG_URL',
      'backendCount',
      'dropTable',
      'faultyProxy',
      'isUp',
      'rand',
      'settleWithin',
      'settledBackendCount',
      'silentPeer',
      'sleep',
      'terminateBackends',
      'withAdmin',
    ]);
  });

  // The set above is read out of the harness's TEXT, so a declaration form the regex does not know
  // about shrinks the rule to whatever it happens to recognise — silently, and in the direction of
  // passing. Grade it against the MODULE instead: whatever the harness really exports at runtime is
  // what the rule below must govern.
  it('the rule governs every helper the harness actually exports', () => {
    expect(SHARED_HELPERS).toEqual(Object.keys(harness).sort());
  });

  it.each(testFiles())('%s declares no harness helper of its own', (file) => {
    const src = readFileSync(join(HERE, file), 'utf8');
    const redeclared = SHARED_HELPERS.filter((name) =>
      new RegExp(`(async\\s+)?function\\s+${name}\\b|(const|let)\\s+${name}\\s*[:=]`).test(src),
    );
    expect(redeclared, `import these from ./${HARNESS} instead of re-declaring them`).toEqual([]);
  });

  it.each(testFiles())('%s takes PARLEY_PG_URL only from the harness', (file) => {
    const src = readFileSync(join(HERE, file), 'utf8');
    expect(src.includes('PARLEY_PG_URL'), `read PG_URL from ./${HARNESS}`).toBe(false);
  });
});

// The `vi.mock('pg')` fake was restated in eleven files, and the copies had already diverged in what
// they answered. The one that mattered: every copy stubbed the connection's event surface as
// `on: vi.fn()`, which swallows an 'error' the plugin has no handler for — the exact event that
// kills the process on a server restart. So a fake that cannot raise it makes the missing handler
// look like a passing suite. The Pool comes from ./fake-pg.ts now, and the shape of the copies is
// what is banned rather than their names, so the next one inlined under a different name is caught.
const RESTATED_DRIVER: [what: string, pattern: RegExp][] = [
  ['an event surface stubbed with `on: vi.fn()`, which cannot raise an error', /\bon: vi\.fn\(/],
  ['its own emitter plumbing', /\bemit\(event\b/],
];

function pgMockingFiles(): string[] {
  return testFiles().filter((f) => readFileSync(join(HERE, f), 'utf8').includes("vi.mock('pg'"));
}

describe('the pg driver fake is shared, not restated', () => {
  it('files in this package really do mock pg, so the rules below are not vacuous', () => {
    expect(pgMockingFiles().length).toBeGreaterThan(0);
  });

  it.each(pgMockingFiles())('%s builds its Pool from the shared fake', (file) => {
    const src = readFileSync(join(HERE, file), 'utf8');
    expect(/\bfakePool\(/.test(src), `take the Pool from ./${FAKE}`).toBe(true);
  });

  it.each(testFiles())('%s restates no part of the driver fake', (file) => {
    const src = readFileSync(join(HERE, file), 'utf8');
    const found = RESTATED_DRIVER.filter(([, pattern]) => pattern.test(src)).map(([what]) => what);
    expect(found, `extend ./${FAKE} instead`).toEqual([]);
  });
});

// A 3x3 table here once named a property ('a seam call across a listener blackout never surfaces a
// raw driver error') whose only assertion sat behind `if (rejection !== undefined)`. Four of the
// nine cells cannot reject by construction, so they ran for seconds and graded nothing — and the
// mutation the file exists to catch survived in every one of them. A row that can take either arm
// has to say which arm it expects and assert it unconditionally, so a cell that changes arm fails
// instead of passing quietly.

/** Line numbers where an `expect(` sits inside an `if (… !== undefined)` block. */
function conditionalAssertions(src: string): string[] {
  const lines = src.split('\n');
  const found: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\s*if\s*\([^)]*!==\s*undefined\s*\)\s*\{\s*$/.test(line)) continue;
    let depth = 1;
    for (let j = index + 1; j < lines.length; j++) {
      const body = lines[j] as string;
      if (/\bexpect\(/.test(body)) found.push(`${index + 1}: ${line.trim()}`);
      depth += (body.match(/\{/g) ?? []).length - (body.match(/\}/g) ?? []).length;
      if (depth <= 0) break;
    }
  }
  return [...new Set(found)];
}

describe('no assertion hides behind a branch a row may never take', () => {
  it('the rule can fire, so the cells below are not vacuous', () => {
    expect(
      conditionalAssertions('if (rejection !== undefined) {\n  expect(1).toBe(1);\n}\n'),
    ).toHaveLength(1);
  });

  it.each(testFiles())('%s asserts its outcome unconditionally', (file) => {
    const src = readFileSync(join(HERE, file), 'utf8');
    expect(
      conditionalAssertions(src),
      'declare the outcome the row expects and assert it unconditionally',
    ).toEqual([]);
  });
});

// The README is the package description surface on npm, so it is read by people who have only the
// published `dist/` — not the repo, not the suite. Maintainer-internal argument aimed at the next
// reviewer ('a green conformance run is not evidence', 'if you are tempted to refactor…') is both
// useless to them and unverifiable: it rots against the suite it names, and CLAUDE.md puts that
// reasoning in the commit message. Naming an internal test path is the same mistake with a
// guaranteed expiry date.
const PACKAGE_ROOT = join(HERE, '..');

const REVIEWER_DIRECTED: [what: string, pattern: RegExp][] = [
  ['an appeal to what a reviewer should believe', /is not evidence/i],
  ['an instruction aimed at whoever edits next', /if you are tempted/i],
  ['a direct address to a reviewer', /\ba reviewer\b/i],
  ['a pointer to a test file by path', /[\w-]+\/[\w.-]*\.test\.ts/],
  ['a pointer to a test file by name', /`[\w.-]+\.test\.ts`/],
  ['an instruction to run part of the suite', /\brun (that|this) (second |first )?file\b/i],
];

function publishedDocs(): string[] {
  return readdirSync(PACKAGE_ROOT)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

describe('the published README talks to operators, not to reviewers', () => {
  it('has a README to grade', () => {
    expect(publishedDocs()).toContain('README.md');
  });

  it.each(publishedDocs())('%s carries no reviewer-directed prose', (file) => {
    const src = readFileSync(join(PACKAGE_ROOT, file), 'utf8');
    const found = REVIEWER_DIRECTED.filter(([, pattern]) => pattern.test(src)).map(([what]) => what);
    expect(found, 'move this to the commit message').toEqual([]);
  });
});
