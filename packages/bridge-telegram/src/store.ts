import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * One observed Telegram message, as persisted to the JSONL store. Everything needed to
 * reconstruct a seam `Message` later: the composite dedup key is derived as
 * `<chat_id>:<message_id>` and the per-topic cursor as `String(message_id)`.
 *
 * Records are indexed by `chat_id`, never by the Parley topic: a topic is a local naming
 * choice (`chat_map`, an `@channelusername` literal or a numeric literal can all name the
 * same chat) while the chat id is what Telegram stamps on every inbound update. Keying on
 * the chat id is what makes ingestion independent of which seam call ran first, and of
 * whether any topic had been named at all when the message arrived.
 */
export interface StoredRecord {
  /** Telegram chat id (stringified, numeric form) — half of the composite backendMsgId. */
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

/** Default max records retained PER chat when the caller doesn't override it. */
const DEFAULT_MAX_PER_CHAT = 10_000;
/** Default max distinct chats retained when the caller doesn't override it. */
const DEFAULT_MAX_CHATS = 1_000;

/**
 * Append-only JSONL store of every message this bridge has OBSERVED (own sends via the
 * `sendMessage` response + foreign messages via `getUpdates`). The Telegram Bot API exposes
 * NO history endpoint, so this store IS the durable, replayable history the seam contract
 * asks for (DESIGN §6) — limited to what the bridge has seen (see the caveat in index.ts).
 *
 * Two bounds hold at ALL times — on load AND on every `append` — because both axes are
 * attacker-influenced: anyone who can post in a chat the bot is in drives records, and anyone
 * who can add the bot to a group drives chats. Per chat the newest {@link maxPerChat} records
 * are retained; across chats at most {@link maxChats} are retained, and once that many are
 * held a chat this bridge does not {@link serve} is refused outright rather than evicting a
 * chat the operator configured. The on-disk file is compacted once evictions since the last
 * rewrite exceed the retained record count, so the file stays within a constant factor of the
 * in-memory bound instead of growing forever (BUG-32).
 *
 * ONE bridge process per store file AND per bot token, by design: a single process's appends
 * are atomic enough for JSONL, but two processes interleaving appends (or two `getUpdates`
 * pollers racing on one token — Telegram answers the second with HTTP 409) are structurally
 * unsupported. See the "Multiple concurrent sessions" section in README.md.
 */
export class ObservedStore {
  /** chat id → records sorted ascending by `message_id` (bounded to the newest {@link maxPerChat}). */
  private readonly byChat = new Map<string, StoredRecord[]>();
  /** The dedup set — the composite ids of the currently-retained records (BUG-32: bounded). */
  private readonly seen = new Set<string>();
  /** Chats this bridge serves (a configured topic resolves to them) — never refused by the cap. */
  private readonly served = new Set<string>();
  /** Newest-N-per-chat retention bound (BUG-32). */
  private readonly maxPerChat: number;
  /** Max distinct chats retained (BUG-32) — the bot's chat membership is not ours to control. */
  private readonly maxChats: number;
  /** Records evicted since the last on-disk compaction — drives the amortized rewrite. */
  private evictedSinceRewrite = 0;
  /** Persistent append descriptor — one open fd for the process, not open/close per append. */
  private fd: number | undefined;

  constructor(
    private readonly path: string,
    maxPerChat = DEFAULT_MAX_PER_CHAT,
    maxChats = DEFAULT_MAX_CHATS,
  ) {
    this.maxPerChat = maxPerChat > 0 ? maxPerChat : DEFAULT_MAX_PER_CHAT;
    this.maxChats = maxChats > 0 ? maxChats : DEFAULT_MAX_CHATS;
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
    const cappedChats = this.applyChatCap();
    const trimmed = this.applyRetention() || cappedChats;
    // Compact the on-disk file when we dropped a torn fragment (BUG-19) or over-retention
    // records (BUG-32); the rewrite yields a clean, newline-terminated, bounded file. This runs
    // AFTER the BUG-19 repair so the fragment is never carried into the compacted output.
    if (torn || trimmed) this.rewrite();
    // BUG-32: hold one append fd for the process instead of reopening the file per append.
    this.fd = openSync(path, 'a');
  }

  /**
   * Mark `chatId` as one this bridge serves: a configured topic resolves to it, so it is
   * admitted even once {@link maxChats} chats are held. Keep this, so that a flood of
   * unconfigured group chats cannot crowd out the operator's own topics.
   */
  serve(chatId: string): void {
    this.served.add(chatId);
  }

