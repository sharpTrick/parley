import { readdirSync, readFileSync } from 'node:fs';
import { CONTEXT_FIELDS } from '@sharptrick/parley-conformance';

const SRC = new URL('../src/', import.meta.url);

/**
 * The suite's own source, and the parser two files read it with. Both `suite-shape` (does every case
 * still assert?) and `negative-control` (does every arm of every capability flag have a control?)
 * have to know which case branches on which flag, and a parser restated in each is drift waiting to
 * happen — the multi-line `it.each` head that was invisible to every check in this package was one
 * parser bug, not two.
 *
 * EVERY module under `src/`, not one path: the graded cases live in `src/cases/*.ts` and a check
 * anchored on a single file grades only the cases that file happens to hold — the rest run against
 * every certified backend with no clause, no README bullet and no negative control.
 */
export const suiteSources: string[] = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => readFileSync(new URL(f, SRC), 'utf8'));

export const suiteSource = suiteSources.join('\n');

/**
 * Where a module's graded cases begin. Cases are registered by the exported function the suite
 * calls, so text before the first one registers nothing against a backend — matched as the SHAPE
 * rather than as `runConformanceSuite` by name, which now only wires the case modules together.
 */
const ENTRY = /^export (?:async )?function /m;

/**
 * Every `it(...)` body in the suite, split on the case boundary. Keyed on the case's OPENING only —
 * an earlier version tried to match the whole `it.each(...)` head, so a case whose table spanned
 * several lines was invisible to every check built on this.
 *
 * Scanned at ANY indentation inside {@link ENTRY}'s body, and over any `it.<modifier>`: a fixed
 * four-space prefix made a case nested one level deeper — inside a `describe` within the suite —
 * invisible to every meta-check in this package at once, so it needed no clause, no README bullet
 * and no negative control while running against every certified backend.
 */
export function casesIn(source: string): { title: string; body: string }[] {
  const at = source.search(ENTRY);
  const region = at < 0 ? source : source.slice(at);
  const out: { title: string; body: string }[] = [];
  const starts = [...region.matchAll(/^[ \t]*it(?:\.\w+)?\(/gm)];
  for (const [i, m] of starts.entries()) {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : region.length;
    const body = region.slice(from, to);
    // The title is the string literal the callback follows, not the first one in the body: an
    // `it.each` table's own cells come first and are not titles.
    out.push({ title: /\('([^']+)',\s*(?:async\b|\()/.exec(body)?.[1] ?? `case ${i}`, body });
  }
  return out;
}

export const cases = (): { title: string; body: string }[] =>
  suiteSources.flatMap((source) => casesIn(source));

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

/** The text inside the parentheses opening at {@link open}, paired to its closer. */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const EXECUTOR_HEAD =
  /^\s*(?:async\s+)?(?:\((?<parens>[^)]*)\)|(?<bare>\w+))\s*=>|^\s*(?:async\s+)?function\s*\w*\s*\((?<fn>[^)]*)\)/;

/**
 * Every `new Promise` executor in the suite, and whether it can settle the promise when the work
 * inside it FAILS. An executor that drives another promise and binds only `resolve` converts that
 * promise's rejection into two failures at once: the returned promise never settles, so the case
 * burns its whole timeout and reports a bare "Test timed out" naming no clause, and the rejection
 * reaches the process unhandled and is attributed to whichever unrelated case happened to be running.
 *
 * Scanned over the WHOLE module rather than over case bodies, so that a helper defined above the
 * first `it(` — which is where the suite's `postAfter` lived, invisible to every check keyed on
 * {@link casesIn} — is graded like anything else.
 */
export function promiseExecutors(
  source: string,
): { executor: string; drivesAPromise: boolean; settlesOnRejection: boolean }[] {
  const out: { executor: string; drivesAPromise: boolean; settlesOnRejection: boolean }[] = [];
  for (const m of source.matchAll(/\bnew\s+Promise\s*(?:<[^<>]*>)?\s*\(/g)) {
    const executor = parenthesized(source, (m.index as number) + m[0].length - 1);
    const head = EXECUTOR_HEAD.exec(executor);
    const params = (head?.groups?.parens ?? head?.groups?.bare ?? head?.groups?.fn ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const body = executor.slice(head?.[0].length ?? 0);
    const rejectParam = params[1];
    out.push({
      executor,
      drivesAPromise: /\.then\(|\.catch\(|\.finally\(|\bawait\b/.test(body),
      settlesOnRejection:
        /\.catch\(/.test(body) ||
        (rejectParam !== undefined && new RegExp(`\\b${rejectParam}\\b`).test(body)),
    });
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
