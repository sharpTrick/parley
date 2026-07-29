import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: source comments must not narrate tracker history. A `BUG-nn` / `SEC-nn` / `issue #nn` tag
 * is unresolvable from the published package, and the paragraph attached to it is rationale that
 * CLAUDE.md routes to the commit message — where it cannot rot against the code it describes. The
 * same text living in a comment, a README and a JSDoc block is three copies that can disagree.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const TRACKER_TAG = /\b(BUG|SEC|CX|ISSUE)[-\s#]*\d+/i;

const sources = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

describe('source comments carry no tracker history', () => {
  it('finds the source files it is meant to scan', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const file of sources) {
    it(`${file} names no tracker id`, () => {
      const offenders = readFileSync(join(SRC, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => TRACKER_TAG.test(line));

      expect(offenders.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
    });
  }
});
