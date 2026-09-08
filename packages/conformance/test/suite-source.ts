import { readdirSync, readFileSync } from 'node:fs';
import {
  CAPABILITY_FIELDS,
  type ConformanceContext,
  CONTEXT_FIELDS,
} from '@sharptrick/parley-conformance';

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
    // `it.each` table's own cells come first and are not titles. Whitespace is allowed between the
    // `(` and the title, so a head prettier wrapped — `it.each(table)(\n  'title',\n  async …` —
    // is not a case this parser reads as `case 0`, invisible to every check built on it.
    out.push({ title: /\(\s*'([^']+)',\s*(?:async\b|\()/.exec(body)?.[1] ?? `case ${i}`, body });
  }
  return out;
}

export const cases = (): { title: string; body: string }[] =>
  suiteSources.flatMap((source) => casesIn(source));

export { CAPABILITY_FIELDS };

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A capability with a handful of named arms: what to call it, and which arm a fixture takes. */
export interface CapabilityAxis {
  name: string;
  arms: unknown[];
  armOf: (ctx: ConformanceContext) => unknown;
}

/**
 * The arms a capability can be NAMED by, probed against each validator. Deliberately wider than
 * booleans: derived as `accepts(true) && accepts(false)`, the table graded `carriesSenderIdentity`
 * and silently skipped `absentTopicBehaviour`, whose two arms select which half of the seam's
 * absent-topic MAY runs — so one of them could have had no control at all.
 */
const ARM_CANDIDATES: unknown[] = [true, false, 'empty-page', 'throws', 'unsupported', 0, 1, ''];

const armsOf = (field: string): unknown[] => {
  const accepts = CONTEXT_FIELDS[field as keyof typeof CONTEXT_FIELDS];
  return ARM_CANDIDATES.filter((candidate) => accepts(candidate));
};

/**
 * Every context field whose arms are values, each needing a fixture that takes each of them — so a
 * new flag arrives as new rows instead of as silently uncontrolled coverage.
 */
export const CAPABILITY_AXES: CapabilityAxis[] = CAPABILITY_FIELDS.filter(
  (field) => armsOf(field).length > 1,
).map((field) => ({
  name: field,
  arms: armsOf(field),
  armOf: (ctx: ConformanceContext): unknown => (ctx as unknown as Record<string, unknown>)[field],
}));

/**
 * Capability fields the probe above cannot turn into rows, because their arms are not values it can
 * name: `concurrentPost` is a FUNCTION or the string that says the backend has no such thing.
 * Recorded, so that a field added later with arms nothing tabulates arrives here as a red row rather
 * than as an axis silently missing from the table.
 */
export const UNTABULATED_CAPABILITIES: string[] = CAPABILITY_FIELDS.filter(
  (field) => armsOf(field).length <= 1,
);

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

/**
 * The text after the first TOP-LEVEL comma of an argument list, or undefined when there is none.
 *
 * String-aware, so that a comma INSIDE a literal is not read as the argument separator: without it
 * `expect(text, 'why')` split at the comma of a payload like `'a, b'` and the diagnostic that
 * followed was invisible to the scan — and a diagnostic this cannot see is one nothing asks for a
 * control for.
 */
function afterFirstArgument(args: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i] as string;
    if (ch === '\'' || ch === '"' || ch === '`') {
      i = endOfLiteral(args, i);
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) return args.slice(i + 1);
  }
  return undefined;
}

/** The index of the closing quote of the literal opening at {@link open}; interpolations included. */
function endOfLiteral(text: string, open: number): number {
  const quote = text[open] as string;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      for (; i < text.length && depth > 0; i++) {
        const inner = text[i] as string;
        if (inner === '\'' || inner === '"' || inner === '`') i = endOfLiteral(text, i);
        else if (inner === '{') depth++;
        else if (inner === '}') depth--;
      }
      i--;
      continue;
    }
    if (ch === quote) return i;
  }
  return text.length;
}

/**
 * The first literal fragment of every DIAGNOSED assertion in the suite — `expect(actual, 'why this
 * matters')`. The negative control requires each one to appear in some broken variant's failure
 * output, which is the only check here that grades an assertion rather than a clause, a field or a
 * capability arm: a clause keeps its control while an assertion INSIDE it has none, because the
 * control fails through the assertion beside it, and the registries above cannot see the difference.
 *
 * The fragment rather than the whole message, so that a diagnostic assembled from several literals
 * is still matched against what the runner prints.
 *
 * BOTH quote styles. Single quotes alone made this blind to exactly the diagnostics that carry an
 * apostrophe — which is why they are double-quoted — and a diagnostic this cannot see is one the
 * negative control never asks for a control for. The run-level cross-check in `negative-control`
 * is what catches the next such hole rather than a third quoting rule here.
 */
export function diagnosedAssertions(source: string): string[] {
  return diagnosticSites(source)
    .map((site) => site.message)
    .filter((message): message is string => message !== undefined);
}

/** An `expect(actual, …)` carrying a second argument, and the literal fragment recovered from it. */
export interface DiagnosticSite {
  /** The second argument as written, so a form this cannot read can be named in a failure. */
  argument: string;
  message: string | undefined;
}

/**
 * Every `expect(...)` in the suite that carries a second argument, whether or not a message could be
 * recovered from it. The COUNT is what makes this scan checkable: a form it cannot read shows up as
 * a site with no message rather than as a shorter table, and a table that silently shrinks is a set
 * of assertions nothing asks for a control for. Three such forms were invisible at once — a template
 * opening with an interpolation, a message bound to a `const`, and a first argument holding a comma.
 */
