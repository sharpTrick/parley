import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { asTopic, buildMessage } from '@sharptrick/parley-core';
import { MAX_BLOCK_MS } from '@sharptrick/parley-core';
import { FAILURE_SHAPE_NAMES } from '@sharptrick/parley-core/testing';
import {
  ASSERTED_PROPERTIES,
  BURST_POSTS_MAX,
  BURST_POSTS_MIN,
  CALLER_BLOCK_FLOOR_FRACTION,
  CLAUSES,
  type ConformanceContext,
  CONTENT_SHAPES,
  DELIVERY_MS,
  livePayload,
  LIVE_SUBSCRIPTIONS,
  liveWriter,
  QUIET_BACKLOG_ROWS,
  QUIET_DELIVERY_MS,
  QUIET_IDLE_MS,
  QUIET_POSTS_MIN,
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
  brokenShards,
  LATE_DELIVERY_MS,
  LIVE_DEATHS,
  MAX_BLAST_FRACTION,
  ReferencePlugin,
  REORDER_ABOVE,
  SUBSCRIPTION_CAP,
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
  startTime: number;
  testResults: { assertionResults: Row[] }[];
}

let report: JsonReport;
let stdout = '';

/**
 * Where the child run's own report and output are kept after the temp directory goes.
 *
 * Every check below scores a variant out of a report that was being deleted in a `finally`, so a
 * row that reddens once in many runs left NOTHING to read: not which cases the child failed, not
 * its output, not even whether the child agreed with itself. The exposure that produces exactly
 * that signature is structural and is recorded rather than widened away — `fails a plugin with %s`
 * bounds each variant from ABOVE, and a large share of them sit at margin zero, so a single flaky
 * case anywhere in the child run reddens exactly one row. Raising the radii would hide that; the
 * evidence is what was missing.
 */
const KEPT_PREFIX = 'parley-negative-control-kept-';
const KEPT_RUN = join(tmpdir(), `${KEPT_PREFIX}${process.pid}-${Date.now().toString(36)}`);
/** How long a kept run stays before the next run sweeps it. Far longer than any run takes. */
const KEEP_FOR_MS = 6 * 60 * 60 * 1000;
let keptRun = '';
/** The exact bytes this run parsed, so the copy on disk can be shown to be the same run's. */
let keptReportText = '';
const PARENT_STARTED_AT = Date.now();

