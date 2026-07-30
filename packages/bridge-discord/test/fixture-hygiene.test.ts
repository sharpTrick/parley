/**
 * The gateway harness was restated per suite — four `reachReady` copies, three `fetch` stubs, the
 * same fake-timer ordering comment pasted three times — so a change to the handshake dance had to be
 * found in four places and a missed copy hung that suite on `await pending` with no sign of which
 * copy was stale. Two of the copies were byte-identical, so neither could fail independently. This
 * refuses a fifth: `harness.ts` owns them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));

/** Declaring one of these locally means a copy of the shared harness, not a new fixture. */
const OWNED_BY_HARNESS = ['reachReady', 'stubFetch', 'HUGE_HB', 'NO_HANDSHAKE_TIMEOUT'];

const declaration = (name: string): RegExp =>
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|function|async function)\\s+${name}\\b`, 'm');

describe('the gateway harness has exactly one copy', () => {
  // Every test module EXCEPT the harness itself — a second copy in a shared fixture module would be
  // just as stale-able as one in a suite.
  const others = readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts') && f !== 'harness.ts');

  it('finds the package test modules to lint', () => {
    expect(others.length).toBeGreaterThan(5);
  });

  for (const name of OWNED_BY_HARNESS) {
    it(`no other test module declares its own ${name}`, () => {
      const offenders = others.filter((f) =>
        declaration(name).test(readFileSync(`${TEST_DIR}${f}`, 'utf8')),
      );
      expect(offenders, `import ${name} from ./harness.js instead of restating it`).toEqual([]);
    });
  }

  for (const name of OWNED_BY_HARNESS) {
    it(`harness.ts exports ${name}`, () => {
      expect(readFileSync(`${TEST_DIR}harness.ts`, 'utf8')).toMatch(
        new RegExp(`export (?:const|async function|function) ${name}\\b`),
      );
    });
  }
});
