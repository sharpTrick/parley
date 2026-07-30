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

/** The initializer of a `const`/`let`, scanned to the `;` that ends it at nesting depth 0. */
function initializerAt(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string;
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (ch === ';' && depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/** A binding whose initializer is a function, not a promise already running. */
function definesAFunction(init: string): boolean {
  let depth = 0;
  for (let i = 0; i < init.length; i++) {
    const ch = init[i] as string;
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (depth === 0 && ch === '=' && init[i + 1] === '>') return true;
  }
  return false;
}

/**
 * Promises a case starts EAGERLY and first awaits only after some other `await` — the interleaved
 * reader's loop, a post scheduled to race a fetch. Between the two there is no handler, so a
 * rejection landing in that window (a self-imposed budget giving up while the writers are still
 * going) is a process-level unhandled rejection: it fails the whole FILE, with none of the
 * diagnostic the budget exists to produce, and takes every unrelated case with it.
 *
 * Reported with whether a handler is attached at creation, which is what makes the budget reachable
 * as this case's own failure.
 */
export function deferredPromises(body: string): { name: string; handled: boolean }[] {
  const out: { name: string; handled: boolean }[] = [];
  for (const m of body.matchAll(/\b(?:const|let)\s+(\w+)(?:\s*:[^=;]+)?\s*=\s*/g)) {
    const name = m[1] as string;
    const from = (m.index as number) + m[0].length;
    const init = initializerAt(body, from);
    if (/^await\b/.test(init) || definesAFunction(init)) continue;
    const rest = body.slice(from + init.length);
    // The awaiting use, matched WITH its `await`, so that the awaiting statement's own keyword is
    // not what the window below is measured against.
    const use = new RegExp(`await\\s+${name}\\b|await\\s+Promise\\.\\w+\\([^)]*\\b${name}\\b`).exec(
      rest,
    );
    if (use === null || !/\bawait\b/.test(rest.slice(0, use.index))) continue;
    out.push({ name, handled: /\.catch\(/.test(init) });
  }
  return out;
}

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
