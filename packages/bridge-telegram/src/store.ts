import { appendFileSync, readFileSync } from 'node:fs';

/**
 * One observed Telegram message, as persisted to the JSONL store. Everything needed to
 * reconstruct a seam `Message` later: the composite dedup key is derived as
 * `<chat_id>:<message_id>` and the per-topic cursor as `String(message_id)`.
 */
export interface StoredRecord {
  /** Logical Parley topic this message belongs to. */
  topic: string;
  /** Telegram chat id (stringified) — half of the composite backendMsgId. */
  chat_id: string;
  /** Telegram per-chat message_id — monotonic within a chat, hence the topic cursor. */
  message_id: number;
  /** Sender handle (`from.username ?? String(from.id)`; see index.ts). */
  sender: string;
  /** Message body. */
  content: string;
  /** ISO 8601, informational only — never used for ordering or dedup (DESIGN §5). */
  ts: string;
}

/** The composite dedup key for a record — mirrors the plugin's backendMsgId. */
export const keyOf = (rec: Pick<StoredRecord, 'chat_id' | 'message_id'>): string =>
  `${rec.chat_id}:${rec.message_id}`;

/**
 * Append-only JSONL store of every message this bridge has OBSERVED (own sends via the
 * `sendMessage` response + foreign messages via `getUpdates`). The Telegram Bot API exposes
 * NO history endpoint, so this store IS the durable, replayable history the seam contract
 * asks for (DESIGN §6) — limited to what the bridge has seen (see the caveat in index.ts).
 *
 * Loaded fully at `connect` into a per-topic array sorted ascending by `message_id` plus a
 * `Set<backendMsgId>` for dedup; `append` is `fs.appendFileSync` (write-through, nothing to
 * flush) followed by an in-order insert.
 *
 * ONE bridge process per store file AND per bot token, by design: `appendFileSync` from a
 * single process is atomic enough for JSONL, but two processes interleaving appends (or two
 * `getUpdates` pollers racing on one token — Telegram answers the second with HTTP 409)
 * are structurally unsupported. See the "Multiple concurrent sessions" section in README.md.
 */
export class ObservedStore {
  /** topic → records sorted ascending by `message_id`. */
  private readonly byTopic = new Map<string, StoredRecord[]>();
  /** Every observed composite id — the dedup set. */
  private readonly seen = new Set<string>();

  constructor(private readonly path: string) {
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // No store yet — first run against this path starts empty.
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        this.insert(JSON.parse(line) as StoredRecord);
      } catch {
        // A torn tail line (crash mid-append) is dropped; every complete line loads.
      }
    }
  }

  /**
   * Persist + index one record. Returns `false` (and writes nothing) if its composite id
   * was already observed — dedup holds when the same message arrives twice (e.g. a
   * `getUpdates` backlog replayed after a restart).
   */
  append(rec: StoredRecord): boolean {
    if (this.seen.has(keyOf(rec))) return false;
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`);
    this.insert(rec);
    return true;
  }

  /** True iff this composite id has been observed. */
  has(backendMsgId: string): boolean {
    return this.seen.has(backendMsgId);
  }

  /** All records for `topic`, sorted ascending by `message_id`. Do not mutate. */
  entries(topic: string): readonly StoredRecord[] {
    return this.byTopic.get(topic) ?? [];
  }

  /** Current max `message_id` observed for `topic` (0 when none) — the subscribe watermark. */
  maxMessageId(topic: string): number {
    const list = this.byTopic.get(topic);
    const last = list?.at(-1);
    return last?.message_id ?? 0;
  }

  /** Drop the in-memory index. Appends are write-through, so there is nothing to flush. */
  close(): void {
    this.byTopic.clear();
    this.seen.clear();
  }

  /** Index a record: dedup-set + in-order insert (append-at-tail is the common case). */
  private insert(rec: StoredRecord): void {
    const id = keyOf(rec);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    let list = this.byTopic.get(rec.topic);
    if (list === undefined) {
      list = [];
      this.byTopic.set(rec.topic, list);
    }
    const last = list.at(-1);
    if (last === undefined || last.message_id < rec.message_id) {
      list.push(rec);
      return;
    }
    // Rare out-of-order arrival (e.g. store lines interleaved across chats on reload):
    // binary-search the insertion point to keep the array sorted ascending.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((list[mid]?.message_id ?? 0) < rec.message_id) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, rec);
  }
}
