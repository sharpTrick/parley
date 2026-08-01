import { buildMessage, type Message, type Topic } from '@sharptrick/parley-core';
import { shapeOf } from './diagnostics.js';

/** A minimal Discord message object (the subset we read; REST and gateway share this shape). */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  content?: string;
  timestamp?: string;
  author?: { id: string; username: string };
  /** Users referenced by `<@id>` markup in `content` — Discord resolves them for us. */
  mentions?: Array<{ id: string; username: string }>;
}

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Discord's hard caps: characters per message, and messages per `GET .../messages` page. */
export const CONTENT_LIMIT = 2000;
export const PAGE_LIMIT = 100;

/** Discord REST error codes: a channel that does not exist, and one this bot cannot access. */
export const UNKNOWN_CHANNEL = 10003;
export const MISSING_ACCESS = 50001;

/**
 * Types that DO carry `MESSAGE_CREATE` under this intent set: guild text (0), the text chat of
 * voice (2) and stage (13), announcements (5), and the three thread classes (10/11/12). Keep it an
 * ALLOWLIST, so that a type Discord adds after this was written is named on stderr rather than
 * becoming a permanently idle topic.
 */
const PUSHABLE_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);

/** How to describe the channel types an operator most plausibly mis-copies from Discord's UI. */
const CHANNEL_TYPE_NAMES = new Map([
  [1, 'a DM'],
  [3, 'a group DM'],
  [4, 'a category'],
  [14, 'a directory'],
  [15, 'a forum container (its threads carry the messages)'],
  [16, 'a media container (its threads carry the messages)'],
]);

export function unpushableChannelReason(type: unknown): string | undefined {
  if (typeof type !== 'number' || PUSHABLE_CHANNEL_TYPES.has(type)) return undefined;
  const named = CHANNEL_TYPE_NAMES.get(type) ?? 'a channel type that carries no guild messages';
  return (
    `is ${named} (type ${type}); the intent set is GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT ` +
    'with no DIRECT_MESSAGES, so no MESSAGE_CREATE can name it'
  );
}

/**
 * Keep the CODE POINT spread, so that astral text (emoji, CJK extensions) is not refused at half
 * Discord's real limit under a length the provider never measured.
 */
export const countCharacters = (content: string): number => [...content].length;

/** Refuse a non-positive interval as well as a missing one, so that a `0` cannot beat per-ms. */
export function heartbeatIntervalOf(d: unknown): number | undefined {
  if (typeof d !== 'object' || d === null) return undefined;
  const { heartbeat_interval: ms } = d as { heartbeat_interval?: unknown };
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * True when a record carries an id this plugin can put across the seam. `id` is BOTH the dedup key
 * and the cursor, so refuse a missing one AND an empty string, so that such messages cannot collapse
 * onto one shared dedup key and pin the topic's persisted position.
 */
export function hasUsableId(record: unknown): record is { id: string } {
  if (typeof record !== 'object' || record === null) return false;
  const { id } = record as { id?: unknown };
  return typeof id === 'string' && id !== '';
}

/**
 * The bot's own account out of a `GET /users/@me` 200. Keep a body the cast is not true of a THROW
 * rather than a partial account, so that it takes the caller's memo-clearing path: a value returned
 * from here is remembered for the life of the process and answered to every later resolveIdentity.
 */
export function botAccount(body: unknown): { id: string; username: string } {
  const { username } = (body ?? {}) as { username?: unknown };
  if (hasUsableId(body) && typeof username === 'string' && username !== '') {
    return { id: body.id, username };
  }
  throw new Error(
    `Discord GET /users/@me answered ${shapeOf(body)} carrying no usable account id and username; ` +
      'this bot cannot tell its own handle from any other',
  );
}

/**
 * The message records of a `GET .../messages` 200. REFUSE the whole page rather than filtering it,
 * so that a page whose newest record is usable and whose older one is not cannot advance the cursor
 * past the record it dropped — core resumes strictly after it and can never come back.
 */
export function pageRecords(path: string, body: unknown): DiscordMessage[] {
  if (!Array.isArray(body)) {
    throw new Error(`Discord GET ${path} answered ${shapeOf(body)}, not a page of messages`);
  }
  const unusable = body.filter((record) => !hasUsableId(record)).length;
  if (unusable > 0) {
    throw new Error(
      `Discord GET ${path} answered ${body.length} record(s), ${unusable} of them carrying no ` +
        'usable message id (the seam needs it as both the dedup key and the cursor)',
    );
  }
  return body as DiscordMessage[];
}

export function dispatchedMessage(d: unknown): DiscordMessage | undefined {
  if (!hasUsableId(d)) return undefined;
  const { channel_id: channel } = d as { channel_id?: unknown };
  return typeof channel === 'string' && channel !== ''
    ? (d as unknown as DiscordMessage)
    : undefined;
}

export function errorCode(raw: string): number | undefined {
  try {
    const { code } = JSON.parse(raw) as { code?: number };
    return typeof code === 'number' ? code : undefined;
  } catch {
    return undefined;
  }
}

export function toMessage(topic: Topic, m: DiscordMessage): Message {
  return buildMessage({
    topic,
    sender: m.author?.username ?? '',
    content: renderMentions(m),
    timestamp: m.timestamp ?? '',
    id: m.id,
  });
}

/** `<@id>` / `<@!id>` — how Discord serializes a user mention; NEVER the `@handle` text. */
const USER_MENTION_RE = /<@!?(\d+)>/g;

/**
 * Rewrite Discord's mention markup to the `@username` form core's `parseMentions` reads, from the
 * payload's own resolved `mentions[]`. Without it every mention crosses as a raw snowflake, so
 * `Message.mentions` never holds a Parley handle and core's mention filter drops every message.
 */
function renderMentions(m: DiscordMessage): string {
  const content = m.content ?? '';
  if (content === '') return content;
  const byId = new Map((m.mentions ?? []).map((u) => [u.id, u.username]));
  return content.replace(USER_MENTION_RE, (_raw, id: string) => `@${byId.get(id) ?? 'unknown-user'}`);
}
