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
      { timeline?: { events?: MatrixEvent[] } }
    >;
    leave?: Record<string, unknown>;
  };
}

/** The `membership` of the last `m.room.member` a leave section carries, if it carries one. */
const membershipIn = (left: unknown): string | undefined => {
  const events = (left as { timeline?: { events?: unknown } } | null)?.timeline?.events;
  if (!Array.isArray(events)) return undefined;
  for (const e of [...events].reverse()) {
    const member = e as { type?: unknown; content?: { membership?: unknown } } | null;
    if (member?.type !== 'm.room.member') continue;
    if (typeof member.content?.membership === 'string') return member.content.membership;
  }
  return undefined;
};

/**
 * The membership a `/sync` reports for a room it has stopped delivering — a kick, a ban, a leave.
 * Keep this read from `rooms.leave`, and only when `rooms.join` does not ALSO carry the room, so
 * that neither an idle incremental `/sync` (which legitimately omits a room with no new events) nor
 * a delta spanning a removal and a re-join is read as a loss.
 */
export const membershipLossOf = (sync: SyncResponse, roomId: string): string | undefined => {
  const left = sync.rooms?.leave?.[roomId];
  if (left === undefined || sync.rooms?.join?.[roomId] !== undefined) return undefined;
  return membershipIn(left) ?? 'not joined';
};

/**
 * A field a 200 must carry as a non-empty string before this plugin ADOPTS it — a credential it will
 * bear on every later request, or an id it hands core to persist. Keep it a THROW naming the call
 * and the homeserver, so that a homeserver, a proxy or a captive portal answering the right status
 * with the wrong body cannot leave the plugin holding a value it will use forever: an adopted
 * non-string goes out on the wire as `Bearer undefined`, or into a `read-state.json` as a cursor no
 * later call can resolve.
 */
export const adoptedString = (raw: unknown, field: string, call: string): string => {
  if (typeof raw === 'string' && raw !== '') return raw;
  throw new Error(
    `[parley-matrix] ${call} answered 200 but its ${field} was ` +
      `${JSON.stringify(raw) ?? typeof raw} where a non-empty string was required; this is not a ` +
      'Matrix homeserver, or a proxy or captive portal answered for it.',
  );
};

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
 * The resume token an INCREMENTAL `/sync` advances to, given the token the request was made with and
 * how many timeline events the answer carried. Keep an absent, empty, mistyped or UNADVANCED one a
 * THROW, so that the loop cannot re-issue the `?since=` it has just been answered on: that
 * re-requests the same delta, and this plugin holds no in-push dedup — the contract lets push DROP
 * (DESIGN §6) and still forbids it to REPEAT, under the same `event_id` and the same cursor.
 */
export const nextBatchOf = (raw: unknown, current: string, carried: number): string => {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(
      `/sync answered with next_batch ${JSON.stringify(raw) ?? typeof raw} where a resume token ` +
        'was required',
    );
  }
  if (carried > 0 && raw === current) {
    throw new Error(
      `/sync answered with the token it was given (${raw}) while carrying ${carried} timeline ` +
        'event(s); resuming from it would re-read that delta and deliver it a second time',
    );
  }
  return raw;
};

/**
 * {@link nextBatchOf} for a POSITIONING `/sync`, which has no previous token to fall back on. Keep an
 * absent or empty one a THROW too, so that no caller can resume from `?since=` — which a homeserver
 * reads as an INITIAL sync, making the loop's first "incremental" answer the room's existing history,
 * delivered to a subscribe handler as live events.
 */
export const positioningBatchOf = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(
      `/sync positioning answered with next_batch ${JSON.stringify(raw)} where a resume token was ` +
        'required',
    );
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