  /**
   * Persist + index one record, holding both retention bounds. Returns `false` (and writes
   * nothing) if its composite id was already observed — dedup holds when the same message
   * arrives twice (e.g. a `getUpdates` backlog replayed after a restart) — or if it belongs to
   * an unserved chat beyond the chat cap.
   */
  append(rec: StoredRecord): boolean {
    if (this.seen.has(keyOf(rec))) return false;
    if (this.fd === undefined) return false; // store closed — no-op (BUG-32: fd released).
    if (!this.admits(rec.chat_id)) return false;
    appendFileSync(this.fd, `${JSON.stringify(rec)}\n`);
    this.insert(rec);
    if (this.applyRetention()) this.compactIfDue();
    return true;
  }

  /** True iff this composite id has been observed. */
  has(backendMsgId: string): boolean {
    return this.seen.has(backendMsgId);
  }

  /** All records for `chatId`, sorted ascending by `message_id`. Do not mutate. */
  entries(chatId: string): readonly StoredRecord[] {
    return this.byChat.get(chatId) ?? [];
  }

  /** Current max `message_id` observed for `chatId` (0 when none) — the subscribe watermark. */
  maxMessageId(chatId: string): number {
    const list = this.byChat.get(chatId);
    const last = list?.at(-1);
    return last?.message_id ?? 0;
  }

  /** Total records currently retained across all chats (the dedup set holds exactly those). */
  size(): number {
    return this.seen.size;
  }

  /** Drop the in-memory index and release the append fd. Appends are write-through — nothing to flush. */
  close(): void {
    this.byChat.clear();
    this.seen.clear();
    this.served.clear();
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  /** Whether a record for `chatId` may be retained at all (BUG-32: bounded chat count). */
  private admits(chatId: string): boolean {
    if (this.byChat.has(chatId) || this.served.has(chatId)) return true;
    return this.byChat.size < this.maxChats;
  }

  /**
   * Hold the per-chat bound: newest {@link maxPerChat} records per chat, rebuilding the dedup
   * `seen` set from the survivors so neither map grows without bound (BUG-32). Returns true
   * iff anything was evicted.
   */
  private applyRetention(): boolean {
    let evicted = 0;
    for (const list of this.byChat.values()) {
      if (list.length <= this.maxPerChat) continue;
      evicted += this.evict(list.splice(0, list.length - this.maxPerChat));
    }
    return evicted > 0;
  }

  /**
   * Hold the chat-count bound on a file written under a looser cap. Chats are dropped in
   * first-seen order (a Map iterates by insertion), keeping the most recently introduced.
   * Runtime admission is {@link admits} instead, so a chat the bridge serves is never evicted.
   */
  private applyChatCap(): boolean {
    let evicted = 0;
    const excess = Math.max(0, this.byChat.size - this.maxChats);
    for (const chatId of [...this.byChat.keys()].slice(0, excess)) {
      evicted += this.evict(this.byChat.get(chatId) ?? []);
      this.byChat.delete(chatId);
    }
    return evicted > 0;
  }

  /** Retire evicted records: drop their dedup ids and arm compaction. Returns how many. */
  private evict(records: readonly StoredRecord[]): number {
    for (const rec of records) this.seen.delete(keyOf(rec));
    this.evictedSinceRewrite += records.length;
    return records.length;
  }

  /**
   * Compact once the dead lines on disk have grown to the live record count: the file then
   * stays within ~2x the in-memory bound while rewrites stay amortized O(1) per append.
   */
  private compactIfDue(): void {
    if (this.fd === undefined) return;
    if (this.evictedSinceRewrite < Math.max(this.maxPerChat, this.size())) return;
    closeSync(this.fd);
    this.rewrite();
    this.fd = openSync(this.path, 'a');
  }

  /** Rewrite the file from the retained records — a clean, newline-terminated, bounded file. */
  private rewrite(): void {
    const lines: string[] = [];
    for (const list of this.byChat.values()) {
      for (const rec of list) lines.push(JSON.stringify(rec));
    }
    writeFileSync(this.path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    this.evictedSinceRewrite = 0;
  }

  /** Index a record: dedup-set + in-order insert (append-at-tail is the common case). */
  private insert(rec: StoredRecord): void {
    const id = keyOf(rec);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    let list = this.byChat.get(rec.chat_id);
    if (list === undefined) {
      list = [];
      this.byChat.set(rec.chat_id, list);
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
