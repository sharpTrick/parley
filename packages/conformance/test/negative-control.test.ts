import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { asTopic, buildMessage } from '@sharptrick/parley-core';
import { MAX_BLOCK_MS } from '@sharptrick/parley-core';
import {
  ASSERTED_PROPERTIES,
  CALLER_BLOCK_FLOOR_FRACTION,
  CLAUSES,
  type ConformanceContext,
  STABILITY_CALLER_READS,
  STABILITY_DEEP_TOPIC_ROWS,
  STABILITY_LONG_BLOCK_MAX_MS,
  STABILITY_LONG_BLOCK_MIN_MS,
  STABILITY_READS_MIN,
  STABILITY_SHORT_BLOCK_MAX_MS,
  STABILITY_SHORT_BLOCK_MIN_MS,
  STABILITY_SPAN_MS,
} from '@sharptrick/parley-conformance';
import {
  ARM_SWITCHES,
  blastRadiusOf,
  ENUMERABLE_BUDGETS,
  BROKEN_SUITE_MARK,
  BROKEN_VARIANTS,
  MAX_BLAST_RADIUS,
  ReferencePlugin,
  SWITCH_AFTER_CALLS,
} from './reference-plugin.js';
import {
  CAPABILITY_AXES,
  diagnosedAssertions,
  suiteSource,
  UNTABULATED_CAPABILITIES,
} from './suite-source.js';

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
  failureMessages?: string[];
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
}, 900_000);

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
 * One level down from the FIELD, and the only check here that grades an ASSERTION. A clause keeps
 * its control while one assertion inside it has none, because the control fails through the
 * assertion beside it: `expect(missed, …)` catches the row the reader never saw, and every registry
 * above is satisfied by that — while `expect(seen, …)`, which catches a row it saw TWICE or out of
 * order, could be deleted with this whole package, negative control included, staying green. Three
 * such assertions were in exactly that state.
 *
 * Read off what the broken variants actually PRINTED, not off a table: an assertion is alive iff
 * some control made the runner emit its diagnostic. A registry could be satisfied by declaring a
 * mapping; this can only be satisfied by a plugin that really reaches the line.
 */
describe('every assertion carrying its own diagnostic has a variant that reaches it', () => {
  const diagnosed = [...new Set(diagnosedAssertions(suiteSource))];

  it('finds diagnosed assertions to check (guards against a broken parser)', () => {
    expect(
      diagnosed.length,
      'the diagnostic scan found fewer than it was written against',
    ).toBeGreaterThanOrEqual(9);
  });

  it.each(diagnosed.map((d) => [d]))('%s', (message) => {
    const reached = results().filter((row) =>
      (row.failureMessages ?? []).some((failure) => failure.includes(message)),
    );
    expect(
      reached.map((row) => row.fullName),
      `no broken variant makes this assertion fail — it grades nothing, and deleting it would ` +
        `change no result in this package. Add the plugin mutation only it can catch, or ` +
        `establish that the assertion beside it already covers the property.`,
    ).not.toEqual([]);
  });
});

/**
 * One level ACROSS from the clause. A capability flag selects an arm, and every fixture in this
 * package used to declare the same value for both flags — so the weaker arm ran nowhere at all and
 * could be deleted with this package (negative control included) staying green while certified
 * backends kept being graded against it. Neither table above can see it: the clause table is
 * satisfied by a control that exercises the OTHER arm, and the field table by any variant at all.
 *
 * Rows are flag × arm, DERIVED from the context validators — so a new boolean flag arrives as red
 * rows rather than as silently uncontrolled coverage.
 */
describe('every arm of every capability flag has a plugin that fails it', () => {
  const declared = new Map<string, ConformanceContext>();

  beforeAll(async () => {
    for (const variant of BROKEN_VARIANTS) {
      const ctx = await variant.make();
      declared.set(variant.name, ctx);
      await ctx.cleanup().catch(() => undefined);
    }
  }, 120_000);

  const rows = CAPABILITY_AXES.flatMap((axis) =>
    axis.arms.map((arm) => [axis.name, arm] as [string, unknown]),
  );

  it('finds capability arms to grade, so the rows below are not an empty table', () => {
    expect(CAPABILITY_AXES.length).toBeGreaterThan(1);
    expect(rows.length).toBeGreaterThan(CAPABILITY_AXES.length);
  });

  it('tabulates every capability field whose arms can be named', () => {
    expect(
      UNTABULATED_CAPABILITIES,
      'this context field has arms the probe cannot name, so no row below requires a control for ' +
        'either of them. `concurrentPost` is the recorded one — its arms are a function and a ' +
        'string; anything else here is a capability whose coverage nothing is asking about',
    ).toEqual(['concurrentPost']);
  });

  it('built every variant fixture, so the arm each one declares is readable', () => {
    expect([...declared.keys()].sort()).toEqual(BROKEN_VARIANTS.map((v) => v.name).sort());
  });

  it.each(rows)('`%s` = %s', (name, arm) => {
    const axis = CAPABILITY_AXES.find((a) => a.name === name)!;
    const controls = BROKEN_VARIANTS.filter((v) => {
      const ctx = declared.get(v.name);
      return ctx !== undefined && axis.armOf(ctx) === arm;
    });
    expect(
      controls.map((v) => v.name),
      `no BROKEN_VARIANTS entry declares \`${name}: ${String(arm)}\`, and the per-variant table ` +
        `below only proves a variant fails its own clause — so every assertion reachable only ` +
        `inside that arm can be deleted with this package staying green`,
    ).not.toEqual([]);
  });
});

/**
 * The switch table's own reach. Each predicate stands for a way a plugin can tell the reads a suite
 * is known to make apart from the ones a real agent sends, and each is a figure set against the long
 * run's own: a count above what that run asks for, or a clock past what it spans, is a control that
 * fires nowhere and reads in the report as coverage.
 */
