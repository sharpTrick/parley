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
 * string depending on the endpoint, and `-0012345`, `-12345` and `"-12345"` all name one chat, so
 * keying on the spelling would file a record under something no other call looks up — on this
 * backend a permanent black hole, since no history endpoint can refill the topic. A spelling that
 * is not an integer at all names no chat Telegram could serve, so it is a labelled rejection here.
 *
 * The spelling is the UPSTREAM's and the rejection becomes model context, so quote it through
 * `sanitizeBody` like every other quoted body — unbounded and unflattened it is an attacker-chosen
 * string with forged line structure in it.
 */
export function canonicalChatKey(label: string, id: number | string): string {
  const raw = typeof id === 'number' ? String(id) : id.trim();
  if (!NUMERIC_CHAT_ID.test(raw)) {
    throw new Error(`${label}: chat id '${sanitizeBody(raw)}' is not a Telegram numeric chat id`);
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

/** The optional fields {@link contentOf} takes the record's body from, in its own precedence order. */
const BODY_FIELDS = ['text', 'caption'] as const;

/**
 * Telegram payload kinds that carry no `text`/`caption`. An agent handed an empty turn cannot tell
 * "someone sent a photo" from "someone sent nothing", so each becomes an explicit placeholder.
 */
const MEDIA_KINDS = [
  'photo', 'video', 'animation', 'audio', 'voice', 'video_note', 'document',
  'sticker', 'location', 'venue', 'contact', 'poll', 'dice', 'game',
] as const;

/**
 * Every field {@link contentOf} and {@link senderOf} read for a VALUE, checked for its DOMAIN as
 * well as its type where the object arrives rather than where each one is dereferenced. Keep every
 * one of those checks here, so that a non-conforming upstream cannot drive a record the
 * store PERSISTS and reloads: a field that survives to `store.append` is written to the JSONL file,
 * and a `content` that is not a string then throws inside `buildMessage` on every later
 * `fetchRecent` for that chat, across restarts, with no Bot API call that could ever refill the
 * topic.
 */
export function requireMessage(label: string, value: unknown): TgMessage {
  const msg = value as TgMessage | null;
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new Error(`${label}: not a message object`);
  }
  if (typeof msg.message_id !== 'number' || !Number.isFinite(msg.message_id)) {
    throw new Error(`${label}: message carries no numeric message_id`);
  }
  const id = (msg.chat as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error(`${label}: message carries no chat id`);
  }
  if (typeof msg.date !== 'number' || !Number.isFinite(msg.date)) {
    throw new Error(`${label}: message carries no numeric date`);
  }
  if (Number.isNaN(new Date(msg.date * 1000).getTime())) {
    throw new Error(`${label}: message carries an out-of-range date (${String(msg.date)})`);
  }
  const fields = msg as unknown as Record<string, unknown>;
  for (const field of BODY_FIELDS) {
    if (fields[field] !== undefined && typeof fields[field] !== 'string') {
      throw new Error(`${label}: message carries a non-string ${field}`);
    }
  }
  const from = fields.from;
  if (from !== undefined) {
    if (from === null || typeof from !== 'object' || Array.isArray(from)) {
      throw new Error(`${label}: message carries a from that is not a user object`);
    }
    const user = from as Record<string, unknown>;
    if (typeof user.id !== 'number' || !Number.isFinite(user.id)) {
      throw new Error(`${label}: message carries no numeric from.id`);
    }
    if (user.username !== undefined && typeof user.username !== 'string') {
      throw new Error(`${label}: message carries a non-string from.username`);
    }
  }
  return msg;
}

/**
 * The message body to record: `text`, else a media `caption`, else a `[kind]` placeholder.
 * `undefined` for a service message (joins/leaves) — not ingested at all, never a blank line.
 */
export function contentOf(msg: TgMessage): string | undefined {
  const fields = msg as unknown as Record<string, unknown>;
  for (const field of BODY_FIELDS) {
    const body = fields[field];
    if (typeof body === 'string') return body;
  }
  const kind = MEDIA_KINDS.find((k) => fields[k] !== undefined);
  return kind === undefined ? undefined : `[${kind}]`;
}

/** Sender handle: the username, else the numeric id, else the chat id (a channel post has no `from`). */
export function senderOf(msg: TgMessage): string {
  if (msg.from !== undefined) return msg.from.username ?? String(msg.from.id);
  return String(msg.chat.id);
}

/**
 * Telegram 429s carry `parameters.retry_after` (SECONDS) in the JSON body as well as the standard
 * `Retry-After` header. Prefer the header, then the body; `undefined` when neither carries a
 * usable hint, which lets net-util supply the default backoff.
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
