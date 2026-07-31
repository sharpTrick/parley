import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASSERTED_PROPERTIES,
  CLAUSES,
  CONTEXT_FIELDS,
  EARLY_RETURN_FRACTION,
  IDLE_BLOCK_FLOOR_MS,
  IDLE_BLOCK_MS,
  PAGING_VOLUME,
  pageLimitsFor,
  PARK_FRACTION,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
} from '@sharptrick/parley-conformance';
import {
  cases,
  casesIn,
  deferredPromises,
  guardedRegions,
  suiteSource as source,
} from './suite-source.js';

const vitestConfig = readFileSync(new URL('../../../vitest.config.ts', import.meta.url), 'utf8');

/** The harness's own per-case ceiling. Read, not restated: it is what pre-empts every budget below. */
function testTimeoutMs(): number {
  const found = /testTimeout:\s*([\d_]+)/.exec(vitestConfig)?.[1];
  return Number((found ?? '').replaceAll('_', ''));
}

/**
 * Every wall-clock budget the suite sets for itself, as `[what, ms]`. A budget ABOVE the harness's
 * `testTimeout` can never be reached: vitest kills the case first, so the carefully-worded
 * diagnostic the budget exists to produce is dead code and the operator gets a generic timeout.
 */
function selfImposedBudgets(): [string, number][] {
  const out: [string, number][] = [];
  const patterns = [
    /(?:timeout|blockMs):\s*([\d_]+)/g,
    /_MS\s*=\s*([\d_]+)/g,
    /Date\.now\(\)\s*\+\s*([\d_]+)/g,
  ];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) {
      out.push([m[0] as string, Number((m[1] as string).replaceAll('_', ''))]);
    }
  }
  return out;
}

const SKIP_SPELLINGS = [
  /\btestCtx\.skip\(\)/,
  /\bthis\.skip\(\)/,
  /\bit\.skip\b/,
  /\bdescribe\.skip\b/,
  /\bit\.skipIf\b/,
  /\bdescribe\.skipIf\b/,
];

