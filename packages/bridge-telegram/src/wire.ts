import type { BackendMsgId } from '@sharptrick/parley-core';
import { retryAfterFromHeader, sanitizeBody } from '@sharptrick/parley-net-util';

/** The subset of a Telegram `Message` object this plugin reads. */
export interface TgMessage {
  message_id: number;
  /** Unix seconds. Informational only — never used for ordering or dedup (DESIGN §5). */
  date: number;
  chat: { id: number | string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
  /** Media messages carry their text here instead of in `text`. */
  caption?: string;
}

/** The subset of a Telegram `Update` object this plugin reads. */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

/** A chat id as Telegram spells it on the wire: an integer, with or without a leading `-`. */
export const NUMERIC_CHAT_ID = /^-?\d+$/;

/**
 * The Bot API's own success signal: `{ok, result}`, where a REFUSAL is a 2xx carrying `ok:false`
 * and a `description`. Keep this ahead of every caller, so that a rejecting middlebox or a
 * non-conforming local Bot API server fails the call it broke — naming the endpoint and the
 * upstream's own words — instead of passing `connect`'s preflight and resurfacing later as a
 * contextless TypeError on a field that was never there.
 *
 * The body is untrusted and a thrown message becomes model context, so everything quoted out of it
 * goes through net-util's `sanitizeBody`.
 */
export function unwrapEnvelope(label: string, text: string): unknown {
  const quote = (raw: string): string => (raw.trim() === '' ? '<empty body>' : sanitizeBody(raw));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} → body: not JSON: ${quote(text)}`);
  }
  const env = body as { ok?: unknown; result?: unknown; description?: unknown } | null;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`${label} → body: not a Bot API envelope: ${quote(text)}`);
  }
  if (env.ok !== true) {
    throw new Error(
      `${label} → ok:false: ${typeof env.description === 'string' ? quote(env.description) : quote(text)}`,
    );
  }
  if (env.result === undefined || env.result === null) {
    throw new Error(`${label} → ok:true with no result: ${quote(text)}`);
  }
  return env.result;
}

/**
 * A chat id an UPSTREAM stamped, in the one canonical form every index in this plugin is keyed by —
 * the same normalization a configured topic is put through. `chat.id` arrives as a JSON number or a
 * string depending on the endpoint and the server, and `-0012345`, `-12345` and the string
 * `"-12345"` all name one chat; keying on the spelling rather than on the value files a record under
 * something no other call will ever look up, which on this backend is a permanent black hole (no
 * history endpoint can refill the topic).
 *
 * A spelling that is not an integer at all names no chat Telegram could serve, so it is a labelled
 * rejection here rather than a bucket nothing reads.
 */
export function canonicalChatKey(label: string, id: number | string): string {
  const raw = typeof id === 'number' ? String(id) : id.trim();
  if (!NUMERIC_CHAT_ID.test(raw)) {
    throw new Error(`${label}: chat id '${raw}' is not a Telegram numeric chat id`);
  }
  return BigInt(raw).toString();
}

/**
 * `<chat_id>:<message_id>` → the numeric message_id, but ONLY when the composite names
 * `chatId`. Telegram's `message_id` is unique per chat, so a composite from another chat
 * denotes nothing here; both halves must check out or the reply is not threaded.
 */
export function parseCompositeMid(
  id: BackendMsgId | undefined,
  chatId: string,
): number | undefined {
  if (id === undefined) return undefined;
  const sep = (id as string).lastIndexOf(':');
  if (sep < 0) return undefined;
  if ((id as string).slice(0, sep) !== chatId) return undefined;
  const mid = Number((id as string).slice(sep + 1));
  return Number.isInteger(mid) && mid > 0 ? mid : undefined;
}

/**
 * Telegram 429s carry `parameters.retry_after` (SECONDS) in the JSON body, and also send the
 * standard `Retry-After` header. Prefer the header, then the body; `undefined` when neither
 * carries a usable hint, which lets net-util supply the default backoff.
 *
 * Return it UNCLAMPED, so that a stated flood wait is honoured in full: Telegram's flood waits are
 * routinely 30s+ and retrying sooner than the vendor asked is what escalates a rate limit into a
 * token ban. A wait that cannot fit the call's deadline ends the call there — net-util's job, not
 * this parser's.
 */
export async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { parameters?: { retry_after?: number } };
    const seconds = json.parameters?.retry_after;
    if (typeof seconds === 'number' && seconds > 0) return seconds * 1000;
  } catch {
    /* no usable body hint */
  }
  return undefined;
}
