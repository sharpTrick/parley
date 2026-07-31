import {
  appendFileSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { describe, Diagnostics } from './diagnostics.js';
import {
  EPOCH_LINE,
  EVICTED_ID_LINE,
  mintEpoch,
  parseIds,
  parseRecord,
  requireEpoch,
  requireWatermarks,
  SEQ_LINE,
  SERVED_ID_LINE,
} from './journal.js';
import { OWNER_ONLY_DIR, OWNER_ONLY_FILE, restrictMode, StoreLock } from './store-file.js';

/**
 * One observed Telegram message, as persisted to the JSONL store — everything needed to
 * reconstruct a seam `Message` later.
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
  /** Sender handle (`from.username ?? String(from.id)`; see wire.ts). */
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
 * has already observed it is one unacknowledged `getUpdates` batch, so keep this memory sized on
 * THAT window rather than on the operator's retention knob: narrowing retention must not narrow
 * the once-only guarantee with it.
 */
const EVICTED_ID_MEMORY = 1_000;

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
 * are retained. {@link maxChats} bounds the UNSERVED chats — a new one displaces the least
 * recently active unserved chat, and is refused only when every retained chat is served — while a
 * chat this bridge {@link serve}s is retained on top of that cap and never evicted to make room.
 * That protection is persisted with the file, so it holds across a restart for every chat the
 * store still carries records for, not only for the ones the caller re-declares at construction.
 *
 * The file carries an {@link epoch}: a random identity minted when it is created, which the plugin
 * qualifies every cursor with. The observation sequence is per-FILE and restarts at 1, so without
 * an identity a cursor minted by a store file that has since been lost becomes indistinguishable
 * from one this store issued the moment the new sequence climbs past it — and catch-up answers a
 * permanently short page instead of failing.
 *
 * Dedup outlives retention: an evicted record's composite id stays refusable for a further
 * {@link EVICTED_ID_MEMORY} evictions. Keep the two horizons separate, so that a retention bound
 * narrower than Telegram's ~24h `getUpdates` replay horizon cannot re-admit a message this bridge
 * already served — which would hand the same `backendMsgId` out twice at two different cursors,
 * the second above a cursor the agent already holds.
 *
 * Everything it creates is owner-only (see store-file.ts): this file is the full plaintext of
 * every message the bridge has observed, in every chat the bot is in. ONE bridge process per store
 * file AND per bot token, and the first half is ENFORCED by {@link StoreLock} — two processes
 * interleaving appends mint colliding cursors for different messages and each one's compaction
 * renames its own view over the other's history. See the "Multiple concurrent sessions" section
 * in README.md.
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
  /** Identity of the store FILE — see the class doc; every cursor the plugin issues carries it. */
  private readonly epochId: string;
  private readonly lock: StoreLock;
  /** Newest-N-per-chat retention bound. */
  private readonly maxPerChat: number;
  /** Max UNSERVED chats retained — the bot's chat membership is not ours to control. */
  private readonly maxChats: number;
  /** Next observation sequence to stamp — store-wide, so an evicted chat can never reuse one. */
  private nextSeq = 1;
  /** Records evicted since the last on-disk compaction — drives the amortized rewrite. */
  private evictedSinceRewrite = 0;
  /** Persistent append descriptor — one open fd for the process, not open/close per append. */
  private fd: number | undefined;
  /** Set by {@link close} — the difference between "released on purpose" and "lost the fd". */
  private closed = false;
  /**
   * A write that threw may have left bytes with no terminating newline (a short write on ENOSPC),
   * and the constructor's torn-tail repair only runs at LOAD. Keep the flag, so that the next line
   * opens a fresh one instead of gluing onto the fragment — which would lose a record `append` had
   * already returned as durable, alongside the fragment.
   */
  private tornTail = false;
  private readonly diagnostics = new Diagnostics();

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
    this.lock = new StoreLock(path);
    this.lock.claim();
    try {
      this.epochId = this.load();
    } catch (err) {
      this.lock.release();
      throw err;
    }
  }

  /**
   * Read the file into the index and return the identity to serve under. A FRESH identity is minted
   * — invalidating every outstanding cursor — whenever the file did not load whole: any dropped
   * line, or a record missing below the `intact` watermark the file itself carries. Both mean a
   * sequence this store stamped is gone while its identity survived, and serving on would answer a
   * held cursor out of a sequence space re-minted underneath it.
   */
  private load(): string {
    let raw = '';
    try {
      raw = readFileSync(this.path, 'utf8');
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
    let loadedEpoch = '';
    let issued = 0;
    let intact = 0;
    let onDisk = 0;
    let dropped = torn;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        if (line.startsWith(EPOCH_LINE)) loadedEpoch = requireEpoch(line.slice(EPOCH_LINE.length));
        else if (line.startsWith(SEQ_LINE)) {
          const [stamped, present] = requireWatermarks(line.slice(SEQ_LINE.length));
          issued = Math.max(issued, stamped);
          intact = Math.max(intact, present);
        } else if (line.startsWith(SERVED_ID_LINE)) {
          for (const id of parseIds(line, SERVED_ID_LINE)) this.served.add(id);
        } else if (line.startsWith(EVICTED_ID_LINE)) {
          this.rememberEvicted(parseIds(line, EVICTED_ID_LINE));
        } else {
          const rec = parseRecord(JSON.parse(line) as Partial<StoredRecord> & ObservedRecord);
          if (rec.seq >= this.nextSeq) this.nextSeq = rec.seq + 1;
          onDisk = Math.max(onDisk, rec.seq);
          this.index(rec);
        }
      } catch {
        dropped = true;
      }
    }
    if (issued >= this.nextSeq) this.nextSeq = issued + 1;
    const lost = dropped || intact > onDisk;
    const epochId = loadedEpoch === '' || lost ? mintEpoch() : loadedEpoch;
    const cappedChats = this.applyChatCap();
    const trimmed = this.applyRetention() || cappedChats;
    // Compact the on-disk file when we dropped a torn fragment or over-retention records, or when
    // the identity was replaced; the rewrite yields a clean, newline-terminated, bounded file whose
    // watermarks match what it holds. Keep this after the torn-tail repair, so that the fragment is
    // never carried into the compacted output — and keep the replaced identity ON it, so that a
    // damaged file does not re-mint one on every later load.
    const rewritten = torn || trimmed || lost;
    if (rewritten) this.rewrite(epochId);
    this.fd = openSync(this.path, 'a', OWNER_ONLY_FILE);
    restrictMode(this.path);
    // Append rather than rewrite a file that carries no identity yet: a rewrite is a rename through
    // `<path>.tmp`, so making it the price of opening a store would turn a squatted temp path into a
    // bridge that cannot start at all.
    if (epochId !== loadedEpoch && !rewritten) this.appendLine(`${EPOCH_LINE}${epochId}`);
    if (lost) {
      const cause =
        intact > onDisk
          ? `it recorded observing through sequence ${intact} and its records reach ${onDisk}`
          : `a damaged or torn line could not be loaded`;
      this.diagnostics.report(
        `${this.path} did not load whole — ${cause}. Minted a fresh store identity ` +
          `${epochId}, so every cursor the previous one issued is refused instead of being answered ` +
          `out of a sequence this store would otherwise stamp twice.`,
      );
    }
    return epochId;
  }

  /**
   * Mark `chatId` as one this bridge serves: a configured topic resolves to it, so it is
   * admitted past {@link maxChats} and never evicted to make room — a flood of unconfigured group
   * chats cannot crowd out the operator's own topics. The mark is written to the file as well as
   * held in memory: `chat_map` is re-resolved on every connect but a topic named only by a seam
   * call is not, so a memory-only protection would lapse at the next restart and the load-time
   * chat cap would evict history the Bot API can never backfill.
   */
  serve(chatId: string): void {
    if (this.served.has(chatId)) return;
    this.served.add(chatId);
    this.appendLine(`${SERVED_ID_LINE}${JSON.stringify([chatId])}`);
  }

  /**
   * Identity of the store FILE (see the class doc). The plugin qualifies every cursor with it, so
   * that a cursor minted by a store file this one did not inherit is refused however far this
   * store's own sequence has since climbed.
   */
  epoch(): string {
    return this.epochId;
  }

  /**
   * Write one bookkeeping line, reporting rather than throwing when it cannot be written. These
   * lines carry protection and identity, not records: the caller of a seam method that triggers one
   * has nothing to retry, and failing its call would report a message as lost that is not.
   */
  private appendLine(line: string): void {
    const fd = this.openFd();
    if (fd === undefined) return;
    try {
      this.writeLine(fd, line);
    } catch (err) {
      this.diagnostics.report(
        `could not record '${line.split(' ')[0] ?? ''}' in ${this.path} (${describe(err)}) — this ` +
          `run is unaffected and the next restart loses what the line carried`,
        'bookkeeping-line',
      );
    }
  }

  /**
   * Persist + index one record under a fresh observation sequence, holding both retention
   * bounds. Returns the stored record, or `undefined` (writing nothing) when the record is
   * refused: its composite id was already observed (whether or not retention has since evicted the
   * record), or every retained chat is served and this one is not, or no append descriptor can be
   * opened ({@link isOpen}). A refusal is silent here and LOUD at the seam: the plugin reports a
   * dropped inbound update and rejects a `post` Telegram has already accepted.
   */
  append(observed: ObservedRecord): StoredRecord | undefined {
    if (this.has(keyOf(observed))) return undefined;
    const fd = this.openFd();
    if (fd === undefined) return undefined;
    if (!this.admit(observed.chat_id)) return undefined;
    const rec: StoredRecord = { ...observed, seq: this.nextSeq++ };
    // Keep the watermark AHEAD of the record and in the SAME write: a tail cut anywhere between the
    // two then still states the sequence the missing record carried, which is what turns its loss
    // into a refused identity. Written after the record instead, it goes with every truncation the
    // record goes with, and the store re-mints the sequences it lost along with them.
    this.writeLine(fd, `${SEQ_LINE}${rec.seq} ${rec.seq}\n${JSON.stringify(rec)}`);
    this.index(rec);
    this.applyRetention();
    // Compaction is amortization, not durability: the record is already on disk and indexed here,
    // so keep a failing rewrite off this return path — a throw would tell the caller its message was
    // dropped while the store serves it, and no subscriber or parked long poll would ever see it.
    try {
      this.compactIfDue();
    } catch (err) {
      this.diagnostics.report(
        `could not compact ${this.path} (${describe(err)}) — every record is retained and the ` +
          `rewrite is retried on a later append`,
        'compaction',
      );
    }
    return rec;
  }

  /**
   * Write one newline-terminated line, opening a fresh one first when {@link tornTail} says the
   * previous write may have stopped mid-line. The fragment then loads as its own garbled line and
   * is dropped, instead of swallowing the record written after it.
   */
  private writeLine(fd: number, line: string): void {
    try {
      appendFileSync(fd, this.tornTail ? `\n${line}\n` : `${line}\n`);
      this.tornTail = false;
    } catch (err) {
      this.tornTail = true;
      throw err;
    }
  }

  /**
   * Hold the append descriptor, reopening one a failed compaction could not restore. Keep the
   * retry, so that one transient EMFILE/ENOSPC inside a rewrite does not turn the store into a
   * permanent black hole that refuses every later record. A store {@link close}d on purpose stays
   * closed.
   */
  private openFd(): number | undefined {
    if (this.fd !== undefined) return this.fd;
    if (this.closed) return undefined;
    try {
      this.fd = openSync(this.path, 'a', OWNER_ONLY_FILE);
    } catch {
      return undefined;
    }
    return this.fd;
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
   * Max observation sequence across every RETAINED record (0 when none) — the `intact` watermark
   * {@link rewrite} persists. Below {@link highWater} exactly when eviction has taken the newest
   * record of the busiest chat: a record leaving on purpose, not one going missing.
   */
  private retainedHighWater(): number {
    let max = 0;
    for (const list of this.byChat.values()) max = Math.max(max, list.at(-1)?.seq ?? 0);
    return max;
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

  /**
   * Drop the in-memory index, release the append fd and give up this process's claim on the file.
   * Appends are write-through — nothing to flush.
   */
  close(): void {
    this.byChat.clear();
    this.seen.clear();
    this.evicted.clear();
    this.served.clear();
    this.closed = true;
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    this.lock.release();
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

  /**
   * Compact once the dead lines on disk have grown to the live record count: the file then stays
   * within ~2x the in-memory bound while rewrites stay amortized O(1) per append.
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
   * bridge had already served. The {@link epoch}, the watermarks and the {@link served} marks ride
   * out the same way. The two watermarks part company here and only here: eviction is how a record
   * legitimately leaves the file, so `intact` drops to what is retained while `issued` keeps every
   * sequence already handed out.
   *
   * Only served chats this store still holds records for are carried, which keeps the mark list
   * bounded by the retained chat count instead of accumulating every chat ever named.
   */
  private rewrite(epochId: string = this.epochId): void {
    const lines: string[] = [
      `${EPOCH_LINE}${epochId}`,
      `${SEQ_LINE}${this.highWater()} ${this.retainedHighWater()}`,
    ];
    const served = [...this.served].filter((id) => this.byChat.has(id));
    if (served.length > 0) lines.push(`${SERVED_ID_LINE}${JSON.stringify(served)}`);
    if (this.evicted.size > 0) {
      lines.push(`${EVICTED_ID_LINE}${JSON.stringify([...this.evicted])}`);
    }
    for (const list of this.byChat.values()) {
      for (const rec of list) lines.push(JSON.stringify(rec));
    }
    const tmp = `${this.path}.tmp`;
    const fd = this.openTemp(tmp);
    try {
      writeSync(fd, `${lines.join('\n')}\n`);
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
    this.tornTail = false;
  }

  /**
   * The compaction target, CREATED by this call. `<path>.tmp` is predictable and the rename
   * publishes whatever it names over the store, so open it exclusively (`wx` — `O_EXCL|O_CREAT`
   * refuses an existing file and never follows a symlink) and refuse anything already there that is
   * not a regular file. Otherwise anyone who can create a file in the store's directory redirects
   * the full plaintext of every observed message, and gets its mode changed for them.
   */
  private openTemp(tmp: string): number {
    try {
      return openSync(tmp, 'wx', OWNER_ONLY_FILE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (!lstatSync(tmp).isFile()) {
      throw new Error(
        `ObservedStore: refusing to compact through '${tmp}' — it exists and is not a regular ` +
          `file, so the rename would publish it as the observed-message store. Remove it.`,
      );
    }
    unlinkSync(tmp);
    return openSync(tmp, 'wx', OWNER_ONLY_FILE);
  }

  /**
   * Index a record: dedup-set + append at the chat's tail. Sequences are stamped strictly
   * increasing and the file is written in per-chat order, so a chat's records only ever arrive
   * ascending.
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