describe('the suite grades every backend it certifies', () => {
  // Without this the checks below read an empty list and pass having examined nothing.
  it('parses the suite into its cases', () => {
    expect(cases().length).toBeGreaterThan(10);
    expect(cases().map((c) => c.title)).toContain('topics are isolated');
  });

  // Each formatting a case can take, because a case the parser cannot see is a case none of the
  // checks below grade — which is how a multi-line `it.each` table slipped past all of them.
  it.each([
    ['a plain it', 'since at the tail'],
    ['a single-line it.each', 'paging from a cursor with limit'],
    ['a multi-line it.each table', 'either round-trips'],
    ['an it whose callback takes the test context', 'multi-process writes'],
  ])('parses %s', (_label, clause) => {
    const found = cases().filter((c) => c.title.includes(clause));
    expect(found, `no case titled like "${clause}"`).toHaveLength(1);
    expect(found[0]!.body).toContain('expect(');
  });

  /**
   * The parser against the shapes it has to see, which the rows above cannot grade: a case nested
   * inside an inner `describe` does not exist in the suite today, and the day one does it must not
   * be invisible — that is a case with no clause, no README bullet and no negative control, running
   * against every certified backend and asserting whatever it likes.
   */
  const suiteAround = (body: string): string =>
    `export function runConformanceSuite(name, factory) {\n  describe('x', () => {\n${body}\n  });\n}\n`;

  it.each([
    ['a case at the suite depth', "    it('at the suite depth', async () => { expect(1).toBe(1); });", ['at the suite depth']],
    [
      'a case nested inside an inner describe',
      "    describe('a group', () => {\n      it('inside a describe', async () => { expect(1).toBe(1); });\n    });",
      ['inside a describe'],
    ],
    [
      'a case indented deeper for no reason',
      "      it('deeper by accident', async () => { expect(1).toBe(1); });",
      ['deeper by accident'],
    ],
    [
      'an it.each whose table spans lines',
      "    it.each([\n      ['a', 1],\n      ['b', 2],\n    ])('a table case %s', async (l, n) => { expect(n).toBe(n); });",
      ['a table case %s'],
    ],
    [
      'a modifier the parser has not met',
      "    it.concurrent('a concurrent case', async () => { expect(1).toBe(1); });",
      ['a concurrent case'],
    ],
  ])('sees %s', (_label, body, titles) => {
    expect(casesIn(suiteAround(body)).map((c) => c.title)).toEqual(titles);
  });

  // The other side of the same boundary: a helper OUTSIDE the suite function registers nothing
  // against a backend, so counting it as a case would make the clause↔case count meaningless.
  it('ignores an it() outside the suite function', () => {
    const source = `it('a self-test of this package', () => {});\n${suiteAround("    it('graded', async () => { expect(1).toBe(1); });")}`;
    expect(casesIn(source).map((c) => c.title)).toEqual(['graded']);
  });

  // A deleted or renamed clause used to cost nothing: the count was a `> 10` floor and one title was
  // pinned by hand. Now every clause the README advertises must still own a case, and the case count
  // must match the clause count — so a case cannot vanish, and a new one cannot go unregistered.
  it.each(CLAUSES.map((c) => [c]))('still grades the clause %s', (clause) => {
    expect(cases().filter((c) => c.title.includes(clause)).length).toBeGreaterThan(0);
  });

  it('registers exactly one case per clause and no unregistered case', () => {
    const unclaimed = cases()
      .map((c) => c.title)
      .filter((title) => !CLAUSES.some((clause) => title.includes(clause)));
    expect(unclaimed, 'a case no clause in CLAUSES names').toEqual([]);
    expect(cases()).toHaveLength(CLAUSES.length);
  });

  // A capability flag whose false branch is a SKIP trades coverage for a boolean: the backend that
  // declares it loses the only cases that would have caught the behaviour. The only legitimate skip
  // is a capability the backend cannot represent AT ALL, which the context states as 'unsupported'.
  it('only ever skips on a capability the backend cannot represent at all', () => {
    const skipping = cases().filter((c) => SKIP_SPELLINGS.some((s) => s.test(c.body)));
    expect(skipping.length).toBeGreaterThan(0); // the check is not vacuous
    const unjustified = skipping.filter((c) => !c.body.includes("=== 'unsupported'"));
    expect(unjustified.map((c) => c.title)).toEqual([]);
  });

  // The same trade, spelled as a bare `return` instead of a skip — invisible to any check that greps
  // for `skip`. Every region a case guards on a capability has to assert something.
  //
  // A row per REGION, not per case: only a few cases carry a capability guard at all, so a table
  // over every registered case spent most of its rows looping over an empty list — indistinguishable
  // in the report from the rows that grade something.
  const guardedByCase = (): [string, string, string][] =>
    cases().flatMap((c) =>
      guardedRegions(c.body).map(
        ({ field, region }) => [field, c.title, region] as [string, string, string],
      ),
    );

  it('finds capability-guarded regions, so the rows below are not an empty table', () => {
    expect(guardedByCase().length).toBeGreaterThan(3);
  });

  it.each(guardedByCase())('makes the `%s` branch of "%s" assert', (field, title, region) => {
    expect(region, `\`ctx.${field}\` in "${title}" guards a region that asserts nothing`).toContain(
      'expect(',
    );
  });

  // The detector itself, against the shapes it has to recognize — so it cannot regress to knowing
  // exactly one spelling, which is how it started.
  it.each([
    ['a testCtx.skip()', "it('x', async (testCtx) => { testCtx.skip(); });", true],
    ['a this.skip()', "it('x', async function () { this.skip(); });", true],
    ['an it.skip', "it.skip('x', async () => { expect(1).toBe(1); });", true],
    ['a describe.skip', "describe.skip('x', () => {});", true],
    ['an it.skipIf', "it.skipIf(true)('x', () => {});", true],
    ['an ordinary case', "it('x', async () => { expect(1).toBe(1); });", false],
  ])('recognizes %s as a skip: %s', (_label, snippet, isSkip) => {
    expect(SKIP_SPELLINGS.some((s) => s.test(snippet))).toBe(isSkip);
  });

  it.each([
    ['a bare return on a flag', 'if (!ctx.supportsBlockingFetch) { return; }', 1, false],
    ['an asserting arm', 'if (!ctx.supportsBlockingFetch) { expect(1).toBe(1); return; }', 1, true],
    [
      // The shape that defeated the first version of this checker: the guarded block asserts
      // nothing, but code AFTER the guard does, so a region running to the end of the body passes.
      'a bare return followed by assertions outside the guard',
      'if (!ctx.carriesSenderIdentity) {\n  return;\n}\nexpect(1).toBe(1);',
      1,
      false,
    ],
    [
      "the 'unsupported' sentinel, which the skip check governs instead",
      "if (ctx.concurrentPost === 'unsupported') { testCtx.skip(); return; }",
      0,
      true,
    ],
    [
      // The same trade one line further down: leave the assertions in place and step over them.
      'an arm that returns before the assertions it still contains',
      'if (!ctx.supportsBlockingFetch) {\n  return;\n  expect(1).toBe(1);\n}',
      1,
      false,
    ],
  ])('sees %s', (_label, snippet, regionCount, asserts) => {
    const regions = guardedRegions(snippet);
    expect(regions).toHaveLength(regionCount);
    expect(regions.every((r) => r.region.includes('expect('))).toBe(asserts);
  });

  /**
   * A page-size row that pages IDENTICALLY to another row discriminates nothing and still costs a
   * fresh connect/teardown on every backend. Three of the five rows used to be the same single-page
   * case, and the uneven truncation — where a page-boundary off-by-one lives — was not a row at all.
   * Graded as a property of the generator against the volume, so lowering the message list fails
   * here instead of quietly collapsing the table again.
   */
  describe('the page-size table', () => {
    const remaining = PAGING_VOLUME.length - 1;
    const pageShape = (limit: number): string => {
      const pages: number[] = [];
      for (let left = remaining; left > 0; left -= limit) pages.push(Math.min(limit, left));
      return pages.join('+');
    };
    const shapes = (): string[] => pageLimitsFor(remaining).map(pageShape);

    it('pages differently on every row', () => {
      expect(shapes().length).toBeGreaterThan(3);
      expect(new Set(shapes()).size).toBe(shapes().length);
    });

    it('covers the shapes a page-boundary cursor bug needs', () => {
      // One at a time, an exact division into several pages, an uneven final page, and one whole page.
      expect(shapes()).toContain(Array.from({ length: remaining }, () => '1').join('+'));
      expect(shapes().some((s) => s.split('+').length > 2 && new Set(s.split('+')).size === 1)).toBe(
        true,
      );
      expect(
        shapes().some((s) => {
          const pages = s.split('+');
          return pages.length > 1 && pages.at(-1) !== pages[0];
        }),
      ).toBe(true);
      expect(shapes()).toContain(String(remaining));
    });
  });

  /**
   * A latency bound compared against the budget that produced it discriminates nothing: "the plugin
   * returned inside the budget it was handed" is true of a plugin that parked for all but the last
   * millisecond of it. The since-less blocking arm offered 19 000 ms and asserted `< 19_000`, so a
   * plugin that parks on every cursor-less `parley_fetch_recent` was certified.
   *
   * The paired half is a BROKEN_VARIANTS control that parks for a FRACTION of the budget — this row
   * forbids the degenerate bound, the control forbids a merely lenient one.
   */
  describe('no elapsed-time bound is the budget that produced it', () => {
    const EXPORTED: Record<string, number> = {
      IDLE_BLOCK_FLOOR_MS,
      IDLE_BLOCK_MS,
      SINCELESS_BLOCK_MS,
      SINCELESS_RETURN_MS,
    };
    const figure = (token: string): number =>
      EXPORTED[token] ?? Number(token.replaceAll('_', ''));

    const budgetsOf = (body: string): string[] =>
      [...body.matchAll(/blockMs:\s*([A-Za-z_][\w]*|[\d_]+)/g)].map((m) => m[1] as string);
    const boundsOf = (body: string): string[] =>
      [...body.matchAll(/toBeLessThan\(\s*([A-Za-z_][\w]*|[\d_]+)\s*\)/g)].map((m) => m[1] as string);

    const blocking = (): { title: string; body: string }[] =>
      cases().filter((c) => budgetsOf(c.body).length > 0);

    it('finds cases that offer a blockMs budget, so the row below grades something', () => {
      expect(blocking().length).toBeGreaterThan(0);
      expect(blocking().flatMap((c) => boundsOf(c.body)).length).toBeGreaterThan(0);
      expect(figure('SINCELESS_BLOCK_MS')).toBe(SINCELESS_BLOCK_MS);
      expect(figure('5000')).toBe(5000);
    });

    it.each(blocking().map((c) => [c.title, c.body] as const))(
      '"%s" bounds elapsed time strictly under every budget it hands out',
      (_title, body) => {
        const budgets = budgetsOf(body).map(figure);
        for (const token of boundsOf(body)) {
          expect(
            budgets,
            `the elapsed bound \`${token}\` is one of the blockMs budgets this case offers, so a ` +
              `plugin that parks for the whole budget still satisfies it`,
          ).not.toContain(figure(token));
        }
      },
    );
  });

  /**
   * The budget rows below grade a budget's SIZE; this grades whether it can be reported at all. The
   * interleaved reader's 15 s give-up threw from a promise nothing had subscribed to yet, so on a
   * backend whose 100 concurrent posts take longer than that, the run reports an unhandled rejection
   * and loses every other case in the file — instead of the one red case naming the stuck topic.
   */
  describe('every eagerly-started promise can report its own failure', () => {
    const deferred = (): [string, string, boolean][] =>
      cases().flatMap((c) =>
        deferredPromises(c.body).map(
          ({ name, handled }) => [c.title, name, handled] as [string, string, boolean],
        ),
      );

    it('finds eagerly-started promises, so the rows below are not an empty table', () => {
      expect(deferred().length).toBeGreaterThan(1);
    });

    it.each(deferred())('"%s" handles `%s` at creation', (_title, name, handled) => {
      expect(
        handled,
        `\`${name}\` is awaited only after another await, so a rejection in between has no handler ` +
          `— attach one where it is created and rethrow after the await`,
      ).toBe(true);
    });

    // The detector against the shapes it has to tell apart, so it cannot regress to finding nothing
    // — which would make every row above pass by grading an empty list.
    it.each([
      [
        'an eager promise awaited after another await',
        'const p = go();\nawait other();\nawait p;',
        ['p'],
        false,
      ],
      [
        'the same promise handled at creation',
        'const p = go().catch((e) => { failure = e; });\nawait other();\nawait p;',
        ['p'],
        true,
      ],
      ['a promise awaited in the next statement', 'const p = go();\nawait Promise.all([p, q]);', [], true],
      ['a promise awaited in the same statement', 'const p = await go();\nawait other();\np.x;', [], true],
      ['a function definition awaited later', 'const p = () => go();\nawait other();\nawait p();', [], true],
    ])('sees %s', (_label, snippet, names, allHandled) => {
      expect(deferredPromises(snippet).map((d) => d.name)).toEqual(names);
      expect(deferredPromises(snippet).every((d) => d.handled)).toBe(allHandled);
    });
  });

  /**
   * A bound on ELAPSED TIME is the one kind of assertion neither registry above can name: it is not a
   * `Message` field and not a seam call, so `BROKEN_VARIANTS` had no way to be required to cover one.
   * The idle arm's floor arrived that way and could be deleted — with the negative control included —
   * while a plugin that returns instantly on a native `blockMs` kept being certified. Each timing
   * bound now names a property in `ASSERTED_PROPERTIES`, which the negative control does require a
   * variant for, so the next one cannot arrive uncontrolled.
   */
  describe('every elapsed-time bound names a property the negative control covers', () => {
    const timingBounds = (body: string): number =>
      [...body.matchAll(/expect\(\s*Date\.now\(\) - \w+/g)].length;
    const namedProperties = (body: string): string[] =>
      ASSERTED_PROPERTIES.filter((property) => body.includes(property));
    const timed = (): { title: string; body: string }[] =>
      cases().filter((c) => timingBounds(c.body) > 0);

    it('finds elapsed-time bounds, so the rows below are not an empty table', () => {
      expect(timed().reduce((n, c) => n + timingBounds(c.body), 0)).toBeGreaterThan(3);
    });

    it.each(timed().map((c) => [c.title, c.body] as const))(
      '"%s" names one property per elapsed-time bound it asserts',
      (title, body) => {
        expect(
          namedProperties(body).length,
          `"${title}" asserts on elapsed time ${timingBounds(body)} time(s) but names ` +
            `${namedProperties(body).length} of ASSERTED_PROPERTIES — a timing bound no property ` +
            `names is one no BROKEN_VARIANTS entry has to fail`,
        ).toBeGreaterThanOrEqual(timingBounds(body));
      },
    );

    // The two parking controls exist to fail a bound each; a fraction drifting to the wrong side of
    // one turns the control into a plugin that passes, which reads in the report as coverage.
    it('each control still lands on the failing side of the bound it exists to fail', () => {
      expect(SINCELESS_BLOCK_MS * PARK_FRACTION).toBeGreaterThan(SINCELESS_RETURN_MS);
      expect(IDLE_BLOCK_MS * EARLY_RETURN_FRACTION).toBeLessThan(IDLE_BLOCK_FLOOR_MS);
      expect(EARLY_RETURN_FRACTION).toBeGreaterThan(0);
    });
  });

  it('reads a testTimeout out of the harness config, so the budget rows below grade something', () => {
    expect(testTimeoutMs()).toBeGreaterThan(0);
    expect(selfImposedBudgets().length).toBeGreaterThan(3);
  });

  it.each(selfImposedBudgets())('keeps the budget `%s` under the harness timeout', (_what, ms) => {
    expect(ms).toBeLessThan(testTimeoutMs());
  });

  // The teardown must not dereference the binding the CASES use: that binding is assigned only
  // after validation, so an `await ctx.cleanup()` in `afterEach` throws a TypeError on exactly the
  // fixture whose live connection most needs closing. Behaviour is graded against `openContext` in
  // context-validation.test.ts; this is the wiring that has to keep reaching it.
  it('tears the fixture down through a binding a rejected fixture cannot leave unassigned', () => {
    const setup = /beforeEach\(async \(\) => \{[\s\S]*?\n {4}\}\);/.exec(source)?.[0];
    const teardown = /afterEach\(async \(\) => \{[\s\S]*?\n {4}\}\);/.exec(source)?.[0];
    expect(setup, 'no beforeEach found').toBeDefined();
    expect(teardown, 'no afterEach found').toBeDefined();
    expect(setup as string).toContain('openContext');
    expect(teardown as string).not.toMatch(/\bctx\b/);
  });

  // A required context field nobody reads is a field a fixture author must supply for nothing —
  // and, worse, looks like coverage.
  // Matched as a property READ rather than as `ctx.<field>`: the teardown deliberately does not go
  // through `ctx`, and pinning that one spelling would force it back onto the binding a rejected
  // fixture leaves unassigned.
  it.each(Object.keys(CONTEXT_FIELDS))('reads the required field `%s`', (field) => {
    expect(source, `nothing in the suite reads \`${field}\``).toMatch(new RegExp(`\\.${field}\\b`));
  });

  // Both arms of each boolean capability must ASSERT. Pinned by name so that deleting the weaker
  // arm — the thing that made the flag honest — is a failure, not a silent loss.
  it.each([
    ['supportsBlockingFetch', 'blockMs is honoured natively or ignored promptly'],
    ['carriesSenderIdentity', 'distinct senders are not collapsed'],
    ['absentTopicBehaviour', 'never-posted topic'],
  ])('gives `%s` a false arm that still asserts', (field, title) => {
    const owner = cases().find((c) => c.title.includes(title));
    expect(owner, `no case titled like "${title}"`).toBeDefined();
    const body = (owner as { body: string }).body;
    expect(body).toContain(`ctx.${field}`);
    expect(body).toMatch(/\}\s*else\s*\{|if \(!ctx\.|if \(\(ctx\./);
    const arms = body.split(/\}\s*else\s*\{|if \(!ctx\.|if \(\(ctx\./);
    for (const arm of arms.slice(1)) expect(arm).toContain('expect(');
  });
});
