import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';

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

/** Default max records retained PER topic when the caller doesn't override it. */
const DEFAULT_MAX_PER_TOPIC = 10_000;

/**
 * Append-only JSONL store of every message this bridge has OBSERVED (own sends via the
 * `sendMessage` response + foreign messages via `getUpdates`). The Telegram Bot API exposes
 * NO history endpoint, so this store IS the durable, replayable history the seam contract
 * asks for (DESIGN §6) — limited to what the bridge has seen (see the caveat in index.ts).
 *
 * Loaded at `connect` into a per-topic array sorted ascending by `message_id` plus a
 * `Set<backendMsgId>` for dedup, then BOUNDED to the newest {@link DEFAULT_MAX_PER_TOPIC}
 * records per topic (compacting the on-disk file when anything is dropped) so a long-lived
 * bridge on a busy chat can't grow the file/RAM without limit or turn `connect` into a
 * tens-of-seconds parse (BUG-32). `append` writes one JSONL line through a persistent fd (not
 * a reopen-per-message) followed by an in-order insert.
 *
 * ONE bridge process per store file AND per bot token, by design: a single process's appends
 * are atomic enough for JSONL, but two processes interleaving appends (or two `getUpdates`
 * pollers racing on one token — Telegram answers the second with HTTP 409) are structurally
 * unsupported. See the "Multiple concurrent sessions" section in README.md.
 */
export class ObservedStore {
  /** topic → records sorted ascending by `message_id` (bounded to the newest {@link maxPerTopic}). */
  private readonly byTopic = new Map<string, StoredRecord[]>();
  /** The dedup set — the composite ids of the currently-retained records (BUG-32: bounded). */
  private readonly seen = new Set<string>();
  /** Newest-N-per-topic retention bound (BUG-32). */
  private readonly maxPerTopic: number;
  /** Persistent append descriptor — one open fd for the process, not open/close per append. */
  private fd: number | undefined;

  constructor(
    private readonly path: string,
    maxPerTopic = DEFAULT_MAX_PER_TOPIC,
  ) {
    this.maxPerTopic = maxPerTopic > 0 ? maxPerTopic : DEFAULT_MAX_PER_TOPIC;
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // No store yet — first run against this path starts empty.
    }
    // BUG-19: drop a crash-torn tail fragment (a final line with no trailing '\n') BEFORE any
    // append, so the next record can't glue onto it. The repaired file is rewritten below.
    let torn = false;
    if (raw !== '' && !raw.endsWith('\n')) {
      const lastNl = raw.lastIndexOf('\n');
      raw = lastNl >= 0 ? raw.slice(0, lastNl + 1) : '';
      torn = true;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        this.insert(JSON.parse(line) as StoredRecord);
      } catch {
        // A torn/garbled line is dropped; every complete line loads.
      }
    }
    // BUG-32: bound each topic to its newest N records (rebuilding `seen` from the survivors).
    const trimmed = this.applyRetention();
    // Compact the on-disk file when we dropped a torn fragment (BUG-19) or over-retention
    // records (BUG-32); the rewrite yields a clean, newline-terminated, bounded file. This runs
    // AFTER the BUG-19 repair so the fragment is never carried into the compacted output.
    if (torn || trimmed) this.rewrite();
    // BUG-32: hold one append fd for the process instead of reopening the file per append.
    this.fd = openSync(path, 'a');
  }

  /**
   * Persist + index one record. Returns `false` (and writes nothing) if its composite id
   * was already observed — dedup holds when the same message arrives twice (e.g. a
   * `getUpdates` backlog replayed after a restart).
   */
  append(rec: StoredRecord): boolean {
    if (this.seen.has(keyOf(rec))) return false;
    if (this.fd === undefined) return false; // store closed — no-op (BUG-32: fd released).
    appendFileSync(this.fd, `${JSON.stringify(rec)}\n`);
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

  /** Drop the in-memory index and release the append fd. Appends are write-through — nothing to flush. */
  close(): void {
    this.byTopic.clear();
    this.seen.clear();
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  /**
   * Bound each topic to its newest {@link maxPerTopic} records and, if anything was dropped,
   * rebuild the dedup `seen` set from the survivors so neither map grows without bound (BUG-32).
   * Returns true iff any record was evicted (the on-disk file then needs a compacting rewrite).
   */
  private applyRetention(): boolean {
    let trimmed = false;
    for (const list of this.byTopic.values()) {
      if (list.length > this.maxPerTopic) {
        list.splice(0, list.length - this.maxPerTopic);
        trimmed = true;
      }
    }
    if (trimmed) {
      this.seen.clear();
      for (const list of this.byTopic.values()) {
        for (const rec of list) this.seen.add(keyOf(rec));
      }
    }
    return trimmed;
  }

  /** Rewrite the file from the retained records — a clean, newline-terminated, bounded file. */
  private rewrite(): void {
    const lines: string[] = [];
    for (const list of this.byTopic.values()) {
      for (const rec of list) lines.push(JSON.stringify(rec));
    }
    writeFileSync(this.path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
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
