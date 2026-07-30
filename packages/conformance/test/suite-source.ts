import { readFileSync } from 'node:fs';
import { CONTEXT_FIELDS } from '@sharptrick/parley-conformance';

/**
 * The suite's own source, and the parser two files read it with. Both `suite-shape` (does every case
 * still assert?) and `negative-control` (does every arm of every capability flag have a control?)
 * have to know which case branches on which flag, and a parser restated in each is drift waiting to
 * happen — the multi-line `it.each` head that was invisible to every check in this package was one
 * parser bug, not two.
 */
export const suiteSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

/**
 * Every `it(...)` body in the suite, split on the top-level case boundary. Keyed on the case's
 * OPENING only — an earlier version tried to match the whole `it.each(...)` head, so a case whose
 * table spanned several lines was invisible to every check built on this.
 */
export function cases(): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  const starts = [...suiteSource.matchAll(/^ {4}it(?:\.each)?\(/gm)];
  for (const [i, m] of starts.entries()) {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : suiteSource.length;
    const body = suiteSource.slice(from, to);
    // The title is the string literal the callback follows, not the first one in the body: an
    // `it.each` table's own cells come first and are not titles.
    out.push({ title: /\('([^']+)',\s*(?:async\b|\()/.exec(body)?.[1] ?? `case ${i}`, body });
  }
  return out;
}

/** The capability fields a case could branch on to buy itself out of asserting. */
export const CAPABILITY_FIELDS = Object.keys(CONTEXT_FIELDS).filter(
  (f) => !['plugin', 'freshTopic', 'cleanup'].includes(f),
);

/**
 * The capability fields with exactly TWO arms, derived from the validators rather than listed: a
 * field whose validator accepts both booleans and rejects a string selects one of two arms, and each
 * arm needs a fixture that takes it. Deriving it means a new boolean flag arrives as new rows
 * instead of as silently uncontrolled coverage.
 */
export const BOOLEAN_CAPABILITIES = CAPABILITY_FIELDS.filter((field) => {
  const accepts = CONTEXT_FIELDS[field as keyof typeof CONTEXT_FIELDS];
  return accepts(true) && accepts(false) && !accepts('either');
});

export function guardedBlock(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/**
 * The region as far as its first unconditional `return`. An arm that returns FIRST and asserts
 * afterwards has done nothing, and a check that greps the whole region for `expect(` reads the dead
 * tail as coverage — which is exactly how the cheapest coverage-for-a-boolean trade would be spelled
 * once the bare `return` itself is guarded.
 */
export const upToFirstReturn = (region: string): string => {
  const at = region.search(/\breturn;/);
  return at < 0 ? region : region.slice(0, at);
};

/**
 * Where a case body decides to do less. Detected as a SHAPE — a `ctx.<capability>` test followed by
 * a region — rather than by the one spelling `testCtx.skip()`, because the cheapest way to
 * reintroduce the coverage-for-a-boolean trade is a bare `return` that no spelling-match can see.
 */
export function guardedRegions(body: string): { field: string; region: string }[] {
  const out: { field: string; region: string }[] = [];
  for (const field of CAPABILITY_FIELDS) {
    for (const m of body.matchAll(new RegExp(`ctx\\.${field}\\b`, 'g'))) {
      const open = body.indexOf('{', m.index);
      if (open < 0) continue;
      const header = body.slice(body.lastIndexOf('\n', m.index) + 1, open + 1);
      if (!header.includes('if (')) continue;
      // The 'unsupported' sentinel is the one legitimate skip, and the skip check governs it. Keep
      // it exempt HERE only, so that a boolean flag can never borrow the same excuse.
      if (header.includes("'unsupported'")) continue;
      out.push({ field, region: upToFirstReturn(guardedBlock(body, open)) });
    }
  }
  return out;
}
