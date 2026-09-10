/**
 * `package.json` maps this package's one export condition to `dist/index.js`, so the PUBLISHED
 * surface is whatever `src/index.ts` exports. Every published name is a compatibility obligation
 * semantic-release has to version: a removal is a breaking change for an external importer, and a
 * removal with nothing in the release notes is a silent one. `CATCHUP_LEDGER_MAX` was published
 * here — the package's only exported figure at the time — and went with the catch-up ledger.
 *
 * Graded by IMPORTING the entry rather than by reading its text: a scan over source is satisfied by
 * a name inside a comment, and this repo has retired several such checks for exactly that. What a
 * runtime import cannot see is a type-only export, so those are pinned in TYPE position below,
 * where removing one fails `npm run typecheck:test` instead.
 */
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';
import type { DbErrorClass, SqliteBackendConfig } from '../src/index.js';

/** Every VALUE the package publishes. A name added or removed here is a release-notes obligation. */
const PUBLISHED_VALUES = [
  'ESCALATE_AFTER',
  'MAX_PAGE',
  'MAX_POLL_INTERVAL_MS',
  'MIN_POLL_INTERVAL_MS',
  'MIN_RETENTION_DAYS',
  'POLL_BATCH',
  'PRUNE_BATCH',
  'PRUNE_INTERVAL_MS',
  'SqlitePlugin',
  'backoffMs',
  'classifyDbError',
  'retentionCutoff',
  'validateBackendConfig',
];

describe('the sqlite package publishes exactly what it says it does', () => {
  it('publishes these values and no others', () => {
    expect(Object.keys(entry).sort()).toEqual([...PUBLISHED_VALUES].sort());
  });

  /**
   * The pin above is a list; this is the reason it is not vacuous. Each name is REACHED through the
   * published entry and used for what it is, so a name that survives the key check as a renamed or
   * hollowed-out binding still fails here.
   */
  it('every published value is the thing its name promises', () => {
    expect(typeof entry.SqlitePlugin).toBe('function');
    expect(new entry.SqlitePlugin()).toBeInstanceOf(entry.SqlitePlugin);
    expect(typeof entry.backoffMs(1_000, 1)).toBe('number');
    expect(typeof entry.classifyDbError(new Error('x'))).toBe('string');
    expect(entry.retentionCutoff(1)).toBeTypeOf('string');
    expect(() => entry.validateBackendConfig({ db_path: ':memory:' })).not.toThrow();
    for (const figure of [
      entry.ESCALATE_AFTER,
      entry.MAX_PAGE,
      entry.MAX_POLL_INTERVAL_MS,
      entry.MIN_POLL_INTERVAL_MS,
      entry.MIN_RETENTION_DAYS,
      entry.POLL_BATCH,
      entry.PRUNE_BATCH,
      entry.PRUNE_INTERVAL_MS,
    ]) {
      expect(Number.isFinite(figure)).toBe(true);
    }
  });

  /**
   * The type-only half, pinned where a compiler can see it: each published type is used in type
   * position, so dropping one from the entry fails the package's `typecheck:test` script. A runtime
   * key check cannot reach these at all — they are erased before the module exists.
   */
  it('publishes every type an external consumer annotates against', () => {
    const cls: DbErrorClass = entry.classifyDbError(new Error('x'));
    const cfg: SqliteBackendConfig = { db_path: ':memory:' };
    expect([cls, cfg.db_path].every((v) => v !== undefined)).toBe(true);
  });
});
