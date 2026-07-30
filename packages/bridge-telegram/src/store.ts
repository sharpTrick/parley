import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * One observed Telegram message, as persisted to the JSONL store. Everything needed to
 * reconstruct a seam `Message` later: the composite dedup key is derived as
 * `<chat_id>:<message_id>` and the per-topic cursor as `String(seq)`.
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
  /** Telegram per-chat message_id — the other half of the composite backendMsgId. */
  message_id: number;
  /**
   * Local observation sequence, stamped by {@link ObservedStore.append} in the order this
   * bridge SAW the message — the topic cursor. Keep the cursor on observation order rather
   * than on `message_id`, so that a message minted before our own post but delivered by
   * `getUpdates` after it still lands above every cursor already handed out.
   */
  seq: number;
  /** Sender handle (`from.username ?? String(from.id)`; see index.ts). */
  sender: string;
  /** Message body. */
  content: string;
  /** ISO 8601, informational only — never used for ordering or dedup (DESIGN §5). */
  ts: string;
}

/** A message as observed, before the store stamps its observation sequence. */
export type ObservedRecord = Omit<StoredRecord, 'seq'>;

/** The composite dedup key for a record — mirrors the plugin's backendMsgId. */
export const keyOf = (rec: Pick<StoredRecord, 'chat_id' | 'message_id'>): string =>
  `${rec.chat_id}:${rec.message_id}`;

/** Default max records retained PER chat when the caller doesn't override it. */
const DEFAULT_MAX_PER_CHAT = 10_000;
/** Default max distinct chats retained when the caller doesn't override it. */
const DEFAULT_MAX_CHATS = 1_000;
/**
 * How many EVICTED composite ids stay refusable after their records are gone — store-wide, and
 * deliberately independent of every retention bound. What Telegram can redeliver after this bridge
 * has already observed it is one unacknowledged `getUpdates` batch (at most 100 updates, since the
 * offset only advances on the NEXT poll), so keep this memory sized on THAT window rather than on
 * the operator's retention knob: narrowing retention must not narrow the once-only guarantee with
 * it. Own posts are never redelivered at all.
 */
const EVICTED_ID_MEMORY = 1_000;
/**
 * Marks the line a compaction writes to carry {@link ObservedStore.evicted} across a restart.
 * Keep it INVALID JSON, so that a reader which predates it drops the line as garbled rather than
 * indexing it as a record.
 */
const EVICTED_ID_LINE = '#evicted ';
/** Mode for everything this store creates — the plaintext of every message the bridge has seen. */
const OWNER_ONLY_FILE = 0o600;
/** Mode for a directory this store creates for {@link ObservedStore.path}. */
const OWNER_ONLY_DIR = 0o700;

/**
 * Narrow a store file readable beyond its owner, reporting the change. An `openSync` mode applies
 * only to a file it CREATES, so an upgrade onto a store written by an earlier version — or a
 * compaction output a broken umask widened — is otherwise left silently world-readable.
 *
 * Only files this store owns are touched: a pre-existing DIRECTORY can be the operator's working
 * directory or a shared state root, and narrowing that on their behalf is a bigger surprise than
 * the one it prevents.
 */
function restrictMode(path: string): void {
  let current: number;
  try {
    current = statSync(path).mode & 0o777;
  } catch {
    return;
  }
  if ((current & 0o077) === 0) return;
  const target = current & 0o700;
  try {
    chmodSync(path, target);
    process.stderr.write(
      `parley-telegram: tightened ${path} from 0${current.toString(8)} to 0${target.toString(8)} ` +
        `(the observed-message store must not be readable by other accounts)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `parley-telegram: cannot restrict ${path} (mode 0${current.toString(8)}, ` +
        `${err instanceof Error ? err.message : String(err)}) — the observed-message store is ` +
        `readable by other accounts on this host\n`,
    );
  }
}

/**
 * A retention bound is a promise about disk and memory. Keep it a hard failure rather than a
 * substituted default, so that an operator who asks for a narrow bound never silently gets the
 * built-in wide one — a deep local archive of every chat the bot is in, which is the opposite of
 * what they configured.
 */
function requirePositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ObservedStore: ${name} must be a positive integer — got ${String(value)}`);
  }
  return value;
}

