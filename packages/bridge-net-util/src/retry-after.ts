/**
 * RFC 9110 `delay-seconds` is `1*DIGIT`, and a fraction is the de-facto extension Discord and Slack
 * send. Keep the spelling PINNED rather than deferring to `Number`, so that `0x1F4` cannot be read
 * as 500 seconds and `1e3` as 1000 — a misread that inflates a routine hint past the deadline and
 * ends the call.
 */
const DELAY_SECONDS = /^\d+(?:\.\d+)?$/;

/**
 * Two of the three `HTTP-date` spellings RFC 9110 §5.6.7 defines — IMF-fixdate and obsolete RFC 850,
 * the two that carry an explicit `GMT`. Keep these PINNED for the same reason `delay-seconds` is, so
 * that `Date.parse`'s laxity cannot invent a date out of something that is not one — `Headers.get`
 * joins a gateway's `Retry-After` and an origin's into `"3600, 5"`, which V8 reads as May of the year
 * 3600 and which then dominates the max below by twelve orders of magnitude, ending the call with a
 * wait no deadline can cover.
 */
const GMT_SPELLINGS = [
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The third spelling. asctime states no zone, RFC 9110 §5.6.7 says every HTTP-date is GMT, and
 * `Date.parse` reads a zone-less date on the HOST's clock — so keep the instant built here from the
 * captured fields with `Date.UTC`, so that a stated wait is not shifted by the deployment's UTC
 * offset. East of Greenwich the shift turns a real wait negative, i.e. into no hint at all and a
 * retry at the fixed default; west of it the same wait inflates past the call's deadline.
 *
 * Each field is range-checked because the pinned shape admits `Nov 32` and `08:69:37`, which
 * `Date.UTC` would roll forward into a plausible instant hours or months away rather than reject.
 */
const ASCTIME = /^[A-Za-z]{3} ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function asctimeMs(text: string): number | undefined {
  const m = ASCTIME.exec(text);
  if (m === null) return undefined;
  const month = MONTHS.indexOf(m[1] as string);
  const day = Number(m[2]);
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  const ss = Number(m[5]);
  if (month < 0 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 60) return undefined;
  return Date.UTC(Number(m[6]), month, day, hh, mm, ss);
}

function httpDateMs(text: string): number | undefined {
  if (!GMT_SPELLINGS.some((spelling) => spelling.test(text))) return asctimeMs(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

function oneRetryAfterValue(raw: string, from: number): number | undefined {
  const text = raw.trim();
  if (DELAY_SECONDS.test(text)) return Number(text) * 1000;
  const at = httpDateMs(text);
  return at === undefined ? undefined : at - from;
}

/**
 * When the server says "now". An HTTP-date `Retry-After` is a point on the SERVER's clock (RFC 9110
 * §10.2.3), so measuring it against ours turns a client clock a minute ahead into a negative wait —
 * i.e. no hint at all — and a client behind into a wait past the deadline. Keep the `Date` header as
 * the origin whenever the response offers one, so that the hint is skew-invariant.
 */
function serverNow(res: Response): number {
  return httpDateMs((res.headers.get('date') ?? '').trim()) ?? Date.now();
}

/**
 * Split a joined header back into its field-values. `Headers.get` joins a repeated header with
 * `", "`, and an HTTP-date carries a comma of its own between the day-name and the date — so a bare
 * split cuts a date in half. A fragment is re-attached to the one before it only when the JOIN is
 * itself a well-spelled HTTP-date, so that reassembly cannot swallow a usable field-value sitting
 * behind a three-letter unparseable one (`"abc, 10"` still states ten seconds).
 */
function fieldValues(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const previous = out.at(-1);
    const joined = previous === undefined ? undefined : `${previous},${part}`;
    if (joined !== undefined && httpDateMs(joined.trim()) !== undefined) out[out.length - 1] = joined;
    else out.push(part);
  }
  return out;
}

/**
 * Milliseconds from a `Retry-After` header, or undefined if unusable. RFC 9110 defines BOTH forms:
 * `delay-seconds` and an HTTP-date. Reading only the first makes a date-form header look absent and
 * falls back to the caller's own default — an order of magnitude sooner than the server asked.
 *
 * A gateway and an origin both setting the header make `Headers.get` return `"120, 120"`. Take the
 * LARGEST duration any field-value states, so that a multi-valued header cannot degrade to no hint
 * at all.
 */
export function retryAfterFromHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const from = serverNow(res);
  let longest: number | undefined;
  for (const part of fieldValues(raw)) {
    const ms = oneRetryAfterValue(part, from);
    if (ms !== undefined && ms > 0 && (longest === undefined || ms > longest)) longest = ms;
  }
  return longest;
}

/** A hint only counts as server-stated when it is a real, positive duration. */
export const usableHint = (ms: number | undefined): number | undefined =>
  ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined;

/**
 * A 429's BODY hint. Four vendors state the same thing in four places (`retry_after`,
 * `retry_after_ms`, `retry-after`, `parameters.retry_after`) and in two units, and ONLY that
 * differs — which is all this builds. The standard header is read by `fetchWithRetry`, which takes
 * the longer of the two, so reading it here as well was a second computation of a figure the loop
 * recomputes and no caller can observe.
 *
 * A body a parser cannot read means "no usable hint" rather than an error out of the retry loop,
 * and the figure reported is the one the vendor stated: nothing here shortens it, because retrying
 * sooner than asked is what escalates a rate limit into a ban. A body long enough to end the call
 * is refused by `fetchWithRetry`'s own ceiling, not shortened here.
 *
 * `hintOf` reads the parsed body; anything it returns that is not a positive number is no hint.
 * `unitMs` scales it — 1000 for a vendor stating seconds, the default 1 for milliseconds.
 */
export function bodyRetryAfter<T>(
  hintOf: (body: T) => unknown,
  unitMs = 1,
): (res: Response) => Promise<number | undefined> {
  return async (res: Response): Promise<number | undefined> => {
    try {
      const stated = hintOf((await res.clone().json()) as T);
      if (typeof stated === 'number' && stated > 0) return stated * unitMs;
    } catch {
      /* no usable body hint */
    }
    return undefined;
  };
}
