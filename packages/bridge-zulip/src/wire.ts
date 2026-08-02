import { buildMessage, type Message, type Topic } from '@sharptrick/parley-core';
import { retryAfterFromHeader } from '@sharptrick/parley-net-util';

/** The subset of a `GET /api/v1/users` member we read; `full_name` is set by that member. */
export interface RealmMember {
  user_id: number;
  email: string;
  full_name: string;
  is_active?: boolean;
}

/** The subset of a Zulip message object we read. */
export interface ZulipMessage {
  id: number;
  content?: string;
  sender_email?: string;
  /** Unix seconds. */
  timestamp?: number;
}

/** One entry from `GET /api/v1/events`. Non-`message` types (heartbeat, …) only advance the ack. */
export interface ZulipEvent {
  id: number;
  type: string;
  message?: ZulipMessage;
}

export interface EventsResponse {
  result?: string;
  code?: string;
  events?: ZulipEvent[];
}

/** `zerver/views/message_fetch.py`: `num_before + num_after > 5000` is a 400. */
export const MAX_MESSAGES_PER_FETCH = 5000;

/** `zerver/lib/message.py` `MAX_TOPIC_NAME_LENGTH`: longer subjects are truncated on send. */
const MAX_TOPIC_NAME_LENGTH = 60;

/**
 * The edge whitespace a send loses: `zerver/lib/typed_endpoint.py`'s `OptionalTopic` is a pydantic
 * `StringConstraints(strip_whitespace=True)` field, whose strip is the Unicode White_Space set. Keep
 * it off `String#trim`, so that U+FEFF — which JS trims and the server keeps — is not refused as a
 * rewrite the server never makes.
 */
const SERVER_STRIPPED_TOPIC_EDGE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/**
 * The trailing whitespace a send loses off a BODY, which is a DIFFERENT set: `normalize_body` calls
 * Python's `str.rstrip()`, whose set is `str.isspace()` — White_Space plus U+001C–U+001F. Keep it
 * distinct from {@link SERVER_STRIPPED_TOPIC_EDGE} and off JavaScript's `\s`, so that neither the
 * four separators, nor U+0085 (which this strip takes and `\s` does not), nor U+FEFF (which `\s`
 * takes and no server strip does) is graded against the wrong rewrite.
 */
const SERVER_STRIPPED_BODY_TAIL = /[\p{White_Space}\u001c-\u001f]+$/u;

/** `settings.MAX_MESSAGE_LENGTH`: `normalize_body` truncates a longer body on send. */
const MAX_MESSAGE_LENGTH = 10_000;

/** Largest offset `Date` can represent; past it `toISOString()` throws a RangeError. */
const MAX_TIMESTAMP_MS = 8.64e15;

export function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Normalize one server-controlled record into a {@link Message}, or `undefined` when its `id` — the
 * dedup key AND the cursor — is not a usable Zulip message id. Every other field is coerced rather
 * than trusted: a non-string `content` reaches core's mention parser and a non-numeric `timestamp`
 * reaches `Date#toISOString`, either of which throws, and a throw here escapes `fetchRecent` and
 * bricks catch-up on every subsequent start.
 */
export function zulipToMessage(topic: Topic, m: ZulipMessage | undefined | null): Message | undefined {
  if (m === undefined || m === null) return undefined;
  const { id } = m;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return buildMessage({
    topic,
    sender: typeof m.sender_email === 'string' ? m.sender_email : '',
    content: typeof m.content === 'string' ? m.content : '',
    timestamp: isoTimestamp(m.timestamp),
    id: String(id),
  });
}

/** Zulip timestamps are Unix SECONDS; an out-of-range or non-numeric one falls back to the epoch. */
function isoTimestamp(seconds: unknown): string {
  const ms = typeof seconds === 'number' ? seconds * 1000 : Number.NaN;
  return new Date(Number.isFinite(ms) && Math.abs(ms) <= MAX_TIMESTAMP_MS ? ms : 0).toISOString();
}