export function diagnosticSites(source: string): DiagnosticSite[] {
  const bound = messageConstants(source);
  const out: DiagnosticSite[] = [];
  for (const m of source.matchAll(/\bexpect\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    const rest = afterFirstArgument(parenthesized(source, open));
    if (rest === undefined) continue;
    out.push({ argument: rest.trim(), message: messageIn(rest, bound) });
  }
  return out;
}

const unescape = (text: string): string =>
  text.replaceAll("\\'", "'").replaceAll('\\"', '"').replaceAll('\\`', '`');

/**
 * The first STATIC fragment of a diagnostic argument — enough to recognise the message in what the
 * runner printed. A template is read past its interpolations rather than up to the first one, so a
 * message that OPENS with a drawn figure still yields the words after it.
 */
function messageIn(rest: string, bound: Record<string, string>): string | undefined {
  const quoted =
    /^\s*'((?:\\.|[^'\\])*)'/.exec(rest) ?? /^\s*"((?:\\.|[^"\\])*)"/.exec(rest);
  if (quoted !== null) return unescape(quoted[1] as string);
  const template = /^\s*`/.exec(rest);
  if (template !== null) {
    const body = rest.slice(template[0].length, endOfLiteral(rest, template[0].length - 1));
    const fragments = body
      .split(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g)
      .map((f) => unescape(f).trim())
      .filter((f) => f.length > 0);
    return fragments[0];
  }
  const name = /^\s*([A-Za-z_$][\w$]*)\s*[,)]?\s*$/.exec(rest.replace(/,\s*$/, ''));
  return name === null ? undefined : bound[name[1] as string];
}

/** `const NAME = '…'` bindings, so a diagnostic passed by name is still recognised. */
function messageConstants(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g,
  )) {
    out[m[1] as string] = unescape((m[2] ?? m[3]) as string);
  }
  return out;
}

/** A wall-clock budget the suite sets for itself; `ms` is null when its initializer names no figure. */
export interface SelfImposedBudget {
  what: string;
  initializer: string;
  ms: number | null;
  declaration: boolean;
}

/** An arithmetic expression starting at {@link from}, to the first character that cannot be part of one. */
function expressionAt(text: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[\w$.\s*/+-]/.test(ch)) break;
  }
  return text.slice(from, i).trim();
}

/**
 * What an initializer resolves to, or null when it is not arithmetic over {@link known} — never a
 * prefix of it. A scanner that reads the first literal of `90 * 1000` reports 90, so a budget four
 * times the harness timeout passes the row that exists to forbid one, and the diagnostic the budget
 * pays for is dead code.
 */
function evaluate(expr: string, known: Record<string, number>): number | null {
  const tokens = expr.match(/[A-Za-z_$][\w$]*|\d[\d_]*(?:\.\d+)?|[-+*/()]/g) ?? [];
  if (tokens.join('') !== expr.replace(/\s+/g, '')) return null;
  let at = 0;
  function primary(): number | null {
    const token = tokens[at++];
    if (token === undefined) return null;
    if (token === '(') {
      const inner = sum();
      return tokens[at++] === ')' ? inner : null;
    }
    if (token === '-') {
      const operand = primary();
      return operand === null ? null : -operand;
    }
    if (/^\d/.test(token)) return Number(token.replaceAll('_', ''));
    return known[token] ?? null;
  }
  function product(): number | null {
    let value = primary();
    while (value !== null && (tokens[at] === '*' || tokens[at] === '/')) {
      const operator = tokens[at++];
      const operand = primary();
      if (operand === null) return null;
      value = operator === '*' ? value * operand : value / operand;
    }
    return value;
  }
  function sum(): number | null {
    let value = product();
    while (value !== null && (tokens[at] === '+' || tokens[at] === '-')) {
      const operator = tokens[at++];
      const operand = product();
      if (operand === null) return null;
      value = operator === '+' ? value + operand : value - operand;
    }
    return value;
  }
  const value = sum();
  return at === tokens.length && value !== null && Number.isFinite(value) ? value : null;
}

/**
 * Every numeric binding the source declares, so a budget written as a name resolves to the figure
 * that name holds. Iterated, because a budget defined from another one is only resolvable once its
 * dependency is; a name declared twice with different figures is dropped rather than guessed at.
 */
function numericBindings(source: string, seed: Record<string, number>): Record<string, number> {
  const declared = [...source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=(?!=)\s*/g)].map(
    (m) => [m[1] as string, expressionAt(source, m.index + m[0].length)] as const,
  );
  const env: Record<string, number> = {};
  const conflicting = new Set<string>();
  for (let pass = 0; pass < declared.length && pass < 8; pass++) {
    for (const [name, init] of declared) {
      const value = evaluate(init, { ...env, ...seed });
      if (value === null) continue;
      if (env[name] !== undefined && env[name] !== value) conflicting.add(name);
      env[name] = value;
    }
  }
  for (const name of conflicting) delete env[name];
  return { ...env, ...seed };
}

const BUDGET_SITE =
  /(?:\b[A-Za-z_$][\w$]*_MS\s*=(?!=)|(?:timeout|blockMs):|Date\.now\(\)\s*\+)\s*/g;

/**
 * Every wall-clock budget the source sets for itself, with the figure it actually resolves to. A
 * budget ABOVE the harness's `testTimeout` can never be reached — vitest kills the case first — so
 * the figure, not a leading literal, is what has to be compared against it.
 */
export function budgetsIn(source: string, known: Record<string, number> = {}): SelfImposedBudget[] {
  const env = numericBindings(source, known);
  return [...source.matchAll(BUDGET_SITE)].map((m) => {
    const site = m[0].trim();
    const initializer = expressionAt(source, m.index + m[0].length);
    return {
      what: `${site} ${initializer}`,
      initializer,
      ms: evaluate(initializer, env),
      declaration: site.endsWith('='),
    };
  });
}
