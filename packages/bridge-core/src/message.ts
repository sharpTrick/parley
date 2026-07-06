/**
 * Normalized Message + branded opaque identifier types (DESIGN §5/§6).
 *
 * Everything above the seam speaks ONLY this Message. Ordering and dedup use
 * `cursor` / `backendMsgId` — NEVER `timestamp` (clock skew and equal-timestamp ties
 * make timestamps unsafe; DESIGN §5/§6).
 */

import { parseMentions } from './mentions.js';

declare const BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** Logical topic — the single abstraction over Matrix room / XMPP MUC / NATS subject / local channel. */
export type Topic = Brand<string, 'Topic'>;
/** Logical participant handle. A handle does NOT imply a backend account (DESIGN §4). */
export type Handle = Brand<string, 'Handle'>;
/** Stable, backend-assigned unique id for a message. The dedup key. */
export type BackendMsgId = Brand<string, 'BackendMsgId'>;
/**
 * Opaque monotonic position of a message within its topic. The order key.
 * OPAQUE to core: core never parses, compares, or sorts by cursor value — it only
 * passes a stored cursor back as `since` and trusts the plugin's ordering (DESIGN §6).
 */
export type Cursor = Brand<string, 'Cursor'>;

/** Mint a {@link Topic} from a raw string. The only sanctioned way to brand. */
export const asTopic = (s: string): Topic => s as Topic;
/** Mint a {@link Handle} from a raw string. */
export const asHandle = (s: string): Handle => s as Handle;
/** Mint a {@link BackendMsgId} from a raw string. */
export const asBackendMsgId = (s: string): BackendMsgId => s as BackendMsgId;
/** Mint a {@link Cursor} from a raw string. */
export const asCursor = (s: string): Cursor => s as Cursor;

/**
 * The single type crossing the seam in both directions (DESIGN §5).
 */
export interface Message {
  /** Logical topic this message belongs to. */
  topic: Topic;
  /** Logical sender. */
  senderHandle: Handle;
  /** Message body (text; richer payloads are a future concern). */
  content: string;
  /** ISO 8601, informational ONLY — never used for ordering or dedup (DESIGN §5). */
  timestamp: string;
  /** Stable backend-assigned unique id — the dedup key. */
  backendMsgId: BackendMsgId;
  /** Monotonic position of THIS message within its topic — the order key (DESIGN §6). */
  cursor: Cursor;
  /** Handles referenced in this message. */
  mentions: Handle[];
}

/**
 * The already-extracted, normalized-but-unbranded fields a backend supplies; {@link buildMessage}
 * brands them and derives `mentions`. The two independent axes a backend varies (DESIGN §5/§6):
 * `timestamp` is pre-computed per-backend (this helper does NO date math), and `id`/`cursor` are
 * separate inputs because `backendMsgId` and `cursor` are not always the same value (e.g. Telegram).
 */
export interface BuildMessageInput {
  /** Already branded by the caller — plugins already hold a Topic (sqlite/postgres brand at the call). */
  topic: Topic;
  /** Raw sender string; branded to a {@link Handle} here. */
  sender: string;
  content: string;
  /** Already-computed ISO string (informational only, DESIGN §5) — NOT recomputed here. */
  timestamp: string;
  /** backendMsgId (dedup key). */
  id: string;
  /** Order key; defaults to `id` when the backend uses one value for both. */
  cursor?: string;
}

/**
 * The single sanctioned way to assemble a normalized {@link Message} from a backend record.
 * Centralizes branding (asHandle/asBackendMsgId/asCursor) and the {@link parseMentions} call so
 * mention + assembly semantics live in ONE place (CX-02). `topic` is passed pre-branded.
 */
export function buildMessage(input: BuildMessageInput): Message {
  return {
    topic: input.topic,
    senderHandle: asHandle(input.sender),
    content: input.content,
    timestamp: input.timestamp,
    backendMsgId: asBackendMsgId(input.id),
    cursor: asCursor(input.cursor ?? input.id),
    mentions: parseMentions(input.content),
  };
}