/**
 * The anchor that walks past the page just read, taken from the RAW edge record so that a page whose
 * every record was unusable still advances. `undefined` when the edge carries no id that moves the
 * anchor in the direction of travel — keep that guard, so that a server answering with an unmoving
 * id cannot spin the read on one page forever.
 */
export function pageAnchor(
  edge: ZulipMessage | undefined,
  from: string,
  backwards: boolean,
): string | undefined {
  const id = edge?.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return undefined;
  const current = Number(from);
  if (Number.isFinite(current) && (backwards ? id >= current : id <= current)) return undefined;
  return String(id);
}

/**
 * Zulip 429s carry `Retry-After` (header) and `retry-after` (JSON body), both in SECONDS. Returns
 * undefined when neither is usable, so the shared default and the shared ceiling stay in
 * `clampBackoff` rather than being re-implemented — and re-tuned — per backend.
 */
export async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { 'retry-after'?: number };
    const field = json['retry-after'];
    if (typeof field === 'number' && field > 0) return field * 1000;
  } catch {
    /* no usable body hint */
  }
  return undefined;
}

/**
 * The body as Zulip would store it, or a throw. `zerver/lib/message.py::normalize_body` right-strips
 * the body, drops its leading newlines, refuses an empty or NUL-carrying one, and TRUNCATES past
 * `MAX_MESSAGE_LENGTH` — every one of those a silent rewrite of a payload `post` already reported as
 * durable, so each is refused here naming what the server would have done, exactly as an unusable
 * topic is. Measured in code points, which is what Python's `len` counts.
 */
export function requireSendableBody(content: string): string {
  const rewritten = content.replace(SERVER_STRIPPED_BODY_TAIL, '').replace(/^\n+/, '');
  if (rewritten === '') {
    throw new Error(
      'Zulip rejects an empty message body (Zulip strips trailing whitespace and leading newlines ' +
        `before storing, and ${JSON.stringify(content)} normalizes to nothing).`,
    );
  }
  if (rewritten.includes('\u0000')) {
    throw new Error('Zulip rejects a message body containing a NUL (U+0000). Remove it.');
  }
  if (rewritten !== content) {
    const edge =
      content.replace(SERVER_STRIPPED_BODY_TAIL, '') === content
        ? 'leading newlines'
        : 'trailing whitespace';
    throw new Error(
      `Zulip rewrites a message body on send: it strips ${edge}, so this message would be stored ` +
        'altered and read back as something else. Trim it before posting.',
    );
  }
  const length = [...content].length;
  if (length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Zulip message too long: ${length} characters, max ${MAX_MESSAGE_LENGTH} (Zulip truncates a ` +
        'longer body on send, so the message would be stored altered). Shorten it or split it.',
    );
  }
  return content;
}

/**
 * The Zulip topic a Parley topic addresses, used by post, the read narrow and register alike.
 * Case-folded because Zulip compares topics case-insensitively; edge-padded and over-long names are
 * rejected rather than sent, because Zulip would silently strip the first and truncate the second to
 * 60 characters — each making the topic write-only, since posts land under a name no read narrow and
 * no event-queue narrow ever matches.
 *
 * The rewrites are checked in the order the server applies them: the topic is stripped where the
 * request is parsed, and only what survives that reaches the length the send truncates.
 */
export function requireWireTopic(topic: Topic): string {
  const wire = topic.toLowerCase();
  const stripped = wire.replace(SERVER_STRIPPED_TOPIC_EDGE, '');
  if (stripped !== wire) {
    throw new Error(
      `Zulip strips whitespace off a topic on send, so topic ${JSON.stringify(topic)} would be ` +
        `stored as ${JSON.stringify(stripped)} while every read narrow and every event queue ` +
        'matches the name as sent — nothing posted there could ever be read back. Trim the ' +
        'Parley topic name.',
    );
  }
  if ([...wire].length > MAX_TOPIC_NAME_LENGTH) {
    throw new Error(
      `Zulip topic too long: ${[...wire].length} characters, max ${MAX_TOPIC_NAME_LENGTH} ` +
        `(Zulip truncates longer subjects on send, making topic ${JSON.stringify(topic)} ` +
        'unreadable). Shorten the Parley topic name.',
    );
  }
  return wire;
}
