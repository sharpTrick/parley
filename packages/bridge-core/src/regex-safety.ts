/**
 * Structural ReDoS screening, shared by every path that compiles a regex it did not author:
 * `post_topics` from an operator's config (validated at load), `postTopics` from an untrusted peer's
 * presence beat, and any {@link Allowlist} an embedder builds by hand. Node's RegExp backtracks, so
 * one hostile or merely careless source can wedge the single-threaded process.
 */

/**
 * Longest input a screened pattern is ever matched against. Callers MUST clamp or refuse longer
 * input, so that {@link MAX_AMBIGUITY} keeps meaning what it was calibrated to mean.
 */
export const MAX_MATCH_INPUT = 64;

/**
 * Most backtracking paths a screened source may be able to explore against an input of
 * {@link MAX_MATCH_INPUT} characters. Calibrated so the worst accepted source finishes in single-digit
 * milliseconds on V8.
 */
export const MAX_AMBIGUITY = 65_536;

/** Paths charged to one unbounded quantifier (`*`, `+`, `{n,}`) over a {@link MAX_MATCH_INPUT} input. */
const UNBOUNDED_COST = 16;

const GROUP_PREFIX = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][A-Za-z0-9_$]*>)/;

interface Brace {
  len: number;
  min: number;
  max: number;
}

function readBrace(src: string, i: number): Brace | null {
  const m = /^\{(\d*)(,(\d*))?\}/.exec(src.slice(i));
  if (!m || (m[1] === '' && m[3] === undefined)) return null;
  const min = m[1] === '' ? 0 : Number.parseInt(m[1]!, 10);
  const hasComma = m[2] !== undefined;
  const max = !hasComma
    ? min
    : m[3] === ''
      ? Number.POSITIVE_INFINITY
      : Number.parseInt(m[3]!, 10);
  return { len: m[0].length, min, max };
}

function repetitionCost(min: number, max: number): number {
  if (max === Number.POSITIVE_INFINITY) return UNBOUNDED_COST;
  return Math.min(Math.max(1, max - min + 1), UNBOUNDED_COST);
}

/**
 * Conservative ReDoS screen for a regex source, run BEFORE compiling it. A source is refused when
 * either:
 *
 *  - a group whose body is itself ambiguous (it contains a quantifier or an alternation) can repeat
 *    two or more times — the exponential signature (`(x+)+`, `(a|a)*`, `(x*){15}`, `(x?){250}`). V8
 *    unrolls `{n}`/`{n,m}` into sequential copies of the body, so a bounded count `>= 2` is as
 *    catastrophic as an unbounded one; only a bound of `<= 1` cannot compound. Or:
 *  - its ambiguity budget — the product of every independent choice the engine can backtrack over:
 *    alternation branches, optional/bounded repetitions, and {@link UNBOUNDED_COST} per unbounded
 *    quantifier — exceeds {@link MAX_AMBIGUITY}. This is what catches a quantifier-free blowup such as
 *    a chain of ambiguous alternations (`(a|aa)(a|aa)…`) or of optional atoms (`a?a?a?…a`), neither
 *    of which contains a nested quantifier at all.
 *
 * Character-class interiors and escaped metacharacters are treated as literal, and nesting is
 * over-approximated, so the screen is deliberately stricter than necessary; a legitimate topic
 * pattern is nowhere near either bound.
 *
 * A source the scan cannot follow to the end — an unterminated class, an unbalanced group, a
 * trailing escape — is refused rather than accepted: losing track of the grammar means the
 * remainder was never screened. So everything the screen accepts also compiles on its own.
 */
export function isRedosSafeSource(src: string): boolean {
  let budget = 1;
  const ambiguous: boolean[] = [false];
  const branches: number[] = [1];
  const charge = (factor: number): void => {
    budget = Math.min(budget * factor, Number.MAX_SAFE_INTEGER);
  };
  const markAmbiguous = (): void => {
    ambiguous[ambiguous.length - 1] = true;
  };

  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2;
      if (i > src.length) return false;
      continue;
    }
    if (ch === '[') {
      i++;
      if (src[i] === '^') i++;
      // Keep JS class semantics — a `]` here CLOSES the class (`[]`, `[^]`) rather than joining it,
      // so that the scan cannot run off the end and blind the screen to every atom that follows.
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      if (i >= src.length) return false;
      i++;
      continue;
    }
    if (ch === '(') {
      ambiguous.push(false);
      branches.push(1);
      i++;
      const prefix = GROUP_PREFIX.exec(src.slice(i));
      if (prefix) i += prefix[0].length;
      continue;
    }
    if (ch === ')') {
      if (ambiguous.length === 1) return false;
      const body = ambiguous.pop() ?? false;
      const branchCount = branches.pop() ?? 1;
      i++;
      let quantified = false;
      let quantMax = 1;
      let quantMin = 1;
      const q = src[i];
      if (q === '*' || q === '+') {
        quantified = true;
        quantMin = q === '+' ? 1 : 0;
        quantMax = Number.POSITIVE_INFINITY;
        i++;
      } else if (q === '?') {
        quantified = true;
        quantMin = 0;
        i++;
      } else if (q === '{') {
        const b = readBrace(src, i);
        if (b) {
          quantified = true;
          quantMin = b.min;
          quantMax = b.max;
          i += b.len;
        }
      }
      if (quantified && (src[i] === '?' || src[i] === '+')) i++;
      if (body && quantMax >= 2) return false;
      charge(branchCount);
      if (quantified) charge(repetitionCost(quantMin, quantMax));
      if (body || quantified) markAmbiguous();
      continue;
    }
    if (ch === '|') {
      branches[branches.length - 1]!++;
      markAmbiguous();
      i++;
      continue;
    }
    if (ch === '*' || ch === '+') {
      charge(UNBOUNDED_COST);
      markAmbiguous();
      i++;
      if (src[i] === '?' || src[i] === '+') i++;
      continue;
    }
    if (ch === '?') {
      charge(2);
      markAmbiguous();
      i++;
      if (src[i] === '?') i++;
      continue;
    }
    if (ch === '{') {
      const b = readBrace(src, i);
      if (b) {
        const cost = repetitionCost(b.min, b.max);
        charge(cost);
        if (cost > 1) markAmbiguous();
        i += b.len;
        if (src[i] === '?') i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (ambiguous.length !== 1) return false;
  charge(branches[0] ?? 1);
  return budget <= MAX_AMBIGUITY;
}