beforeAll(async () => {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(KEPT_PREFIX)) continue;
    const path = join(tmpdir(), entry);
    try {
      if (Date.now() - statSync(path).mtimeMs > KEEP_FOR_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run is holding it, or it is already gone.
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'parley-negative-control-run-'));
  const shards = brokenShards();
  try {
    /**
     * One child per shard, run CONCURRENTLY. vitest schedules at file granularity, so one file
     * holding every variant ran them strictly serially in a single worker whatever the box had;
     * the shards each register a slice of BROKEN_VARIANTS and their reports are read as one.
     */
    const runs = await Promise.all(
      Array.from({ length: shards }, async (_, shard) => {
        const out = join(dir, `report-${shard}.json`);
        const run = await promisify(execFile)(
          'npx',
          ['vitest', 'run', TARGET, '--reporter=json', `--outputFile=${out}`, '--testTimeout=30000'],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PARLEY_CONFORMANCE_BROKEN: '1',
              PARLEY_CONFORMANCE_BROKEN_SHARD: `${shard}/${shards}`,
              CI: '1',
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        ).catch((err: { stdout?: string; stderr?: string }) => err);
        return { shard, out, log: `${run.stdout ?? ''}${run.stderr ?? ''}` };
      }),
    );
    stdout = runs.map((r) => r.log).join('\n');
    // Copy the evidence out BEFORE anything can throw on it: a child that produced no parseable
    // report is exactly the case whose output is worth reading.
    mkdirSync(KEPT_RUN, { recursive: true });
    writeFileSync(join(KEPT_RUN, 'run.log'), stdout);
    for (const r of runs) writeFileSync(join(KEPT_RUN, `run-${r.shard}.log`), r.log);
    const parsed = runs.map((r) => {
      const raw = readFileSync(r.out, 'utf8');
      writeFileSync(join(KEPT_RUN, `report-${r.shard}.json`), raw);
      return JSON.parse(raw) as JsonReport;
    });
    const merged: JsonReport = {
      startTime: Math.min(...parsed.map((p) => p.startTime)),
      testResults: parsed.flatMap((p) => p.testResults),
    };
    keptReportText = JSON.stringify(merged);
    writeFileSync(join(KEPT_RUN, 'report.json'), keptReportText);
    keptRun = KEPT_RUN;
    report = merged;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Budget for the WHOLE nested suite, not for any one case in it: the child runs every clause
  // against every broken variant. Keep the headroom large, so that a clause added to the shared
  // suite — which is the point of the suite — cannot turn every check in this file into a SKIP.
}, 1_800_000);

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

  /**
   * The diagnostic a failing row actually PRINTED, recovered from the child's own output:
   * vitest renders `expect(actual, 'why')` as `AssertionError: why: expected …`. Rows that failed
   * without a custom message carry no `why` and are not counted.
   */
  const printedDiagnostics = (): string[] =>
    results()
      .flatMap((row) => row.failureMessages ?? [])
      .map((failure) => /^AssertionError: ([\s\S]*?): expected /.exec(failure)?.[1])
      .filter((why): why is string => why !== undefined && why.length > 0);

  /**
   * What cannot be pinned or truncated is what the child run printed. Every diagnostic a broken
   * variant made the runner emit has to be one this scan knows about; a parser that drops a
   * quoting style, a nesting depth or the tail of its own output fails here rather than shrinking
   * the table below in silence.
   *
   * The floor is `CLAUSES.length` — a figure that does NOT move with the scanner. It used to be
   * `diagnosed.length / 2`, which is derived from the scanner's own output: a scan that lost
   * twenty of its twenty-four entries lowered the bar it was being held to by the same amount and
   * stayed green. What this guards is the recovery of `printedDiagnostics` itself going blind (a
   * change in how the runner renders a message), which would otherwise satisfy the subset check
   * below vacuously.
   */
  it('knows every diagnostic the broken variants actually printed', () => {
    const printed = [...new Set(printedDiagnostics())];
    expect(
      printed.length,
      'the broken variants printed almost no diagnostics — either they have stopped reaching the ' +
        'assertions that carry one, or the recovery below can no longer read what the runner ' +
        'prints, and the subset check is then satisfied by an empty list',
    ).toBeGreaterThanOrEqual(CLAUSES.length);
    expect(
      printed.filter((why) => !diagnosed.some((d) => why.includes(d) || d.includes(why))),
      'the runner printed a diagnostic this scan does not know about, so nothing requires a ' +
        'control for it. Either the scan cannot see how that assertion is written, or it is ' +
        'dropping output it used to find',
    ).toEqual([]);
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

  /**
   * A capability whose arms the probe cannot NAME gets no row below, so nothing here would require
   * a control for it. Each such field therefore has to say why it cannot be tabulated and what
   * covers it instead — a field that lands here with no entry is a capability whose coverage
   * nothing is asking about, which is the state this whole describe exists to forbid.
   */
  const UNTABULATED_REASONS: Record<string, string> = {
    concurrentPost:
      'its arms are a FUNCTION and the string that says the backend has no such thing. Every ' +
      'case that branches on it grades something on both arms, which the guarded-region check in ' +
      '`runConformanceSuite` enforces per case.',
    refusesContentShapes:
      'its arms are a LIST of labels, not a value the probe can name. Tabulating it would also ' +
      'demand a reference fixture that PASSES while declaring every content shape refused, and no ' +
      'plugin in this repo refuses one. Covered instead by the `content-shape-declaration` entry ' +
      'in ASSERTED_PROPERTIES, which the table above requires a control for, and by three of ' +
      'them: refusing every shape while declaring none, refusing one while declaring none, and ' +
      'declaring a refusal the backend does not have.',
  };

  it('records, for every capability the probe cannot tabulate, what covers it instead', () => {
    expect(
      UNTABULATED_CAPABILITIES.filter((field) => UNTABULATED_REASONS[field] === undefined),
      'this context field has arms the probe cannot name, so no row below requires a control for ' +
        'either of them, and nothing here says what does. Record why it cannot be tabulated and ' +
        'what covers it — or give it an entry in ASSERTED_PROPERTIES, which does require one',
    ).toEqual([]);
    expect(
      Object.keys(UNTABULATED_REASONS).filter((f) => !UNTABULATED_CAPABILITIES.includes(f)),
      'this field is recorded as untabulated but the probe now names its arms, so the rows above ' +
        'grade it and the excuse is stale',
    ).toEqual([]);
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

/**
 * The live-death table's own reach, the same way the switch table's is graded. Each row stands for a
 * threshold a live path can die at while answering every read the rest of the suite makes, and each
 * is a figure set against the floor's own: a count above the depth that case draws, an age past the
 * span it idles for, or a topic deeper than the backlog it seeds is a control that fires nowhere and
 * reads in the report as coverage.
 */
describe('every way a live path can die is reached by the case built to catch it', () => {
  type Delivery = Parameters<(typeof LIVE_DEATHS)[number]['drops']>[0];

  /** A delivery the floor really makes, at a chosen depth — payload and writer drawn, as it draws them. */
  const atDepth = (offered: number): Delivery => ({
    offered,
    subscriptionAgeMs: 0,
    topicRows: QUIET_BACKLOG_ROWS + offered,
    content: livePayload(),
    senderHandle: String(liveWriter()),
  });

  /**
   * Every delivery the floor is GUARANTEED to make, derived from the loop that makes them rather
   * than hand-built: the shallowest depth it ever draws, the idle span it holds the subscription
   * open across from its second message on, the backlog it seeds, and the content each iteration
   * carries — the drawn token alone once the shared table runs out.
   *
   * A SET rather than one point, because the content rows are reachable only on the iterations that
   * carry a shape, and a single point that had to satisfy every row at once could only ever be one
   * of them. DRAWN where the floor draws, so these rows grade the generator rather than a sample
   * somebody typed here to make the table pass.
   */
  const guaranteed = (): Delivery[] =>
    Array.from({ length: QUIET_POSTS_MIN }, (_unused, i) => {
      const shape = CONTENT_SHAPES[i]?.[1];
      return {
        offered: i + 1,
        subscriptionAgeMs: i >= 1 ? QUIET_IDLE_MS : 0,
        topicRows: QUIET_BACKLOG_ROWS + i + 1,
        content: shape === undefined ? livePayload() : `${livePayload()} ${shape}`,
        senderHandle: String(liveWriter()),
      };
    });

  it('derives more than one guaranteed delivery, so the rows below are not one point', () => {
    expect(guaranteed().length).toBeGreaterThan(CONTENT_SHAPES.length);
    expect(new Set(guaranteed().map((d) => d.content)).size).toBe(guaranteed().length);
  });

  it.each(LIVE_DEATHS.map((d) => [d.when, d] as const))('%s is reached by that case', (_when, death) => {
    expect(
      guaranteed().filter((at) => death.drops(at)).length,
      'this predicate is true of no message the quiet-topic floor is guaranteed to send, so the ' +
        'control built on it delivers the whole case honestly and proves nothing',
    ).toBeGreaterThan(0);
  });

  /**
   * The count row's far edge, stated as the arithmetic rather than as a habit. The floor offers
   * `INDEPENDENT_WRITERS + depth` where the fixture has a second writer and `depth` alone where
   * `concurrentPost` is `'unsupported'`, so `QUIET_POSTS_MIN` is the reach BOTH arms guarantee —
   * and a control placed anywhere inside the drawn range would fire on a fraction of runs, which
   * reads in the report as coverage on the runs it happens to catch.
   */
  it('the count rows sit inside the reach BOTH capability arms guarantee', () => {
    const counting = LIVE_DEATHS.filter((d) => d.axis === 'count');
    expect(counting.length).toBeGreaterThan(1);
    for (const d of counting) {
      expect(
        d.drops(atDepth(QUIET_POSTS_MIN)),
        'this count row only fires deeper than the floor is GUARANTEED to reach. Where ' +
          "`concurrentPost` is 'unsupported' the floor's only writer is the subscriber, so what a " +
          'run guarantees is the drawn depth alone — and a row placed inside the drawn range fires ' +
          'on a fraction of runs, which reads as coverage on the runs it happens to catch',
      ).toBe(true);
    }
  });

  // A cap on SUBSCRIPTIONS is not a delivery predicate, so no row above can place it: what makes it
  // reachable is the suite opening more of them than the cap admits. Compare the two BINDINGS: the
  // cap used to be spelled `LIVE_SUBSCRIPTIONS - 1`, which made "the suite opens more than the
  // control drops" true for every value that constant could take, including one that reaches
  // nothing a session does.
  it('the suite opens more live subscriptions than the control it stands up drops', () => {
    expect(LIVE_SUBSCRIPTIONS).toBeGreaterThan(SUBSCRIPTION_CAP);
  });

  // …and the same comparison for ORDER. The reorder control shuffles a batch of REORDER_ABOVE, so
  // it fires on every run only while the narrowest burst the tail case draws is wider than that.
  it('the narrowest burst the suite draws is wider than the batch the reorder control shuffles', () => {
    expect(BURST_POSTS_MIN).toBeGreaterThan(REORDER_ABOVE);
    expect(BURST_POSTS_MAX).toBeGreaterThanOrEqual(BURST_POSTS_MIN);
  });

  // The latency control is the one row that does not drop, so no predicate above can place it: it
  // has to arrive late enough to fail the bound and early enough that the suite is still waiting.
  // Both figures are IMPORTED: the control's own delay is derived from these two, and a check that
  // recomputed it here graded its own arithmetic — halving `QUIET_DELIVERY_MS` in the suite left
  // this row green while the control that depends on it stopped failing anything.
  it('the late-delivery control lands between the bound it fails and the wait it must survive', () => {
    expect(LATE_DELIVERY_MS).toBeGreaterThan(QUIET_DELIVERY_MS);
    expect(LATE_DELIVERY_MS).toBeLessThan(DELIVERY_MS);
  });
});

describe('the suite rejects a non-conformant plugin', () => {
  /**
   * The evidence, kept. Every row in this describe is scored out of the child's report, and each
   * variant is bounded from above by a radius many of them sit exactly at — so one flaky case
   * anywhere in that child run reddens one row here and nothing else. Diagnosing which case, and
   * whether the child agreed with itself, is only possible from the run that produced it.
   */
  it('kept the child run beside this one, so a row that reddens can be diagnosed', () => {
    expect(keptRun).not.toBe('');
    expect(
      [join(keptRun, 'report.json'), join(keptRun, 'run.log')].filter((f) => !existsSync(f)),
      'the child run did not outlive this one. A row below that reddens once in many runs then ' +
        'leaves nothing to read: not which cases the child failed, not its output, not even ' +
        'whether the child agreed with itself',
    ).toEqual([]);
    // Kept files are THIS run's, byte for byte. The path used to be fixed and the only check on
    // its contents was a row count that is the same figure for every run, so a report another
    // worktree had written hours earlier satisfied it — and the copy meant to explain a red row
    // described a different run. Two agents on one machine interleave; a per-run path plus an
    // exact comparison is what makes the evidence attributable.
    expect(
      readFileSync(join(keptRun, 'report.json'), 'utf8'),
      'the kept report is not the one this run parsed',
    ).toBe(keptReportText);
    expect(
      readFileSync(join(keptRun, 'run.log'), 'utf8'),
      'the kept log is not this run’s output — a non-empty file is not evidence of anything; an ' +
        'npm notice banner alone satisfies a length check',
    ).toBe(stdout);
    const kept = JSON.parse(keptReportText) as JsonReport;
    expect(kept.testResults.flatMap((f) => f.assertionResults).length).toBe(results().length);
    expect(
      kept.startTime,
      'the child report predates this run, so it was written by another one',
    ).toBeGreaterThanOrEqual(PARENT_STARTED_AT);
  });

  // Without this the per-variant rows below read an empty report and pass having graded nothing.
  it('the child run collected every broken variant', () => {
    expect(report, `${keptRun}\n${stdout.slice(-4_000)}`).toBeDefined();
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

  /**
   * The ceiling, as the fraction of the suite it always was. Held as a literal it took a manual
   * raise every time a shared clause grew its own rows, and the last raise still refused the
   * control the `never settles` arm needed — 21 rows against a ceiling of 18, while the clause it
   * bounds was 21 of 57 cases. Derived, a clause that grows moves the ceiling with it.
   */
  const maxBlastRadius = (): number => Math.ceil(suiteCases() * MAX_BLAST_FRACTION);

  /** How many cases of ONE variant's run the `mustFail` of a control names — the clause it is aimed at. */
  const clauseSize = (mustFail: string): number =>
    rowsOf(BROKEN_VARIANTS[0]!.name).filter((r) => r.fullName.includes(mustFail)).length;

  /**
   * The ceiling one control may be declared to. A fraction of the SUITE is not self-scaling for a
   * control aimed at a whole parameterised clause: measured at head, the awaiting control fails 21
   * of 57 against a ceiling of 23, and BOTH numerator and denominator grow by 3 per fault shape
   * added — so (21+3n)/(57+3n) climbs toward 1 and crosses 2/5 at n=2. A control whose `mustFail`
   * names a whole clause is bounded by THAT CLAUSE; the fraction still bounds one that names a
   * single case, where breaking more than its share really does demonstrate nothing.
   */
  const ceilingFor = (mustFail: string): number =>
    Math.max(clauseSize(mustFail), maxBlastRadius());

  it('every variant ran the same whole suite, so a failure count is a fraction of something known', () => {
    const collected = BROKEN_VARIANTS.map((v) => [v.name, rowsOf(v.name).length] as const);
    expect(
      collected.filter(([, n]) => n !== suiteCases()),
      'a variant that did not run the same set of cases as the others — a bound on how many it ' +
        'fails cannot be compared against one that ran a different suite',
    ).toEqual([]);
    expect(suiteCases()).toBeGreaterThanOrEqual(MIN_SUITE_CASES);
    // The ceiling is only a bound if it is well under the whole suite: a fraction at or past 1
    // would admit a plugin that fails everything as a control for each case in turn.
    expect(MAX_BLAST_FRACTION).toBeLessThanOrEqual(1 / 2);
    expect(maxBlastRadius() * 2).toBeLessThanOrEqual(suiteCases());
  });

  /**
   * A parameterised clause is one `it.each` with a control calibrated against it, so a control that
   * fails MOST of its rows reads as coverage for ALL of them — the arm no variant touches is
   * invisible in every check above, which count rows without asking WHICH. Measured over the child
   * run at d4beaee: every shape of the handler-fault clause was n=237 failed=6 and `never settles`
   * was n=237 failed=0. The stalling arm — the one the clause's own doc calls "AWAITING the
   * handler, the obvious containment" — could have been deleted with this file green.
   *
   * Derived from the shared fault table, so a shape added there arrives needing a control rather
   * than inheriting one.
   */
  const FAULT_MARK = 'survives a handler that ';
  const HANDLER_FAULT_MARK = 'survives a handler that';

  const faultTitle = (row: Row): string | undefined => {
    const at = row.fullName.indexOf(FAULT_MARK);
    return at < 0 ? undefined : row.fullName.slice(at);
  };

  const shapeOf = (row: Row): string | undefined => {
    const title = faultTitle(row);
    if (title === undefined) return undefined;
    const rest = title.slice(FAULT_MARK.length);
    return [...FAILURE_SHAPE_NAMES]
      .filter((shape) => rest.startsWith(`${shape} `))
      .sort((a, b) => b.length - a.length)[0];
  };

  it.each(FAILURE_SHAPE_NAMES)('some variant fails every handler-fault row for "%s"', (shape) => {
    const rows = results().filter((row) => shapeOf(row) === shape);
    expect(
      rows.length,
      `no report row drives the "${shape}" arm of the shared fault table — the clause is not ` +
        'asking every backend for it',
    ).toBeGreaterThan(0);
    const titles = [...new Set(rows.map((row) => faultTitle(row) as string))];
    expect(
      titles.filter((title) => !rows.some((r) => r.status === 'failed' && faultTitle(r) === title)),
      `no broken plugin fails these rows, so the "${shape}" arm of the clause is asserted by ` +
        'nothing. Every other arm has a control; an arm without one can be deleted with this ' +
        'whole file green',
    ).toEqual([]);
  });

  /**
   * The declared radii, against the ceiling no control may be declared past. A number recorded
   * beside a variant is a promise that it still discriminates; past half the suite it does not,
   * whatever figure is written there — so raising one that far is refused rather than recorded.
   */
  it.each(BROKEN_VARIANTS.map((v) => [v.name, v.mustFail, blastRadiusOf(v)] as const))(
    'declares a blast radius for %s that a control could have',
    (name, mustFail, radius) => {
      expect(
        radius,
        `"${name}" is declared to fail ${radius} of ${suiteCases()} cases, past the ceiling of ` +
          `${ceilingFor(mustFail)} — a control that breaks more than the clause it names ` +
          `demonstrates nothing about the case it is registered for. Narrow the mutation until it ` +
          `is aimed at that clause`,
      ).toBeLessThanOrEqual(ceilingFor(mustFail));
    },
  );

  /**
   * The ceiling evaluated where it will be, not where it is. A rule that holds at today's table
   * size and fails at tomorrow's is a cliff the next person walks off; this row walks off it first.
   */
  it('the ceiling still admits a whole-clause control two fault shapes from now', () => {
    const clause = clauseSize(HANDLER_FAULT_MARK);
    const perShape = clause / FAILURE_SHAPE_NAMES.length;
    expect(perShape, 'the handler-fault clause is not a whole number of rows per shape').toBe(
      Math.round(perShape),
    );
    const added = 2 * perShape;
    expect(
      clause + added,
      `a control aimed at the whole handler-fault clause would fail ${clause + added} of ` +
        `${suiteCases() + added} cases two shapes from now. Bounding it by a fraction of the ` +
        'SUITE refuses it there — which is why the bound is the clause it names',
    ).toBeLessThanOrEqual(
      Math.max(clause + added, Math.ceil((suiteCases() + added) * MAX_BLAST_FRACTION)),
    );
  });

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
          `case it no longer shows "${mustFail}" is alive — or its blastRadius needs raising. ` +
          `The child run that produced this is kept at ${keptRun}:\n` +
          titles,
      ).toBeLessThanOrEqual(radius);
    },
  );
});
