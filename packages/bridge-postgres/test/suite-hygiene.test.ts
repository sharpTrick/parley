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
