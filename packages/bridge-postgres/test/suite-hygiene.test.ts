import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
 */
const SHARED_HELPERS = [
  ...readFileSync(join(HERE, HARNESS), 'utf8').matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g),
]
  .map((m) => m[1] as string)
  .sort();

describe('the real-server harness is shared, not restated', () => {
  // Derived from the harness, so also pinned BY VALUE: deleting a helper from the harness would
  // otherwise shrink the rule above to whatever is left, silently.
  it('the harness still owns every real-server helper this rule enforces', () => {
    expect(SHARED_HELPERS).toEqual([
      'backendCount',
      'dropTable',
      'isUp',
      'settledBackendCount',
      'terminateBackends',
      'withAdmin',
    ]);
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
