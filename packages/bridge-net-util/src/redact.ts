/** Longest untrusted response body embedded in a thrown message. */
export const MAX_ERROR_BODY = 2_048;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Longest path segment treated as ordinary routing vocabulary on length alone. A segment past it is
 * opaque enough to be a token — Discord's `/api/webhooks/<id>/<token>` carries one with no
 * punctuation at all — while a shorter one is a word like `api` or `v1`.
 */
const ROUTE_WORD_CHARS = 8;

/**
 * How a method name is spelled: `getUpdates`, `conversations`, `chat.postMessage`. Keep this
 * exemption, so that redaction cannot strike a segment out of the PROSE of an error body:
 * Telegram's own 409 reads "can't use getUpdates method while webhook is active", and an operator
 * shown "can't use <redacted> method" has been told less than nothing.
 */
const ROUTE_WORD = /^[A-Za-z.]+$/;

/**
 * Longest segment the exemption above covers. Keep a ceiling on it, so that a credential spelled
 * with no digit and no punctuation — a 32-character alphabetic webhook token, a dotted JWT — cannot
 * buy its way out of redaction by reading as a very long method name.
 */
const METHOD_NAME_CHARS = 24;

const routingVocabulary = (part: string): boolean =>
  part.length <= METHOD_NAME_CHARS && ROUTE_WORD.test(part);

const carriesSecret = (part: string): boolean =>
  part.includes(':') || (part.length > ROUTE_WORD_CHARS && !routingVocabulary(part));

/**
 * Both sides of the percent-encoding boundary. `URL` hands userinfo back ENCODED (a password's own
 * `:` comes out as `%3A`) and query values back DECODED, so a component's getter is only one of the
 * two spellings a body or a transport error can echo. Keep both, so that a token cannot survive
 * redaction by being written the way the other half of the parser spells it.
 */
function spellings(part: string): string[] {
  const out = new Set([part, encodeURIComponent(part)]);
  // Keep the catch: a stray `%` in a URL makes `decodeURIComponent` throw, and this runs on the
  // path that is BUILDING an error message.
  try {
    out.add(decodeURIComponent(part));
  } catch {
    out.add(part);
  }
  return [...out];
}

/**
 * The parts of the request URL that are themselves a secret. Telegram's path is
 * `/bot<id>:<token>/<method>` and Discord's is `/api/webhooks/<id>/<token>`, and a transport or a
 * hostile body can echo the path alone — which no scheme-anchored sweep and no byte-identical
 * comparison against the full URL would catch.
 *
 * Every component a credential can hide in is enumerated, not just the path: userinfo and a query
 * value are the two other places an API key is conventionally carried, and a body echoing one of
 * them alone escapes both the exact split and the scheme sweep.
 *
 * A query value is filtered by the same {@link carriesSecret} predicate as a path segment, because
 * it carries the same two kinds of thing: `access_token=<opaque>` alongside Matrix's
 * `timeout=30000`, Zulip's `dont_block=false` and `anchor=newest`. Keep the filter, so that a
 * routine parameter is not struck out of the untrusted body everywhere it appears — including
 * inside longer words, which is what turns "you have 100 messages and no permission" into
 * "you have <redacted>0 messages and <redacted> permission". Userinfo takes no such exemption: it
 * is credential-by-construction, so it is kept at every length above zero — an empty one would
 * split the body between every character.
 *
 * Query values are taken from the RAW query text as well as from `searchParams`, so that a
 * credential is removed in the spelling that is actually ON THE WIRE. `URLSearchParams` decodes
 * before it hands a value over — `+` comes back as a space, `%2F` as `/` — so a standard-base64
 * API key read off the parser is a string the transport and the body never contained.
 */
function credentialParts(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const { pathname, username, password, search, searchParams } = parsed;
  const rawQueryValues = search
    .slice(1)
    .split('&')
    .filter((pair) => pair.includes('='))
    .map((pair) => pair.slice(pair.indexOf('=') + 1));
  const shaped = [
    ...[pathname, ...pathname.split('/')].filter(carriesSecret),
    ...[...searchParams.values(), ...rawQueryValues].filter(carriesSecret),
  ]
    .flatMap(spellings)
    .filter((part) => part.length > 1);
  const userinfo = [username, password].flatMap(spellings).filter((part) => part.length > 0);
  return [...new Set([...shaped, ...userinfo])];
}

/**
 * Keep this on every path that embeds a transport error or a response body, so that a
 * credential-bearing URL (Telegram carries the bot token in the path) never reaches model context
 * or the operator's logs. The caller's `label` already identifies the call site without it.
 *
 * A bare `host/path` with no scheme is NOT recognized as a URL; only the credential-bearing parts
 * of it are removed. Keep any new credential shape out of the host and query, so that this holds.
 */
export function redactUrls(text: string, url: string): string {
  let out = text.split(url).join('<url>');
  for (const secret of credentialParts(url)) out = out.split(secret).join('<redacted>');
  return out.replace(URL_LIKE, '<url>');
}

/** Node's `fetch` puts the real reason in `cause`, not in `message`. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    const text = cur instanceof Error ? cur.message : String(cur);
    if (text.length > 0 && !parts.includes(text)) parts.push(text);
    cur = cur instanceof Error ? (cur.cause as unknown) : undefined;
  }
  return parts.length > 0 ? parts.join(': ') : 'unknown transport failure';
}

/**
 * Every control (`Cc`: C0, C1, DEL) and every format character (`Cf`: bidi overrides, isolates,
 * BOM), plus the two line/paragraph separators, which are `Zl`/`Zp` and so outside both classes.
 * Keep this as the CLASSES rather than a hand-listed set, so that a family nobody thought of — NEL,
 * CSI — cannot forge line structure.
 */
const NEUTRALIZED = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A surrogate with no partner: `JSON.stringify` escapes it, but nothing downstream can decode it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Bound and flatten an untrusted response body before it goes in an Error.
 *
 * A thrown message becomes an `isError` tool result, i.e. model context. Keep the truncation and
 * the character strip, so that a hostile backend cannot push forged line structure or bidi
 * overrides down a path the topic allowlist never sees. This bounds the MESSAGE; what bounds the
 * MEMORY is the read itself (`maxBodyBytes`), not this. It bounds and flattens ONLY — the body's
 * words still reach the model, so do not read this as neutralizing what they say.
 */
export function sanitizeBody(text: string): string {
  const flat = text.replace(NEUTRALIZED, ' ').replace(LONE_SURROGATE, '\uFFFD');
  if (flat.length <= MAX_ERROR_BODY) return flat;
  const cut = flat.slice(0, MAX_ERROR_BODY);
  // Cutting between a surrogate pair emits half an astral character into an MCP JSON result.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole}… [truncated]`;
}

/** Never let reading the failing body replace `<label> → <status>: …` with a raw transport error. */
export async function errorBody(res: Response, url: string): Promise<string> {
  try {
    return sanitizeBody(redactUrls(await res.text(), url));
  } catch (err) {
    return `<unreadable body: ${sanitizeBody(redactUrls(errorText(err), url))}>`;
  }
}
