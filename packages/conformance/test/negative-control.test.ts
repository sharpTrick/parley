import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { asTopic, buildMessage } from '@sharptrick/parley-core';
import { ASSERTED_PROPERTIES, CLAUSES } from '@sharptrick/parley-conformance';
import { BROKEN_SUITE_MARK, BROKEN_VARIANTS, ReferencePlugin } from './reference-plugin.js';
import { BOOLEAN_CAPABILITIES, cases } from './suite-source.js';

/**
 * The suite's negative control. A suite that accepts every plugin certifies nothing, and an
 * assertion nobody can see fail is indistinguishable from a deleted one — so each deliberately
 * broken plugin must FAIL the case built to catch it. Vitest cannot invert a whole suite's result
 * in-process, hence the child run: the broken suites are registered only under
 * `PARLEY_CONFORMANCE_BROKEN`, and this test grades the child's JSON report.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TARGET = 'packages/conformance/test/broken-variants.test.ts';

interface Row {
  fullName: string;
  status: string;
  ancestorTitles: string[];
}

interface JsonReport {
  testResults: { assertionResults: Row[] }[];
}

let report: JsonReport;
let stdout = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-negative-control-'));
  const out = join(dir, 'report.json');
  try {
    const run = await promisify(execFile)(
      'npx',
      ['vitest', 'run', TARGET, '--reporter=json', `--outputFile=${out}`, '--testTimeout=30000'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PARLEY_CONFORMANCE_BROKEN: '1', CI: '1' },
        maxBuffer: 64 * 1024 * 1024,
      },
    ).catch((err: { stdout?: string; stderr?: string }) => err);
    stdout = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    report = JSON.parse(readFileSync(out, 'utf8')) as JsonReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);

const results = (): Row[] => report.testResults.flatMap((f) => f.assertionResults);

/**
 * Which variant a report row belongs to, recovered from the SUITE title alone. Keep the comparison
 * exact, so that a variant whose name contains another's is not scored on its sibling's failures:
 * every check below attributes failures by name, and an inherited failure only ever makes a row
 * pass — which is how a control that has stopped failing reads as coverage.
 */
const variantOf = (row: Row): string | undefined => {
  const suite = row.ancestorTitles[0] ?? '';
  const at = suite.indexOf(BROKEN_SUITE_MARK);
  return at < 0 ? undefined : suite.slice(at + BROKEN_SUITE_MARK.length);
};

const claims = (name: string, row: Row): boolean => variantOf(row) === name;

const rowsOf = (name: string): Row[] => results().filter((row) => claims(name, row));

/**
 * The one-to-one-ness, made mechanical. A clause with no variant is a clause whose assertions can be
 * gutted with this whole package — negative control included — staying green; seven of them were in
 * exactly that state, the lost-wakeup race among them. Nothing in the clause registry or the
 * suite-shape checks can see it, because both grade only that a case with the right title exists.
 */
describe('every clause the suite grades has a plugin that fails it', () => {
  it.each(CLAUSES.map((c) => [c]))('%s', (clause) => {
    const controls = BROKEN_VARIANTS.filter(
      (v) => clause.includes(v.mustFail) || v.mustFail.includes(clause),
    );
    expect(
      controls.map((v) => v.name),
      `no BROKEN_VARIANTS entry names "${clause}" — add the plugin mutation that proves the ` +
        `clause's assertions can fail`,
    ).not.toEqual([]);
  });

  it('has no variant aimed at a clause the suite no longer grades', () => {
    const orphans = BROKEN_VARIANTS.filter(
      (v) => !CLAUSES.some((c) => c.includes(v.mustFail) || v.mustFail.includes(c)),
    );
    expect(orphans.map((v) => v.name)).toEqual([]);
  });
});

/**
 * One level down from the clause. A clause keeps its control while an assertion INSIDE it has none:
 * six could be neutered at once — the `timestamp` parse, the length of `backendMsgId`, `cursor` and
 * `backendRef`, the second `disconnect()`, and the uniqueness of the ids `post` returns — with this
 * package, negative control included, staying green.
 *
 * Derived from the `Message` a plugin actually builds rather than a hand-kept list, so a field added
 * to the seam's own type arrives here as a red row instead of an untested one.
 */
describe('every Message field the suite reads has a plugin that corrupts it', () => {
  const MESSAGE_FIELDS = Object.keys(
    buildMessage({ topic: asTopic('t'), sender: 's', content: 'c', timestamp: 'ts', id: 'i' }),
  );
  const SEAM_CALLS = Object.getOwnPropertyNames(ReferencePlugin.prototype).filter(
    (n) => n !== 'constructor',
  );

  it('reads the fields off a real Message, so the rows below are not an empty table', () => {
    expect(MESSAGE_FIELDS).toEqual(expect.arrayContaining(['cursor', 'backendMsgId', 'timestamp']));
    expect(MESSAGE_FIELDS.length).toBeGreaterThan(5);
  });

  it.each(MESSAGE_FIELDS)('a variant corrupts `%s`', (field) => {
    expect(
      BROKEN_VARIANTS.filter((v) => v.mutates === field).map((v) => v.name),
      `no BROKEN_VARIANTS entry mutates \`${field}\` — every assertion the suite makes about it can ` +
        `be deleted with this package staying green`,
    ).not.toEqual([]);
  });

  /**
   * One level down again. `mutates` keyed on a `Message` field or a seam call cannot name an
   * assertion about the PAGE — `nextCursor` agreeing with the last row returned, a drained cursor
   * staying put, `limit` being honoured — so five such assertions could be deleted together with
   * this package, negative control included, staying green.
   */
  it.each(ASSERTED_PROPERTIES.map((p) => [p]))('a variant covers `%s`', (property) => {
    expect(
      BROKEN_VARIANTS.filter((v) => v.mutates === property).map((v) => v.name),
      `no BROKEN_VARIANTS entry mutates \`${property}\` — the assertions the suite makes about it ` +
        `can all be deleted with this package staying green`,
    ).not.toEqual([]);
  });

  it('every variant names something real as what it corrupts', () => {
    const vocabulary = new Set([...MESSAGE_FIELDS, ...SEAM_CALLS, ...ASSERTED_PROPERTIES]);
    expect(
      BROKEN_VARIANTS.filter((v) => !vocabulary.has(v.mutates)).map((v) => `${v.name} → ${v.mutates}`),
    ).toEqual([]);
  });
});

