import { asCursor, type Cursor, type FetchRecentArgs } from '@sharptrick/parley-core';

/** The subset of a Slack message object (history entry / `message` event) that we read. */
export interface SlackMessage {
  type: string;
  subtype?: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  thread_ts?: string;
}

/**
 * `ts` shape: `<seconds>.<fraction>`. Every inbound record is vendor- or attacker-controlled, so
 * keep this narrow ahead of every use of `ts`, so that a malformed field cannot reach
 * {@link compareTs}, `new Date(...)` or `asBackendMsgId` — where it throws, or mints an empty dedup
 * key. The digit bounds are load-bearing: a real `ts` has 10 seconds digits, and anything past 12
 * makes `new Date(seconds * 1000)` throw on the normalize path, wedging the topic's catch-up.
 */
export const TS_RE = /^\d{1,12}\.\d{1,12}$/;

export const hasUsableTs = (m: unknown): m is SlackMessage =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as SlackMessage).ts === 'string' &&
  TS_RE.test((m as SlackMessage).ts);

/**
 * The subtypes carrying new channel-level content, alongside a plain (subtype-less) post. Widen
 * this only for a subtype that is new content with its own `ts`. Keep mutation records
 * (`message_changed`, `message_deleted`, …) out, so that a human utterance already delivered under
 * its own id is not delivered a second time under the mutation's id; keep system records
 * (`channel_join`, …) out, so that join spam stays out of agent context.
 */
const SURFACED_SUBTYPES = new Set(['bot_message', 'file_share', 'me_message', 'thread_broadcast']);

/**
 * A plain reply inside a thread is not channel-level content: `conversations.history` does not
 * return it, so surfacing the live copy would deliver a message no catch-up could ever replay
 * (DESIGN §6/§7). A thread's own parent carries `thread_ts === ts`, and a reply the author
 * broadcasts arrives as `thread_broadcast` — both stay.
 */
const isChannelLevel = (m: SlackMessage): boolean =>
  typeof m.thread_ts !== 'string' || m.thread_ts === m.ts || m.subtype === 'thread_broadcast';

export const isPlainMessage = (m: unknown): m is SlackMessage =>
  hasUsableTs(m) &&
  m.type === 'message' &&
  (m.subtype === undefined || (typeof m.subtype === 'string' && SURFACED_SUBTYPES.has(m.subtype))) &&
  isChannelLevel(m);

/**
 * Compare two Slack `ts` values (`'<seconds>.<suffix>'`) — the cursor order key. NOT a float
 * compare: `Number('<seconds>.<suffix>')` loses the low-order digits outright once the seconds grow
 * past the double's ~1 µs resolution there, collapsing distinct `ts` values to equal. NOT a lexical
 * compare: seconds are unpadded, so `'2.…'` would sort after `'10.…'`. The suffix is compared as a
 * FRACTION — zero-padded to a common width, since `.1` is 0.1 s, not 1 µs.
 */
export function compareTs(a: string, b: string): number {
  const [aSec, aSub = ''] = a.split('.');
  const [bSec, bSub = ''] = b.split('.');
  const bySec = Number(aSec) - Number(bSec);
  if (bySec !== 0) return bySec;
  const width = Math.max(aSub.length, bSub.length);
  return Number(aSub.padEnd(width, '0') || '0') - Number(bSub.padEnd(width, '0') || '0');
}

/**
 * The cursor for a window that surfaced nothing. Every walk that reaches here ran to cursor
 * exhaustion, so the newest entry it read sits above nothing it skipped. Keep the walk's short
 * exits throwing, so that a truncated walk can never reach here and step the cursor over history
 * it did not read.
 */
export function emptyCursor(args: FetchRecentArgs, newestSeenTs: string | undefined): Cursor {
  if (newestSeenTs !== undefined) return asCursor(newestSeenTs);
  return args.since ?? asCursor('0');
}