/**
 * Append-only JSONL store of every message this bridge has OBSERVED (own sends via the
 * `sendMessage` response + foreign messages via `getUpdates`). The Telegram Bot API exposes
 * NO history endpoint, so this store IS the durable, replayable history the seam contract
 * asks for (DESIGN §6) — limited to what the bridge has seen (see the caveat in index.ts).
 *
 * Two bounds hold at ALL times — on load AND on every `append` — because both axes are
 * attacker-influenced: anyone who can post in a chat the bot is in drives records, and anyone
 * who can add the bot to a group drives chats. Per chat the newest {@link maxPerChat} records
 * are retained. Across chats at most {@link maxChats} are retained, and a chat this bridge
 * {@link serve}s is never evicted to make room — a new chat displaces the least recently
 * active UNSERVED chat instead, and is refused only when every retained chat is served.
 * The on-disk file is compacted once evictions since the last rewrite exceed the retained
 * record count, so the file stays within a constant factor of the in-memory bound instead of
 * growing forever.
 *
 * Dedup outlives retention: an evicted record's composite id stays refusable for a further
 * {@link EVICTED_ID_MEMORY} evictions. Keep the two horizons separate, so that a retention bound
 * narrower than Telegram's ~24h `getUpdates` replay horizon cannot re-admit a message this bridge
 * already served — which would hand the same `backendMsgId` out twice at two different cursors,
 * the second above a cursor the agent already holds.
 *
 * Everything it creates is owner-only (0600 file, 0700 directory it had to make): this file is the
 * full plaintext of every message the bridge has observed, in every chat the bot is in.
 *
 * ONE bridge process per store file AND per bot token, by design: a single process's appends
 * are atomic enough for JSONL, but two processes interleaving appends (or two `getUpdates`
 * pollers racing on one token — Telegram answers the second with HTTP 409) are structurally
 * unsupported. See the "Multiple concurrent sessions" section in README.md.
 */
export class ObservedStore {
  /** chat id → records ascending by `seq`; key order is least-recently-active first. */
  private readonly byChat = new Map<string, StoredRecord[]>();
  /** The dedup set — the composite ids of the currently-retained records (bounded). */
  private readonly seen = new Set<string>();
  /** Composite ids of evicted records, newest last — dedup memory past retention (bounded). */
  private readonly evicted = new Set<string>();
  /** Chats this bridge serves (a configured topic resolves to them) — never evicted or refused. */
  private readonly served = new Set<string>();
  /** Newest-N-per-chat retention bound. */
  private readonly maxPerChat: number;
  /** Max distinct chats retained — the bot's chat membership is not ours to control. */
  private readonly maxChats: number;
  /** Next observation sequence to stamp — store-wide, so an evicted chat can never reuse one. */
  private nextSeq = 1;
  /** Records evicted since the last on-disk compaction — drives the amortized rewrite. */
  private evictedSinceRewrite = 0;
  /** Persistent append descriptor — one open fd for the process, not open/close per append. */
  private fd: number | undefined;