/**
 * One level ACROSS from the clause. A capability flag selects an arm, and every fixture in this
 * package used to declare the same value for both flags — so the suite's whole native-blocking half
 * and the true arm of its 0-3 ms lost-wakeup race ran nowhere at all, and could be deleted with this
 * package (negative control included) staying green while eight backends that declare the capability
 * kept being certified against them. Neither table above can see it: the clause table is satisfied
 * by a control that exercises the OTHER arm, and the field table by any variant at all.
 *
 * Rows are flag × arm × the clause whose case branches on that flag, derived from `CONTEXT_FIELDS`
 * and from the suite source — so a new capability flag, or a new clause that branches on one,
 * arrives as a red row rather than as silently uncontrolled coverage.
 */
describe('every arm of every capability flag has a plugin that fails it', () => {
  const declared = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    for (const variant of BROKEN_VARIANTS) {
      const ctx = await variant.make();
      declared.set(variant.name, ctx as unknown as Record<string, unknown>);
      await ctx.cleanup().catch(() => undefined);
    }
  }, 120_000);

  const clausesBranchingOn = (field: string): string[] =>
    cases()
      .filter((c) => new RegExp(`ctx\\.${field}\\b`).test(c.body))
      .flatMap((c) => CLAUSES.filter((clause) => c.title.includes(clause)));

  const rows = BOOLEAN_CAPABILITIES.flatMap((field) =>
    clausesBranchingOn(field).flatMap((clause) =>
      [true, false].map((arm) => [field, arm, clause] as [string, boolean, string]),
    ),
  );

  it('finds a branching clause for every boolean flag, so the rows below grade something', () => {
    expect(BOOLEAN_CAPABILITIES.length).toBeGreaterThan(1);
    for (const field of BOOLEAN_CAPABILITIES) {
      expect(clausesBranchingOn(field), `no case branches on \`ctx.${field}\``).not.toEqual([]);
    }
    expect(rows.length).toBeGreaterThan(3);
  });

  it('built every variant fixture, so the arm each one declares is readable', () => {
    expect([...declared.keys()].sort()).toEqual(BROKEN_VARIANTS.map((v) => v.name).sort());
  });

  it.each(rows)('`%s` = %s, on the clause "%s"', (field, arm, clause) => {
    const controls = BROKEN_VARIANTS.filter(
      (v) =>
        declared.get(v.name)?.[field] === arm &&
        (clause.includes(v.mustFail) || v.mustFail.includes(clause)),
    );
    expect(
      controls.map((v) => v.name),
      `no BROKEN_VARIANTS entry declares \`${field}: ${String(arm)}\` and fails "${clause}" — ` +
        `every assertion inside that arm can be deleted with this package staying green`,
    ).not.toEqual([]);
  });
});

describe('the suite rejects a non-conformant plugin', () => {
  // Without this the per-variant rows below read an empty report and pass having graded nothing.
  it('the child run collected every broken variant', () => {
    expect(report, stdout.slice(-4_000)).toBeDefined();
    expect(results().length).toBeGreaterThan(BROKEN_VARIANTS.length);
    for (const variant of BROKEN_VARIANTS) {
      expect(rowsOf(variant.name).length, `no rows collected for "${variant.name}"`).toBeGreaterThan(
        0,
      );
    }
  });

  /**
   * The attribution itself, graded as a partition rather than as a fact about these names. Every row
   * the child produced comes from exactly one broken suite, so a matcher that lets a row count for
   * two variants — or for none — is visible here whatever produced it: a rename, a name that becomes
   * a prefix of another, or a containment match reintroduced. A per-variant row cannot see it,
   * because the extra failures it inherits only ever make it pass.
   */
  it('each result row is claimed by exactly one variant', () => {
    const claimants = results().map((r) => ({
      row: r.fullName,
      by: BROKEN_VARIANTS.filter((v) => claims(v.name, r)).map((v) => v.name),
    }));
    expect(claimants.length).toBeGreaterThan(BROKEN_VARIANTS.length);
    expect(
      claimants.filter((c) => c.by.length !== 1),
      'a report row that no variant claims, or that more than one claims — every check in this ' +
        'file scores a variant by the rows it matches, so a many-to-one match certifies a control ' +
        'that has stopped failing',
    ).toEqual([]);
  });

  it.each(BROKEN_VARIANTS.map((v) => [v.name, v.mustFail] as const))(
    'fails a plugin with %s',
    (name, mustFail) => {
      const failed = rowsOf(name).filter((r) => r.status === 'failed');
      expect(failed.length, `no case failed for "${name}"`).toBeGreaterThan(0);
      expect(
        failed.map((r) => r.fullName).join('\n'),
        `"${name}" failed, but not the case it is built to break`,
      ).toContain(mustFail);
    },
  );
});
