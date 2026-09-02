import { describe, Diagnostics, fromCaller } from './diagnostics.js';
import {
  EPOCH_LINE,
  EVICTED_ID_LINE,
  keyOf,
  mintEpoch,
  type ObservedRecord,
  parseIds,
  parseRecord,
  requireEpoch,
  requireWatermarks,
  SEQ_LINE,
  SERVED_ID_LINE,
  type StoredRecord,
} from './journal.js';
import { StoreFile } from './store-file.js';

export { keyOf, type ObservedRecord, type StoredRecord } from './journal.js';

/** Default max records retained PER chat when the caller doesn't override it. */
const DEFAULT_MAX_PER_CHAT = 10_000;
/** Default max distinct chats retained when the caller doesn't override it. */
const DEFAULT_MAX_CHATS = 1_000;
/**
 * How many EVICTED composite ids stay refusable after their records are gone — store-wide. What
 * Telegram can redeliver after this bridge has already observed it is one unacknowledged
 * `getUpdates` batch, so keep this sized on THAT window and not on the operator's retention knob:
 * narrowing retention must not narrow the once-only guarantee with it.
 */
const EVICTED_ID_MEMORY = 1_000;
/**
 * How many chats a SEAM CALL has named stay marked as served, newest-marked last — store-wide, and
 * sized on the marks themselves rather than on what the store happens to retain. A chat a seam call
 * named but that has no traffic yet holds no records, and is precisely the case a persisted mark
 * exists for, so a bound derived from the retained records drops the one protection nothing can
 * rebuild.
 *
 * Enforced where the set GROWS and not only where the file is written: the topic a seam call names
 * is chosen by the caller — core's allowlist admits `post_topics` regex patterns, so the topic space
 * is model-chosen rather than operator-sized — and a mark is both a durable append and a permanent
 * exemption from {@link ObservedStore.maxChats}. Bounded only on the way out to disk, a run of
 * reads on fresh topics grows the in-memory exemption set without limit and the cap stops bounding
 * anything. Chats an operator DECLARED ({@link ObservedStore.pinned}) are outside this bound.
 */
export const SERVED_ID_MEMORY = 1_000;

/**
 * The bookkeeping lines that carry MEMORY and no observation sequence. Damage to one costs exactly
 * what it remembered — a served mark, a dedup id — and is reported as that; keep it OFF the
 * identity's re-mint path, so that a garbled duplicate-suppression line cannot refuse every cursor
 * an agent holds, on the one backend whose history no endpoint can re-derive. Keep every other
 * damaged line a re-mint, an unrecognized `#` line included, so that an unreadable watermark still
 * refuses the cursors a re-stamped sequence would collide with.
 */
const MEMORY_ONLY_LINES: readonly string[] = [SERVED_ID_LINE, EVICTED_ID_LINE];

/**
 * Keep an out-of-domain retention bound a hard failure rather than a substituted default, so that
 * an operator who asks for a narrow bound never silently gets the built-in wide one — a deep local
 * archive of every chat the bot is in, which is the opposite of what they configured.
 */
function requirePositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `ObservedStore: ${name} must be a positive integer — got ${fromCaller(String(value))}`,
    );
  }
  return value;
}

/**
 * Append-only JSONL store of every message this bridge has OBSERVED (own sends via the
 * `sendMessage` response + foreign messages via `getUpdates`). The Telegram Bot API exposes
 * NO history endpoint, so this store IS the durable, replayable history the seam contract
 * asks for (DESIGN §6) — limited to what the bridge has seen (see the caveat in index.ts).
 *
 * Two bounds hold at ALL times — on load AND on every {@link append} — because both axes are
 * attacker-influenced: anyone who can post in a chat the bot is in drives records ({@link
 * applyRetention}), and anyone who can add the bot to a group drives chats ({@link applyChatCap}).
 * A chat this bridge {@link serve}s is exempt from the second, across restarts — and the marks are
 * themselves bounded ({@link SERVED_ID_MEMORY}), because the topic a seam call names is chosen by
 * the caller and an unbounded exemption is the cap's own defeat.
 *
 * ONE bridge process per store file AND per bot token; the first half is ENFORCED by the
 * {@link StoreFile} claim, and see "Multiple concurrent sessions" in README.md for the second.
 */
