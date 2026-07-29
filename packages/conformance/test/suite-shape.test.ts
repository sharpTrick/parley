import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUSES, CONTEXT_FIELDS } from '@sharptrick/parley-conformance';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

/**
 * Every `it(...)` body in the suite, split on the top-level case boundary. Keyed on the case's
 * OPENING only — an earlier version tried to match the whole `it.each(...)` head, so a case whose
 * table spanned several lines was invisible to every check in this file, title included.
 */
function cases(): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  const starts = [...source.matchAll(/^ {4}it(?:\.each)?\(/gm)];
  for (const [i, m] of starts.entries()) {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    const body = source.slice(from, to);
    // The title is the string literal the callback follows, not the first one in the body: an
    // `it.each` table's own cells come first and are not titles.
    out.push({ title: /\('([^']+)',\s*(?:async\b|\()/.exec(body)?.[1] ?? `case ${i}`, body });
  }
  return out;
}

/** The capability fields a case could branch on to buy itself out of asserting. */
const CAPABILITY_FIELDS = Object.keys(CONTEXT_FIELDS).filter(
  (f) => !['plugin', 'freshTopic', 'cleanup'].includes(f),
);

/**
 * Where a case body decides to do less. Detected as a SHAPE — a `ctx.<capability>` test followed by
 * a region — rather than by the one spelling `testCtx.skip()`, because the cheapest way to
 * reintroduce the coverage-for-a-boolean trade is a bare `return` that no spelling-match can see.
 */
function guardedBlock(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

function guardedRegions(body: string): { field: string; region: string }[] {
  const out: { field: string; region: string }[] = [];
  for (const field of CAPABILITY_FIELDS) {
    for (const m of body.matchAll(new RegExp(`ctx\\.${field}\\b`, 'g'))) {
      const open = body.indexOf('{', m.index);
      if (open < 0) continue;
      const header = body.slice(body.lastIndexOf('\n', m.index) + 1, open + 1);
      if (!header.includes('if (')) continue;
      // The 'unsupported' sentinel is the one legitimate skip, and the check above governs it. Keep
      // it exempt HERE only, so that a boolean flag can never borrow the same excuse.
      if (header.includes("'unsupported'")) continue;
      out.push({ field, region: guardedBlock(body, open) });
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
  it.each(cases().map((c) => [c.title]))('makes every capability branch of %s assert', (title) => {
    const owner = cases().find((c) => c.title === title) as { body: string };
    for (const { field, region } of guardedRegions(owner.body)) {
      expect(region, `\`ctx.${field}\` in "${title}" guards a region that asserts nothing`).toContain(
        'expect(',
      );
    }
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
  ])('sees %s', (_label, snippet, regionCount, asserts) => {
    const regions = guardedRegions(snippet);
    expect(regions).toHaveLength(regionCount);
    expect(regions.every((r) => r.region.includes('expect('))).toBe(asserts);
  });

  // A required context field nobody reads is a field a fixture author must supply for nothing —
  // and, worse, looks like coverage.
  it.each(Object.keys(CONTEXT_FIELDS))('reads the required field `%s`', (field) => {
    expect(source).toContain(`ctx.${field}`);
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
