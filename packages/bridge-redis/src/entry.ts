import { buildMessage, type Message, type Topic } from '@sharptrick/parley-core';

/** One row as Redis returns it from `XRANGE`/`XREAD`. */
export interface Entry {
  id: string;
  message: Record<string, string>;
}

/** The sender of an entry written by something other than this plugin, which carries no `sender`. */
const UNKNOWN_SENDER = 'unknown';
/** The last instant ECMAScript `Date` can represent; one millisecond further is a `RangeError`. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Anyone with access to the Redis can `XADD` to a parley stream, and a stream outlives the plugin
 * version that created it, so an entry written without this plugin's fields still has to normalize
 * into a Message satisfying the DESIGN §5 contract — not one with an unparseable timestamp and an
 * empty sender that collides with every other empty sender.
 */
export function rowToMessage(topic: Topic, id: string, fields: Record<string, string>): Message {
  const sender = fields.sender ?? '';
  return buildMessage({
    topic,
    sender: sender === '' ? UNKNOWN_SENDER : sender,
    content: fields.content ?? '',
    timestamp: entryTimestamp(id, fields.ts),
    id,
  });
}

/**
 * The entry's own `ts` when it is a real date, else the stream id's own millisecond component —
 * either way RE-SERIALIZED rather than forwarded, so that a foreign writer's `Mon Jan 01 2020` or
 * `12/25/2021` cannot reach `Message.timestamp`, which DESIGN §5 declares is ISO 8601: which
 * non-ISO spellings `Date.parse` accepts is implementation-defined and varies by Node release. Keep
 * the range clamp, so that a millisecond a foreign writer CHOSE cannot throw `RangeError` out of
 * the seam: an id's millisecond component is a uint64, so `XADD <key> 9000000000000000-0` from
 * anyone holding a redis-cli names an instant past `Date`, and the throw would wedge `fetchRecent`
 * for that topic forever — the entry is durable — while the read loop dropped it in silence.
 */
function entryTimestamp(id: string, ts: string | undefined): string {
  const parsed = ts === undefined ? Number.NaN : Date.parse(ts);
  const ms = Number.isNaN(parsed) ? Number(id.split('-')[0]) : parsed;
  return new Date(ms >= 0 && ms <= MAX_DATE_MS ? ms : 0).toISOString();
}