export class ObservedStore {
  /** chat id → records ascending by `seq`; key order is least-recently-active first. */
  private readonly byChat = new Map<string, StoredRecord[]>();
  /** The dedup set — the composite ids of the currently-retained records (bounded). */
  private readonly seen = new Set<string>();
  /** Composite ids of evicted records, newest last — dedup memory past retention (bounded). */
  private readonly evicted = new Set<string>();
  /** Chats an operator declared through `chat_map` — never evicted, never refused, never trimmed. */
  private readonly pinned = new Set<string>();
  /** Chats a SEAM CALL named, newest last — served like {@link pinned} but bounded (caller-driven). */
  private readonly served = new Set<string>();
  /** Identity of the store FILE ({@link epoch}) — every cursor the plugin issues carries it. */
  private readonly epochId: string;
  private readonly file: StoreFile;
  /** Newest-N-per-chat retention bound. */
  private readonly maxPerChat: number;
  /** Max UNSERVED chats retained — the bot's chat membership is not ours to control. */
  private readonly maxChats: number;
  /** Next observation sequence to stamp — store-wide, so an evicted chat can never reuse one. */
  private nextSeq = 1;
  /** Records evicted since the last on-disk compaction — drives the amortized rewrite. */
  private evictedSinceRewrite = 0;
  /**
   * Served marks appended since the last on-disk compaction. Counted INTO the rewrite threshold, so
   * that a store whose records never churn still reclaims them: a seam call on a fresh topic
   * appends a line, and a rewrite armed only by record eviction never runs on a store that is being
   * read rather than written.
   */
  private markedSinceRewrite = 0;
  private readonly diagnostics = new Diagnostics();

  constructor(
    path: string,
    maxPerChat = DEFAULT_MAX_PER_CHAT,
    maxChats = DEFAULT_MAX_CHATS,
    served: Iterable<string> = [],
  ) {
    this.maxPerChat = requirePositiveInt('maxPerChat', maxPerChat);
    this.maxChats = requirePositiveInt('maxChats', maxChats);
    for (const chatId of served) this.pinned.add(chatId);
    this.file = new StoreFile(path);
    try {
      this.epochId = this.load();
    } catch (err) {
      this.file.close();
      throw err;
    }
  }

