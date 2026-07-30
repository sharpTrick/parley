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

/** Anything a test file must take from the harness instead of re-declaring. */
const SHARED_HELPERS = [
  'isUp',
  'isPostgresUp',
  'withAdmin',
  'dropTable',
  'backendCount',
  'settledBackendCount',
  'terminateBackends',
];

const SELF = 'suite-hygiene.test.ts';

function testFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.ts') && f !== SELF)
    .sort();
}

describe('the real-server harness is shared, not restated', () => {
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

  it('the harness exports every helper the rule points files at', () => {
    const src = readFileSync(join(HERE, HARNESS), 'utf8');
    for (const name of SHARED_HELPERS) {
      if (name === 'isPostgresUp') continue;
      expect(src, `${HARNESS} does not export ${name}`).toMatch(
        new RegExp(`export\\s+(async\\s+function|function|const)\\s+${name}\\b`),
      );
    }
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