  constructor(
    private readonly path: string,
    maxPerChat = DEFAULT_MAX_PER_CHAT,
    maxChats = DEFAULT_MAX_CHATS,
    served: Iterable<string> = [],
  ) {
    this.maxPerChat = requirePositiveInt('maxPerChat', maxPerChat);
    this.maxChats = requirePositiveInt('maxChats', maxChats);
    for (const chatId of served) this.served.add(chatId);
    mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // No store yet — first run against this path starts empty.
    }
    // Drop a crash-torn tail fragment (a final line with no trailing '\n') BEFORE any append,
    // so that the next record can't glue onto it. The repaired file is rewritten below.
    let torn = false;
    if (raw !== '' && !raw.endsWith('\n')) {
      const lastNl = raw.lastIndexOf('\n');
      raw = lastNl >= 0 ? raw.slice(0, lastNl + 1) : '';
      torn = true;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        if (line.startsWith(EVICTED_ID_LINE)) this.rememberEvicted(this.parseEvicted(line));
        else this.index(this.stamp(JSON.parse(line) as Partial<StoredRecord> & ObservedRecord));
      } catch {
        // A torn/garbled line is dropped; every complete line loads.
      }
    }
    const cappedChats = this.applyChatCap();
    const trimmed = this.applyRetention() || cappedChats;
    // Compact the on-disk file when we dropped a torn fragment or over-retention records; the
    // rewrite yields a clean, newline-terminated, bounded file. Keep this after the torn-tail
    // repair, so that the fragment is never carried into the compacted output.
    if (torn || trimmed) this.rewrite();
    this.fd = openSync(path, 'a', OWNER_ONLY_FILE);
    restrictMode(path);
  }

  /**
   * Mark `chatId` as one this bridge serves: a configured topic resolves to it, so it is
   * admitted past {@link maxChats} and never evicted to make room. Keep this, so that a flood
   * of unconfigured group chats cannot crowd out the operator's own topics.
   */
  serve(chatId: string): void {
    this.served.add(chatId);
  }

  /**
   * Persist + index one record under a fresh observation sequence, holding both retention
   * bounds. Returns the stored record, or `undefined` (writing nothing) when the record is
   * refused: its composite id was already observed — dedup holds when the same message arrives
   * twice, e.g. a `getUpdates` backlog replayed after a restart, whether or not retention has
   * since evicted the record — or every retained chat is served and this one is not, or there is
   * no append descriptor ({@link isOpen}).
   */
  append(observed: ObservedRecord): StoredRecord | undefined {
    if (this.has(keyOf(observed))) return undefined;
    if (this.fd === undefined) return undefined;
    if (!this.admit(observed.chat_id)) return undefined;
    const rec: StoredRecord = { ...observed, seq: this.nextSeq++ };
    appendFileSync(this.fd, `${JSON.stringify(rec)}\n`);
    this.index(rec);
    this.applyRetention();
    this.compactIfDue();
    return rec;
  }

  /**
   * True iff this composite id has been observed and is still remembered — a retained record, or
   * one retention evicted within the last {@link EVICTED_ID_MEMORY} evictions. This is the
   * once-only question, so it is what {@link append} refuses on; {@link size} is the retained
   * count, which is smaller.
   */
  has(backendMsgId: string): boolean {
    return this.seen.has(backendMsgId) || this.evicted.has(backendMsgId);
  }

  /** All records for `chatId`, ascending by observation sequence. Do not mutate. */
  entries(chatId: string): readonly StoredRecord[] {
    return this.byChat.get(chatId) ?? [];
  }

  /** Current max observation sequence for `chatId` (0 when none) — the subscribe watermark. */
  maxSeq(chatId: string): number {
    const list = this.byChat.get(chatId);
    return list?.at(-1)?.seq ?? 0;
  }

  /**
   * The highest observation sequence this store has ever stamped or loaded (0 when none) — the
   * ceiling on every cursor it can have issued. A `since` above it was minted by a store file
   * this one did not inherit, so the messages it refers to are unreachable from here.
   */
  highWater(): number {
    return this.nextSeq - 1;
  }

  /** True while the append descriptor is held — false after {@link close}, or if a reopen failed. */
  isOpen(): boolean {
    return this.fd !== undefined;
  }

  /** Total records currently RETAINED across all chats — see {@link has} for what is refusable. */
  size(): number {
    return this.seen.size;
  }

  /** Drop the in-memory index and release the append fd. Appends are write-through — nothing to flush. */
  close(): void {
    this.byChat.clear();
    this.seen.clear();
    this.evicted.clear();
    this.served.clear();
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  /**
   * Make room for a record from `chatId` under the chat-count bound. A served chat and
   * one already held are always admitted; otherwise the least recently active UNSERVED chat is
   * evicted. False only when every retained chat is served.
   */
  private admit(chatId: string): boolean {
    if (this.byChat.has(chatId) || this.served.has(chatId)) return true;
    if (this.byChat.size < this.maxChats) return true;
    return this.evictLeastRecentUnserved();
  }

  /** Drop the least recently active unserved chat entirely. False when there is none. */
  private evictLeastRecentUnserved(): boolean {
    for (const chatId of this.byChat.keys()) {
      if (this.served.has(chatId)) continue;
      this.evict(this.byChat.get(chatId) ?? []);
      this.byChat.delete(chatId);
      return true;
    }
    return false;
  }

  /**
   * Hold the per-chat bound: newest {@link maxPerChat} records per chat, rebuilding the dedup
   * `seen` set from the survivors so neither map grows without bound. Returns true
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
   * Hold the chat-count bound on a file written under a looser cap, dropping the least recently
   * active UNSERVED chats. A served chat is kept even past the cap: the Bot API has no history
   * endpoint, so evicting the operator's own chat destroys history nothing can ever backfill.
   */
  private applyChatCap(): boolean {
    let evicted = false;
    while (this.byChat.size > this.maxChats && this.evictLeastRecentUnserved()) evicted = true;
    return evicted;
  }

  /** Retire evicted records: move their dedup ids into the eviction memory and arm compaction. */
  private evict(records: readonly StoredRecord[]): number {
    const ids = records.map(keyOf);
    for (const id of ids) this.seen.delete(id);
    this.rememberEvicted(ids);
    this.evictedSinceRewrite += records.length;
    return records.length;
  }

  /** Hold the newest {@link EVICTED_ID_MEMORY} evicted ids, newest last (Set iterates in order). */
  private rememberEvicted(ids: readonly string[]): void {
    for (const id of ids) {
      this.evicted.delete(id);
      this.evicted.add(id);
    }
    for (const oldest of this.evicted) {
      if (this.evicted.size <= EVICTED_ID_MEMORY) break;
      this.evicted.delete(oldest);
    }
  }

  /** The composite ids a previous compaction persisted (see {@link EVICTED_ID_LINE}). */
  private parseEvicted(line: string): string[] {
    const ids = JSON.parse(line.slice(EVICTED_ID_LINE.length)) as unknown;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string');
  }

  /**
   * Compact once the dead lines on disk have grown to the live record count: the file then
   * stays within ~2x the in-memory bound while rewrites stay amortized O(1) per append.
   */
  private compactIfDue(): void {
    if (this.fd === undefined) return;
    if (this.evictedSinceRewrite < Math.max(this.maxPerChat, this.size())) return;
    closeSync(this.fd);
    // Release the descriptor number BEFORE the rewrite can throw, so that a failed compaction
    // cannot leave appends writing into whatever file or socket has since reused it.
    this.fd = undefined;
    try {
      this.rewrite();
    } finally {
      this.fd = openSync(this.path, 'a', OWNER_ONLY_FILE);
    }
  }

  /**
   * Rewrite the file from the retained records, via a temp file and a rename. Keep the replace
   * atomic, so that a crash or a full disk mid-compaction cannot truncate the only copy of
   * history this backend can ever produce.
   *
   * A compaction is where the evicted records' LINES leave the file, so it carries the eviction
   * memory out with them ({@link EVICTED_ID_LINE}) — otherwise dedup would reach back only as far
   * as the file, and a restart right after a compaction would re-admit a redelivered message the
   * bridge had already served.
   */
  private rewrite(): void {
    const lines: string[] = [];
    if (this.evicted.size > 0) {
      lines.push(`${EVICTED_ID_LINE}${JSON.stringify([...this.evicted])}`);
    }
    for (const list of this.byChat.values()) {
      for (const rec of list) lines.push(JSON.stringify(rec));
    }
    const tmp = `${this.path}.tmp`;
    // Keep the temp file owner-only, so that the rename cannot install a wider mode over a store
    // that was tightened when it was created.
    const fd = openSync(tmp, 'w', OWNER_ONLY_FILE);
    restrictMode(tmp);
    try {
      if (lines.length > 0) writeSync(fd, `${lines.join('\n')}\n`);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file is already gone; the original is untouched either way.
      }
      throw err;
    }
    closeSync(fd);
    renameSync(tmp, this.path);
    this.evictedSinceRewrite = 0;
  }

  /** Adopt a loaded record's observation sequence, or stamp one if the file predates them. */
  private stamp(raw: Partial<StoredRecord> & ObservedRecord): StoredRecord {
    const seq =
      typeof raw.seq === 'number' && Number.isInteger(raw.seq) && raw.seq > 0
        ? raw.seq
        : this.nextSeq;
    if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    return { ...raw, seq };
  }

  /** Index a record: dedup-set + in-order insert (append-at-tail is the common case). */
  private index(rec: StoredRecord): void {
    const id = keyOf(rec);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    let list = this.byChat.get(rec.chat_id);
    if (list === undefined) {
      list = [];
    } else {
      // Re-insert so Map iteration stays least-recently-active first (see applyChatCap).
      this.byChat.delete(rec.chat_id);
    }
    this.byChat.set(rec.chat_id, list);
    const last = list.at(-1);
    if (last === undefined || last.seq < rec.seq) {
      list.push(rec);
      return;
    }
    // Rare out-of-order arrival (e.g. store lines interleaved across chats on reload):
    // binary-search the insertion point to keep the array sorted ascending.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((list[mid]?.seq ?? 0) < rec.seq) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, rec);
  }
}