  /**
   * Read the file into the index and return the identity to serve under. Mint a FRESH one —
   * invalidating every outstanding cursor — whenever the file did not load whole (a dropped line, a
   * record missing below the `intact` watermark it carries, or a sequence below the high-water
   * recorded beside it), so that a held cursor is never answered out of a sequence space re-minted
   * underneath it.
   */
  private load(): string {
    const marked = this.file.readMark();
    let raw = this.file.read();
    // Drop a crash-torn tail fragment (a final line with no trailing '\n') BEFORE any append,
    // so that the next record can't glue onto it. The repaired file is rewritten below.
    let torn = false;
    if (raw !== '' && !raw.endsWith('\n')) {
      const lastNl = raw.lastIndexOf('\n');
      raw = lastNl >= 0 ? raw.slice(0, lastNl + 1) : '';
      torn = true;
    }
    let loadedEpoch = '';
    let issued = 0;
    let intact = 0;
    let onDisk = 0;
    let dropped = torn;
    let forgot = false;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        if (line.startsWith(EPOCH_LINE)) loadedEpoch = requireEpoch(line.slice(EPOCH_LINE.length));
        else if (line.startsWith(SEQ_LINE)) {
          const [stamped, present] = requireWatermarks(line.slice(SEQ_LINE.length));
          issued = Math.max(issued, stamped);
          intact = Math.max(intact, present);
        } else if (line.startsWith(SERVED_ID_LINE)) {
          this.rememberServed(parseIds(line, SERVED_ID_LINE));
        } else if (line.startsWith(EVICTED_ID_LINE)) {
          this.rememberEvicted(parseIds(line, EVICTED_ID_LINE));
        } else {
          const rec = parseRecord(JSON.parse(line) as Partial<StoredRecord> & ObservedRecord);
          if (rec.seq >= this.nextSeq) this.nextSeq = rec.seq + 1;
          onDisk = Math.max(onDisk, rec.seq);
          this.index(rec);
        }
      } catch {
        if (MEMORY_ONLY_LINES.some((prefix) => line.startsWith(prefix))) forgot = true;
        else dropped = true;
      }
    }
    if (issued >= this.nextSeq) this.nextSeq = issued + 1;
    const lost = dropped || intact > onDisk || marked > issued;
    const epochId = loadedEpoch === '' || lost ? mintEpoch() : loadedEpoch;
    const cappedChats = this.applyChatCap();
    const trimmed = this.applyRetention() || cappedChats;
    // Compact the on-disk file when we dropped a torn fragment or over-retention records, or when
    // the identity was replaced; the rewrite yields a clean, newline-terminated, bounded file whose
    // watermarks match what it holds. Keep this after the torn-tail repair, so that the fragment is
    // never carried into the compacted output — and keep the replaced identity ON it, so that a
    // damaged file does not re-mint one on every later load.
    const rewritten = torn || trimmed || lost || forgot;
    if (rewritten) {
      this.file.replace(this.journalText(epochId));
      this.evictedSinceRewrite = 0;
      this.markedSinceRewrite = 0;
    }
    this.file.open();
    // Append rather than rewrite a file that carries no identity yet: a rewrite is a rename through
    // `<path>.tmp`, so making it the price of opening a store would turn a squatted temp path into a
    // bridge that cannot start at all.
    if (epochId !== loadedEpoch && !rewritten) this.file.note(`${EPOCH_LINE}${epochId}`);
    // Re-baseline the mark onto what survived, so that a file this load already re-identified does
    // not read as rolled back on every later one.
    this.file.mark(this.highWater());
    if (lost) {
      const cause =
        marked > issued
          ? `the high-water recorded beside it is ${marked} and the sequences it states reach ${issued}`
          : intact > onDisk
            ? `it recorded observing through sequence ${intact} and its records reach ${onDisk}`
            : `a damaged or torn line could not be loaded`;
      this.diagnostics.report(
        `${this.file.path} did not load whole — ${cause}. Minted a fresh store identity ` +
          `${epochId}, so every cursor the previous one issued is refused instead of being answered ` +
          `out of a sequence this store would otherwise stamp twice.`,
      );
    }
    if (forgot) {
      this.diagnostics.report(
        `${this.file.path} carried a bookkeeping line that could not be read — the served-chat ` +
          `marks and the duplicate-suppression memory it held are gone, so a chat named only by an ` +
          `earlier seam call can be evicted by the chat cap, and a message redelivered from before ` +
          `this load can be served a second time. Every cursor this store issued still answers: ` +
          `the line carried no observation sequence.`,
      );
    }
    return epochId;
  }

  /**
   * Mark `chatId` as one this bridge serves: it is then admitted past {@link maxChats} and never
   * evicted to make room, so a flood of unconfigured group chats cannot crowd out the operator's
   * own topics. Keep the mark in the FILE and not only in memory: `chat_map` is re-resolved on
   * every connect but a topic named only by a seam call is not, so a memory-only protection would
   * lapse at the next restart and the chat cap would evict history nothing can backfill.
   */
  serve(chatId: string): void {
    if (this.isServed(chatId)) return;
    this.rememberServed([chatId]);
    this.file.note(`${SERVED_ID_LINE}${JSON.stringify([chatId])}`);
    this.markedSinceRewrite += 1;
    // A mark is not a record: the seam call that triggered one has nothing to retry and its own
    // result does not depend on the rewrite, so a failing compaction is reported, never thrown.
    try {
      this.compactIfDue();
    } catch (err) {
      this.diagnostics.report(
        `could not compact ${this.file.path} (${describe(err)}) — the served marks are all ` +
          `retained and the rewrite is retried on a later seam call`,
        'compaction',
      );
    }
  }

  /**
   * A random identity minted when the file is created. The observation sequence is per-FILE and
   * restarts at 1, so the plugin qualifies every cursor with this, so that a cursor minted by a
   * store file this one did not inherit is refused however far this store's own sequence has
   * since climbed — rather than answered out of a sequence space re-minted underneath it.
   */
  epoch(): string {
    return this.epochId;
  }

  /**
   * Persist + index one record under a fresh observation sequence, holding both retention bounds.
   * Returns `undefined` (writing nothing) when the record is refused: already observed (whether or
   * not retention has since evicted it), or every retained chat is served and this one is not, or
   * the file cannot be written ({@link isOpen}). A refusal is silent here and LOUD at the seam: the
   * plugin reports a dropped inbound update and rejects a `post` Telegram has already accepted.
   */
  append(observed: ObservedRecord): StoredRecord | undefined {
    if (this.has(keyOf(observed))) return undefined;
    // Ask for the descriptor before admitting, so that an unwritable store refuses the record
    // without having evicted a chat to make room for it.
    if (!this.file.writable()) return undefined;
    if (!this.admit(observed.chat_id)) return undefined;
    const rec: StoredRecord = { ...observed, seq: this.nextSeq++ };
    // Keep the watermark AHEAD of the record and in the SAME write: a tail cut anywhere between the
    // two then still states the sequence the missing record carried, which is what turns its loss
    // into a refused identity. Written after the record instead, it goes with every truncation the
    // record goes with, and the store re-mints the sequences it lost along with them.
    this.file.write(`${SEQ_LINE}${rec.seq} ${rec.seq}\n${JSON.stringify(rec)}`);
    this.file.mark(rec.seq);
    this.index(rec);
    this.applyRetention();
    // Compaction is amortization, not durability: the record is already on disk and indexed here,
    // so keep a failing rewrite off this return path — a throw would tell the caller its message was
    // dropped while the store serves it, and no subscriber or parked long poll would ever see it.
    try {
      this.compactIfDue();
    } catch (err) {
      this.diagnostics.report(
        `could not compact ${this.file.path} (${describe(err)}) — every record is retained and the ` +
          `rewrite is retried on a later append`,
        'compaction',
      );
    }
    return rec;
  }

  /**
   * True iff this composite id has been observed and is still remembered — a retained record, or
   * one evicted within the last {@link EVICTED_ID_MEMORY} evictions. The once-only question, so it
   * is what {@link append} refuses on; {@link size} is the retained count, which is smaller.
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
    return this.entries(chatId).at(-1)?.seq ?? 0;
  }

  /**
   * The highest observation sequence this store has ever stamped or loaded (0 when none) — the
   * ceiling on every cursor it can have issued. A `since` above it was minted by a store file
   * this one did not inherit, so the messages it refers to are unreachable from here.
   */
  highWater(): number {
    return this.nextSeq - 1;
  }

  /** True while the store file can still be appended to. */
  isOpen(): boolean {
    return this.file.isOpen();
  }

  /** Total records currently RETAINED across all chats — see {@link has} for what is refusable. */
  size(): number {
    return this.seen.size;
  }

  /** Drop the in-memory index and release the file. Appends are write-through — nothing to flush. */
  close(): void {
    this.byChat.clear();
    this.seen.clear();
    this.evicted.clear();
    this.served.clear();
    this.pinned.clear();
    this.file.close();
  }

  /**
   * Make room for a record from `chatId` under the chat-count bound. A served chat and
   * one already held are always admitted; otherwise the least recently active UNSERVED chat is
   * evicted. False only when every retained chat is served.
   */
  private admit(chatId: string): boolean {
    if (this.byChat.has(chatId) || this.isServed(chatId)) return true;
    if (this.byChat.size < this.maxChats) return true;
    return this.evictLeastRecentUnserved();
  }

  /** Drop the least recently active unserved chat entirely. False when there is none. */
  private evictLeastRecentUnserved(): boolean {
    for (const chatId of this.byChat.keys()) {
      if (this.isServed(chatId)) continue;
      this.evict(this.byChat.get(chatId) ?? []);
      this.byChat.delete(chatId);
      return true;
    }
    return false;
  }

  /**
   * Hold the per-chat bound: newest {@link maxPerChat} records per chat, rebuilding the dedup
   * `seen` set from the survivors so neither map grows without bound. True iff anything was evicted.
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
   * active UNSERVED chats. A served chat is kept even past the cap: evicting the operator's own
   * chat destroys history nothing can ever backfill.
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

  /** True while `chatId` is exempt from the chat cap — declared by the operator, or seam-named. */
  private isServed(chatId: string): boolean {
    return this.pinned.has(chatId) || this.served.has(chatId);
  }

  /**
   * Hold the newest {@link SERVED_ID_MEMORY} seam-named marks, newest last (Set iterates in order).
   * A chat the operator declared is already exempt and is left out, so that a run of seam calls on
   * fresh topics can never push the operator's own chats out of the protection they configured.
   */
  private rememberServed(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.pinned.has(id)) continue;
      this.served.delete(id);
      this.served.add(id);
    }
    for (const oldest of this.served) {
      if (this.served.size <= SERVED_ID_MEMORY) break;
      this.served.delete(oldest);
    }
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

  /**
   * Compact once the dead lines on disk have grown to the live line count: the file then stays
   * within ~2x the in-memory bound while rewrites stay amortized O(1) per line appended.
   *
   * Each bound arms its own rewrite against the memory bound it is held to. Marks armed by the
   * RECORD budget alone leave a store that is only ever read — no record churn, so nothing to
   * evict — appending marks that nothing ever reclaims, for as long as a caller keeps naming fresh
   * topics.
   */
  private compactIfDue(): void {
    if (!this.file.isOpen()) return;
    const live = this.size();
    const due =
      this.evictedSinceRewrite >= Math.max(this.maxPerChat, live) ||
      this.markedSinceRewrite >= Math.max(SERVED_ID_MEMORY, live);
    if (!due) return;
    this.file.compact(this.journalText());
    this.evictedSinceRewrite = 0;
    this.markedSinceRewrite = 0;
  }

  /**
   * The whole file as it should read for the records currently retained — what both a load-time
   * repair and a compaction publish.
   *
   * A compaction is where the evicted records' LINES leave the file, so it carries the eviction
   * memory out with them ({@link EVICTED_ID_LINE}) — otherwise dedup would reach back only as far
   * as the file, and a restart right after a compaction would re-admit a redelivered message the
   * bridge had already served. The {@link epoch}, the watermarks and the {@link served} marks ride
   * out the same way. The two watermarks part company here and only here: eviction is how a record
   * legitimately leaves the file, so `intact` drops to what is retained while `issued` keeps every
   * sequence already handed out.
   *
   * The mark list is bounded by {@link SERVED_ID_MEMORY} and NOT by the records retained: a chat a
   * seam call named before any traffic reached it holds none, and that is the one chat whose mark
   * nothing in the next process can rebuild — `chat_map` is re-declared on every connect, a
   * seam-named topic is not. The declared chats ride out first, so that a file reloaded by a
   * process which no longer declares them is the one that ages them out.
   */
  private journalText(epochId: string = this.epochId): string {
    const lines: string[] = [
      `${EPOCH_LINE}${epochId}`,
      `${SEQ_LINE}${this.highWater()} ${this.retainedHighWater()}`,
    ];
    const served = [...this.pinned, ...this.served];
    if (served.length > 0) lines.push(`${SERVED_ID_LINE}${JSON.stringify(served)}`);
    if (this.evicted.size > 0) {
      lines.push(`${EVICTED_ID_LINE}${JSON.stringify([...this.evicted])}`);
    }
    for (const list of this.byChat.values()) {
      for (const rec of list) lines.push(JSON.stringify(rec));
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * The `intact` watermark {@link journalText} states: below {@link highWater} exactly when
   * eviction has taken the newest record of the busiest chat — a record leaving on purpose, not
   * one going missing.
   */
  private retainedHighWater(): number {
    let max = 0;
    for (const list of this.byChat.values()) max = Math.max(max, list.at(-1)?.seq ?? 0);
    return max;
  }

  /**
   * Index a record: dedup-set + append at the chat's tail. Sequences are stamped strictly
   * increasing and the file is written per chat, so a chat's records only ever arrive ascending.
   */
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
    list.push(rec);
  }
}
