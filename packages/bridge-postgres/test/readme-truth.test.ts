import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONNECT_WAIT_MS,
  DEFAULT_POOL_SIZE,
  DIAL_WAIT_MS,
  LOCK_WAIT_MS,
  MAX_POOL_SIZE,
  MAX_RETENTION_DAYS,
  MIN_POOL_SIZE,
  MIN_RETENTION_DAYS,
  PRUNE_BATCH,
  QUERY_WAIT_MS,
  TEARDOWN_WAIT_MS,
} from '../src/index.js';
import { MAX_IDENTIFIER_BYTES, MAX_TABLE_NAME_BYTES } from '../src/schema.js';

// The README is the surface that ships to npm, and it is the one place in this package where a
// value the code DERIVES is restated by hand. `MAX_TABLE_NAME_BYTES` is computed from the schema's
// suffix list, so adding one suffix narrows the accepted budget while the published page keeps
// telling operators the old number and `connect()` rejects the name it documents. The same holds
// for every tuned constant below: nothing anywhere goes red today.
//
// So each documented figure is extracted from the prose and compared to the export. EVERY
// occurrence is checked, not the first, because a number stated in three places is a number two of
// which get missed; and each pattern must match at least once, so a reworded sentence fails loudly
// instead of quietly grading nothing.

const README = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
  'utf8',
);

interface Claim {
  what: string;
  /** Global, with exactly one capture group: the number the README states. */
  pattern: RegExp;
  expected: number;
}

const CLAIMS: Claim[] = [
  { what: 'the table_name byte budget', pattern: /max (\d+) bytes/g, expected: MAX_TABLE_NAME_BYTES },
  {
    what: 'the table_name byte budget, restated',
    pattern: /capped at (\d+) bytes/g,
    expected: MAX_TABLE_NAME_BYTES,
  },
  {
    what: "PostgreSQL's identifier limit",
    pattern: /identifiers at (\d+) bytes/g,
    expected: MAX_IDENTIFIER_BYTES,
  },
  {
    what: "PostgreSQL's identifier limit, restated",
    pattern: /(\d+)-byte identifier limit/g,
    expected: MAX_IDENTIFIER_BYTES,
  },
  {
    what: 'the widest retention window',
    pattern: /at most `(\d+)`/g,
    expected: MAX_RETENTION_DAYS,
  },
  {
    what: 'the retention range',
    pattern: /`\[1\/\d+, (\d+)\]`/g,
    expected: MAX_RETENTION_DAYS,
  },
  {
    what: 'the narrowest retention window, stated in minutes',
    pattern: /at least (\d+) minute/g,
    expected: Math.round(MIN_RETENTION_DAYS * 1440),
  },
  {
    what: 'the narrowest retention window, stated as a fraction of a day',
    pattern: /1\/(\d+)/g,
    expected: Math.round(1 / MIN_RETENTION_DAYS),
  },
  {
    what: 'the retention window a config is refused past',
    pattern: /past (\d+) days/g,
    expected: MAX_RETENTION_DAYS,
  },
  { what: 'the prune batch size', pattern: /batches of (\d+) rows/g, expected: PRUNE_BATCH },
  { what: 'the lock timeout', pattern: /lock_timeout = (\d+)/g, expected: LOCK_WAIT_MS },
  {
    what: 'the lock timeout in the error operators see',
    pattern: /after\s+(\d+)ms waiting/g,
    expected: LOCK_WAIT_MS,
  },
  { what: 'the default pool size', pattern: /pool_size: (\d+)/g, expected: DEFAULT_POOL_SIZE },
  { what: 'the smallest pool', pattern: /integer in `(\d+)\.\./g, expected: MIN_POOL_SIZE },
  { what: 'the largest pool', pattern: /integer in `\d+\.\.(\d+)`/g, expected: MAX_POOL_SIZE },
  {
    what: 'the ceiling on the first connection',
    pattern: /first connection gives up after `(\d+)ms`/g,
    expected: DIAL_WAIT_MS,
  },
  {
    what: 'the ceiling on a pooled checkout',
    pattern: /pooled checkout after `(\d+)ms`/g,
    expected: CONNECT_WAIT_MS,
  },
  {
    what: 'the ceiling on one statement',
    pattern: /single statement after `(\d+)ms`/g,
    expected: QUERY_WAIT_MS,
  },
  {
    what: 'the ceiling on the whole teardown',
    pattern: /returns within `(\d+)ms`/g,
    expected: TEARDOWN_WAIT_MS,
  },
];

describe('the published README restates no constant the code derives', () => {
  it.each(CLAIMS.map((c) => [c.what, c] as const))('%s', (_label, claim) => {
    const stated = [...README.matchAll(claim.pattern)].map((m) => Number(m[1]));
    expect(stated.length, 'this sentence was reworded, so the rule below grades nothing').toBeGreaterThan(
      0,
    );
    expect(stated, 'the README states a number the code no longer uses').toEqual(
      stated.map(() => claim.expected),
    );
  });
});
