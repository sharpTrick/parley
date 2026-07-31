import { randomBytes } from 'node:crypto';
import type { ObservedRecord, StoredRecord } from './store.js';

/**
 * Marks the line carrying the store FILE's identity, minted once when it is created. Every `#` line
 * below is deliberately INVALID JSON, so that a reader which predates it drops the line as garbled
 * rather than indexing it as a record.
 */
export const EPOCH_LINE = '#epoch ';
/**
 * Marks a line carrying the two sequence watermarks, `#seq <issued> <intact>`: the highest sequence
 * this store has STAMPED, and the highest one whose record was written BELOW this line. The record
 * lines alone cannot carry either — losing them lowers the reconstructed high-water back under
 * cursors already handed out, and the store then re-mints those exact sequences.
 */
export const SEQ_LINE = '#seq ';
/** Marks a line carrying the chat ids this bridge serves across a restart. */
export const SERVED_ID_LINE = '#served ';
/** Marks the line a compaction writes to carry the eviction memory across a restart. */
export const EVICTED_ID_LINE = '#evicted ';

/** Shape of a store-file identity: 16 hex digits, so a cursor carrying one is unmistakable. */
const EPOCH_PATTERN = /^[0-9a-f]{16}$/;

/** The {@link StoredRecord} fields a loaded line must carry as strings. */
const RECORD_STRING_FIELDS = ['chat_id', 'sender', 'content', 'ts'] as const;

/** A fresh store-file identity, minted when the file is created or found damaged. */
export function mintEpoch(): string {
  return randomBytes(8).toString('hex');
}

/** The string ids a `#`-prefixed bookkeeping line carries, or none when it is garbled. */
export function parseIds(line: string, prefix: string): string[] {
  const ids = JSON.parse(line.slice(prefix.length)) as unknown;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

/**
 * A store-file identity read off disk. Anything else is a damaged line: the loader drops it and the
 * store mints a fresh identity, which invalidates the outstanding cursors LOUDLY rather than
 * adopting a name that may not be the one that stamped the sequences in this file.
 */
export function requireEpoch(raw: string): string {
  const epoch = raw.trim();
  if (!EPOCH_PATTERN.test(epoch)) throw new Error('ObservedStore: unreadable store identity');
  return epoch;
}

/**
 * The `<issued, intact>` pair a {@link SEQ_LINE} carries. Anything else is a damaged line: the
 * loader drops it and counts the drop as record loss, because a watermark that cannot be read is
 * exactly the state under which a sequence gets re-issued.
 */
export function requireWatermarks(raw: string): [number, number] {
  const [issued, intact, ...rest] = raw.trim().split(' ').map(Number);
  const ok =
    rest.length === 0 &&
    [issued, intact].every((n) => n !== undefined && Number.isInteger(n) && n >= 0);
  if (!ok || (intact as number) > (issued as number)) {
    throw new Error('ObservedStore: unreadable sequence watermark');
  }
  return [issued as number, intact as number];
}

/**
 * A loaded record line, holding every field to the type {@link StoredRecord} declares. A line
 * failing any of them is garbled — the loader's try/catch drops it. Keep it a drop rather than a
 * fresh stamp, so that a damaged line cannot be handed a sequence an agent's cursor already sits
 * above and become permanently unreachable.
 *
 * Keep the field types checked HERE as well as at the seam, so that a file already carrying a
 * record of the wrong shape heals on load instead of bricking its chat: a non-string `content`
 * reaches `buildMessage` and throws on EVERY later `fetchRecent` for that chat, and no Bot API
 * call can refill the topic once the store is the only copy.
 */
export function parseRecord(raw: Partial<StoredRecord> & ObservedRecord): StoredRecord {
  const { seq } = raw;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
    throw new Error('record carries no observation sequence');
  }
  for (const field of RECORD_STRING_FIELDS) {
    if (typeof raw[field] !== 'string') throw new Error(`record carries a non-string ${field}`);
  }
  if (typeof raw.message_id !== 'number' || !Number.isFinite(raw.message_id)) {
    throw new Error('record carries no numeric message_id');
  }
  return { ...raw, seq };
}
