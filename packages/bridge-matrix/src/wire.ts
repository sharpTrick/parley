import { buildMessage, type Message, type Topic } from '@sharptrick/parley-core';
import { retryAfterFromHeader } from '@sharptrick/parley-net-util';

/** Custom event-content key tagging the logical Parley topic (shared-room isolation + provenance). */
export const TOPIC_KEY = 'app.parley.topic';

/**
 * Every field is member-controlled JSON on which the homeserver enforces no schema. Keep these
 * `unknown`, so that no value reaches `buildMessage` without passing a guard — a throw there
 * rejects `fetchRecent`, which bricks startup catch-up.
 */
export interface MatrixEvent {
  type?: unknown;
  event_id?: unknown;
  sender?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
}

/** An `m.room.message` carrying the one field the seam cannot synthesize: a usable id. */
export type MessageEvent = MatrixEvent & { event_id: string };

export const isMessageEvent = (e: MatrixEvent): e is MessageEvent =>
  e.type === 'm.room.message' && typeof e.event_id === 'string';

export const contentOf = (e: MatrixEvent): Record<string, unknown> =>
  typeof e.content === 'object' && e.content !== null ? (e.content as Record<string, unknown>) : {};

export interface SyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      { timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string } }
    >;
  };
}

/** The `?filter=` value for a `/sync` with a given timeline limit (0 = no history at all). */
export const syncFilterParam = (roomId: string, timelineLimit: number): string =>
  encodeURIComponent(
    JSON.stringify({
      room: {
        rooms: [roomId],
        timeline: { limit: timelineLimit },
        ephemeral: { limit: 0 },
        account_data: { limit: 0 },
        state: { limit: 0, lazy_load_members: true },
      },
      presence: { limit: 0 },
      account_data: { limit: 0 },
    }),
  );

/**
 * The newest event a positioning `/sync` snapshot carries, of ANY type — a state event is a valid
 * boundary since `backfill` matches by id, not by topic/type.
 */
export const timelineTipOf = (sync: SyncResponse, roomId: string): string | undefined => {
  const tip = sync.rooms?.join?.[roomId]?.timeline?.events?.at(-1)?.event_id;
  return typeof tip === 'string' ? tip : undefined;
};

/**
 * The resume token a `/sync` response advances to. Keep a non-string a THROW rather than adopting or
 * ignoring it, so that a loop cannot resume from a token the homeserver will reject — or, on a
 * server whose tokens are ordinal, silently seek past unread events — and instead reports and backs
 * off from the last token that worked.
 */
export const nextBatchOf = (raw: unknown, current: string): string => {
  if (raw === undefined) return current;
  if (typeof raw !== 'string') {
    throw new Error(`/sync answered with a ${typeof raw} next_batch where a token was required`);
  }
  return raw;
};

/** Largest offset `Date` can represent; past it `toISOString()` throws a RangeError. */
const MAX_TIMESTAMP_MS = 8.64e15;

const isoTimestamp = (ts: unknown): string =>
  new Date(
    typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts) <= MAX_TIMESTAMP_MS ? ts : 0,
  ).toISOString();

/**
 * Coerce every member-controlled field rather than trusting it: a non-string `body` reaches core's
 * mention parser and a non-numeric `origin_server_ts` reaches `Date#toISOString`, either of which
 * throws — and a throw out of `fetchRecent` bricks startup catch-up on every subsequent restart.
 */
export function eventToMessage(topic: Topic, e: MessageEvent): Message {
  const body = contentOf(e).body;
  return buildMessage({
    topic,
    sender: typeof e.sender === 'string' ? e.sender : '',
    content: typeof body === 'string' ? body : '',
    timestamp: isoTimestamp(e.origin_server_ts),
    id: e.event_id,
  });
}

/**
 * Matrix 429s carry `retry_after_ms` (MS) in the JSON body; Synapse ALSO sends the standard
 * `Retry-After` header (both RFC 9110 forms). Prefer the header, then the body. Returned UNCLAMPED
 * and `undefined` when there is no usable hint, so that we never retry sooner than the homeserver
 * asked — that is what escalates a rate limit into a ban — and the ceiling stays in net-util.
 */
export async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { retry_after_ms?: number };
    const ms = json.retry_after_ms;
    if (typeof ms === 'number' && ms > 0) return ms;
  } catch {
    /* no usable body hint */
  }
  return undefined;
}