describe('every arm switch is reachable by the run built to catch it', () => {
  it('waits for fewer budgets than the long run hands out', () => {
    expect(SWITCH_AFTER_CALLS).toBeLessThan(STABILITY_READS_MIN);
  });

  /**
   * The budget-value switch, from the other side: it stands for a plugin that recognises the reads a
   * suite is known to make, and it only stands for anything while the run draws budgets that suite
   * never hands out from a constant. A range that drifted over one of those constants would leave
   * the control passing for a plugin the clause exists to catch.
   */
  it('draws its budgets from ranges holding none of the figures the suite hands out', () => {
    const inRange = (v: number): boolean =>
      (v >= STABILITY_SHORT_BLOCK_MIN_MS && v <= STABILITY_SHORT_BLOCK_MAX_MS) ||
      (v >= STABILITY_LONG_BLOCK_MIN_MS && v <= STABILITY_LONG_BLOCK_MAX_MS);
    expect(ENUMERABLE_BUDGETS.filter(inRange)).toEqual([]);
    // …and the caller-scale reads really are larger than anything the suite hands out from a
    // constant, so the control aimed at a plugin that honours small budgets and drops large ones is
    // reached by every one of them rather than by the lucky draws.
    expect(Math.floor(MAX_BLOCK_MS * CALLER_BLOCK_FLOOR_FRACTION)).toBeGreaterThan(
      Math.max(...ENUMERABLE_BUDGETS),
    );
  });

  it.each(ARM_SWITCHES.map((sw) => [sw.when, sw] as const))('%s fires inside that run', (_when, sw) => {
    // The LAST read the run is guaranteed to make, on the topic it seeds deep, carrying the largest
    // budget a caller may legally send — the far edge of every axis the run reaches along.
    const nowhere = sw.fires({
      call: STABILITY_READS_MIN + STABILITY_CALLER_READS,
      connectionAgeMs: STABILITY_SPAN_MS + 1,
      blockMs: MAX_BLOCK_MS,
      topic: 'b',
      topicRows: STABILITY_DEEP_TOPIC_ROWS,
      firstTopic: 'a',
      connection: 2,
    });
    expect(
      nowhere,
      'this predicate is never true of a read the long run makes, so the variant built on it ' +
        'answers the whole suite honestly and proves nothing',
    ).toBe(true);
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

  /**
   * The denominator the bound below is a fraction OF. Every variant runs the same registered suite,
   * so a per-variant failure count is only readable against a case count that is the same for all of
   * them and is not zero — an upper bound over rows nobody collected passes by finding nothing.
   * The floor is an absolute figure rather than a count read back off the suite, so a report that
   * collapses to a handful of rows cannot lower the standard it is graded by.
   */
  const MIN_SUITE_CASES = 20;

  const suiteCases = (): number => rowsOf(BROKEN_VARIANTS[0]!.name).length;

  it('every variant ran the same whole suite, so a failure count is a fraction of something known', () => {
    const collected = BROKEN_VARIANTS.map((v) => [v.name, rowsOf(v.name).length] as const);
    expect(
      collected.filter(([, n]) => n !== suiteCases()),
      'a variant that did not run the same set of cases as the others — a bound on how many it ' +
        'fails cannot be compared against one that ran a different suite',
    ).toEqual([]);
    expect(suiteCases()).toBeGreaterThanOrEqual(MIN_SUITE_CASES);
    // The ceiling below is only a bound if it is well under the whole suite: a figure at or past
    // the case count would admit a plugin that fails everything as a control for each case in turn.
    expect(MAX_BLAST_RADIUS * 2).toBeLessThanOrEqual(suiteCases());
  });

  /**
   * The declared radii, against the ceiling no control may be declared past. A number recorded
   * beside a variant is a promise that it still discriminates; past half the suite it does not,
   * whatever figure is written there — so raising one that far is refused rather than recorded.
   */
  it.each(BROKEN_VARIANTS.map((v) => [v.name, blastRadiusOf(v)] as const))(
    'declares a blast radius for %s that a control could have',
    (name, radius) => {
      expect(
        radius,
        `"${name}" is declared to fail ${radius} of ${suiteCases()} cases — a control that breaks ` +
          `more than half the suite demonstrates nothing about the one case it names. Narrow the ` +
          `mutation until it is aimed at that case`,
      ).toBeLessThanOrEqual(MAX_BLAST_RADIUS);
    },
  );

  it.each(BROKEN_VARIANTS.map((v) => [v.name, v.mustFail, blastRadiusOf(v)] as const))(
    'fails a plugin with %s',
    (name, mustFail, radius) => {
      const failed = rowsOf(name).filter((r) => r.status === 'failed');
      const titles = failed.map((r) => r.fullName).join('\n');
      expect(failed.length, `no case failed for "${name}"`).toBeGreaterThan(0);
      expect(titles, `"${name}" failed, but not the case it is built to break`).toContain(mustFail);
      // The other side of the same bound. A control that fails MORE than it was built to fail is
      // indistinguishable from one that has stopped failing the case it is registered for: the
      // extra failures only ever make the two assertions above pass, which is how a control that
      // had degenerated into failing 29 of 32 cases still read as coverage for one of them.
      expect(
        failed.length,
        `"${name}" may fail at most ${radius} of ${suiteCases()} cases and failed ` +
          `${failed.length}. Either the mutation now breaks more than it is aimed at — in which ` +
          `case it no longer shows "${mustFail}" is alive — or its blastRadius needs raising:\n` +
          titles,
      ).toBeLessThanOrEqual(radius);
    },
  );
});
