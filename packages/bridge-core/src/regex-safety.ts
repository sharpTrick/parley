/**
 * Structural ReDoS screening, shared by every path that compiles a regex it did not author:
 * `post_topics` from an operator's config (validated at load) and `postTopics` from an untrusted
 * peer's presence beat. Node's RegExp backtracks, so one hostile or merely careless source can wedge
 * the single-threaded process.
 */

/**
 * Longest input we feed to a screened pattern. Topic names are short; clamping the compared string
 * caps the worst-case work of a low-degree match no matter how long the caller's string is.
 */
export const MAX_MATCH_INPUT = 64;

/**
 * Most unbounded (`*` / `+` / `{n,}`) quantifiers we allow in one untrusted source. A handful is
 * ample for a real topic pattern; capping the count bounds the polynomial-backtracking degree of even
 * a nesting-free source (sequential `.*.*…`).
 */
export const MAX_UNBOUNDED_QUANTIFIERS = 4;

/**
 * Longest input string we ever feed to an untrusted peer pattern. Our own topic names are short, so
 * clamping the compared string caps the worst-case work of a (screened, low-degree) match no matter
 * how long a self-configured topic is.
 */
const MAX_PEER_MATCH_INPUT = 64;

/**
 * Conservative structural ReDoS screen for an untrusted regex source, run BEFORE compiling it. Node's
 * `RegExp` backtracks, so a hostile source can wedge the whole single-threaded process; catastrophic
 * blowup needs one of two structural shapes and we reject both:
 *   - a quantifier that lets a group whose body itself contains a quantifier or alternation repeat
 *     TWO OR MORE times — the exponential/polynomial signature. This covers an UNBOUNDED outer
 *     quantifier (`(x+)+`, `(a|a)*`, `(x*){2,}`) AND a BOUNDED exact/range count `>= 2` (`(x*){15}`,
 *     `(x?){250}`, `(x+){2,5}`): V8 unrolls `{n}`/`{n,m}` into up to n sequential copies of the risky
 *     body, so a bounded exact count over a `*`/`?`-body is just as catastrophic as an unbounded one
 *     (empirically `([a-z-]*){15}[0-9]` hangs Node for ~8s on a 15-char input). Only a bound of `<= 1`
 *     (`?`, `{0,1}`, `{1}`) is safe, since a body matched at most once cannot compound; or
 *   - more than {@link MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (`.*.*…`) — a high-degree
 *     polynomial blowup. (Because a risky body repeated `>= 2` times is rejected above, any
 *     multiplicity from unrolling a `{n}` over an unbounded-quantifier body is already excluded — so
 *     the unbounded count here need not itself be scaled by the unroll factor.)
 * Character-class interiors and escaped metacharacters are treated as literal. It is deliberately
 * conservative (it may reject some safe-but-exotic sources); a legitimate topic pattern never needs a
 * nested quantifier. Anything that still slips through as un-compilable is caught by the `try/catch`
 * in {@link compilePeerPatterns}.
 */
export function isRedosSafeSource(src: string): boolean {
  let unbounded = 0;
  // Per-open-group flag: did this group's body contain a quantifier or alternation (directly, or
  // inherited from a nested non-quantified subgroup)? A quantified group with a risky body is the
  // catastrophic case. Index 0 is the implicit top level (never itself quantified).
  const risky: boolean[] = [false];
  // Parse a `{...}` quantifier at `i`; null when `{` is a literal brace, not a valid quantifier.
  // `unbounded` = open-ended reps (a comma is present, `{n,}`/`{n,m}`) — preserved for the polynomial
  // count. `max` = the largest repetition the quantifier permits (Infinity when open-ended) — used to
  // decide whether a risky body may repeat `>= 2` times.
  const readBrace = (i: number): { len: number; unbounded: boolean; max: number } | null => {
    const m = /^\{(\d*)(,(\d*))?\}/.exec(src.slice(i));
    if (!m || (m[1] === '' && m[3] === undefined)) return null; // `{}` / bare `{` ⇒ literal
    const min = m[1] === '' ? 0 : Number.parseInt(m[1]!, 10);
    const hasComma = m[2] !== undefined;
    // `{n}` ⇒ exactly n; `{n,}` ⇒ open-ended (Infinity); `{n,m}` ⇒ m; `{,m}` ⇒ m (min defaulted to 0).
    const max = !hasComma ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number.parseInt(m[3]!, 10);
    return { len: m[0].length, unbounded: hasComma, max };
  };
  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2; // escaped atom ⇒ literal
      continue;
    }
    if (ch === '[') {
      // Character class: everything up to the closing `]` is literal (quantifier chars included).
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++; // a leading `]` is a literal class member
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++; // consume `]`
      continue;
    }
    if (ch === '(') {
      risky.push(false);
      i++;
      continue;
    }
    if (ch === ')') {
      const body = risky.pop() ?? false;
      i++;
      let quantified = false;
      let quantUnbounded = false;
      let quantMax = 1; // reps the group's quantifier permits (1 = none, `?`, `{0,1}`, `{1}` — all safe)
      const q = src[i];
      if (q === '*' || q === '+') {
        quantified = true;
        quantUnbounded = true;
        quantMax = Number.POSITIVE_INFINITY;
        i++;
      } else if (q === '?') {
        quantified = true;
        i++;
      } else if (q === '{') {
        const b = readBrace(i);
        if (b) {
          quantified = true;
          quantUnbounded = b.unbounded;
          quantMax = b.max;
          i += b.len;
        }
      }
      if (quantified && (src[i] === '?' || src[i] === '+')) i++; // lazy / possessive suffix
      // A group with a risky body (its own quantifier or alternation) becomes catastrophic the moment
      // it can repeat TWO OR MORE times — whether the outer quantifier is unbounded (`(x+)+`) OR a
      // bounded exact/range count `>= 2` (`(x*){15}`, `(x?){250}`), which V8 unrolls into sequential
      // copies of the risky body. Reject both; only a bound of `<= 1` (`?`/`{0,1}`/`{1}`) is safe.
      if (body && quantMax >= 2) return false;
      if (quantified && quantUnbounded) unbounded++;
      const parent = risky.length - 1;
      risky[parent] = risky[parent] || body || quantified;
      continue;
    }
    if (ch === '|') {
      risky[risky.length - 1] = true;
      i++;
      continue;
    }
    if (ch === '*' || ch === '+') {
      // Unbounded quantifier on a single preceding atom.
      unbounded++;
      risky[risky.length - 1] = true;
      i++;
      if (src[i] === '?' || src[i] === '+') i++;
      continue;
    }
    if (ch === '?') {
      risky[risky.length - 1] = true;
      i++;
      continue;
    }
    if (ch === '{') {
      const b = readBrace(i);
      if (b) {
        if (b.unbounded) {
          unbounded++;
          risky[risky.length - 1] = true;
        }
        i += b.len;
        if (src[i] === '?') i++; // lazy suffix
        continue;
      }
      i++; // literal brace
      continue;
    }
    i++; // literal char
  }
  return unbounded <= MAX_UNBOUNDED_QUANTIFIERS;
}
