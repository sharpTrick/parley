import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
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
/**
 * Marks the line carrying {@link ObservedStore.epoch} — the identity of this store FILE, minted
 * once when it is created. Invalid JSON, for the reason {@link EVICTED_ID_LINE} gives.
 */
const EPOCH_LINE = '#epoch ';
/**
 * Marks a line carrying {@link ObservedStore.served} chat ids across a restart. Invalid JSON, for
 * the reason {@link EVICTED_ID_LINE} gives.
 */
const SERVED_ID_LINE = '#served ';
/** Shape of a store-file identity: 16 hex digits, so a cursor carrying one is unmistakable. */
const EPOCH_PATTERN = /^[0-9a-f]{16}$/;
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

/** The string ids a `#`-prefixed bookkeeping line carries, or none when it is garbled. */
function parseIds(line: string, prefix: string): string[] {
  const ids = JSON.parse(line.slice(prefix.length)) as unknown;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

/**
 * A store-file identity read off disk. Anything else is a damaged line: the loader drops it and the
 * store mints a fresh identity, which invalidates the outstanding cursors LOUDLY rather than
 * adopting a name that may not be the one that stamped the sequences in this file.
 */
function requireEpoch(raw: string): string {
  const epoch = raw.trim();
  if (!EPOCH_PATTERN.test(epoch)) throw new Error('ObservedStore: unreadable store identity');
  return epoch;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * are retained. {@link maxChats} bounds the UNSERVED chats — a new one displaces the least
 * recently active unserved chat, and is refused only when every retained chat is served — while a
 * chat this bridge {@link serve}s is retained on top of that cap and never evicted to make room.
 * That protection is persisted with the file, so it holds across a restart for every chat the
 * store still carries records for, not only for the ones the caller re-declares at construction.
 * The on-disk file is compacted once evictions since the last rewrite exceed the retained
 * record count, so the file stays within a constant factor of the in-memory bound instead of
 * growing forever.
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
  /** Identity of the store FILE — see the class doc; every cursor the plugin issues carries it. */
  private readonly epochId: string;
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
  /** Wall-clock of the last diagnostic PER KIND, so one failure can't silence an unrelated one. */
  private readonly lastReportAt = new Map<string, number>();

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
    let loadedEpoch = '';
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        if (line.startsWith(EPOCH_LINE)) loadedEpoch = requireEpoch(line.slice(EPOCH_LINE.length));
        else if (line.startsWith(SERVED_ID_LINE)) {
          for (const id of parseIds(line, SERVED_ID_LINE)) this.served.add(id);
        } else if (line.startsWith(EVICTED_ID_LINE)) {
          this.rememberEvicted(parseIds(line, EVICTED_ID_LINE));
        } else this.index(this.stamp(JSON.parse(line) as Partial<StoredRecord> & ObservedRecord));
      } catch {
        // A torn/garbled line is dropped; every complete line loads.
      }
    }
    this.epochId = loadedEpoch === '' ? randomBytes(8).toString('hex') : loadedEpoch;
    const cappedChats = this.applyChatCap();
    const trimmed = this.applyRetention() || cappedChats;
    // Compact the on-disk file when we dropped a torn fragment or over-retention records; the
    // rewrite yields a clean, newline-terminated, bounded file. Keep this after the torn-tail
    // repair, so that the fragment is never carried into the compacted output.
    const rewritten = torn || trimmed;
    if (rewritten) this.rewrite();
    this.fd = openSync(path, 'a', OWNER_ONLY_FILE);
    restrictMode(path);
    // Append rather than rewrite a file that carries no identity yet: a rewrite is a rename through
    // `<path>.tmp`, so making it the price of opening a store would turn a squatted temp path into a
    // bridge that cannot start at all.
    if (loadedEpoch === '' && !rewritten) this.appendLine(`${EPOCH_LINE}${this.epochId}`);
  }

  /**
   * Mark `chatId` as one this bridge serves: a configured topic resolves to it, so it is
   * admitted past {@link maxChats} and never evicted to make room. Keep this, so that a flood
   * of unconfigured group chats cannot crowd out the operator's own topics.
   *
   * The mark is written to the file as well as held in memory. `chat_map` is re-resolved on every
   * connect, but a topic named only by a seam call is not — so a protection that lived only in
   * memory would lapse at the next restart and the load-time chat cap would evict the operator's
   * own history, which the Bot API can never backfill.
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
      this.report(
        'bookkeeping-line',
        `could not record '${line.split(' ')[0] ?? ''}' in ${this.path} (${describe(err)}) — this ` +
          `run is unaffected and the next restart loses what the line carried`,
      );
    }
  }

  /**
   * Persist + index one record under a fresh observation sequence, holding both retention
   * bounds. Returns the stored record, or `undefined` (writing nothing) when the record is
   * refused: its composite id was already observed — dedup holds when the same message arrives
   * twice, e.g. a `getUpdates` backlog replayed after a restart, whether or not retention has
   * since evicted the record — or every retained chat is served and this one is not, or no append
   * descriptor can be opened ({@link isOpen}). A refusal is silent here and LOUD at the seam: the
   * plugin reports a dropped inbound update and rejects a `post` Telegram has already accepted.
   */
  append(observed: ObservedRecord): StoredRecord | undefined {
    if (this.has(keyOf(observed))) return undefined;
    const fd = this.openFd();
    if (fd === undefined) return undefined;
    if (!this.admit(observed.chat_id)) return undefined;
    const rec: StoredRecord = { ...observed, seq: this.nextSeq++ };
    this.writeLine(fd, JSON.stringify(rec));
    this.index(rec);
    this.applyRetention();
    // Compaction is amortization, not durability: the record is already on disk and indexed here,
    // so keep a failing rewrite off this return path — a throw would tell the caller its message was
    // dropped while the store serves it, and no subscriber or parked long poll would ever see it.
    try {
      this.compactIfDue();
    } catch (err) {
      this.report(
        'compaction',
        `could not compact ${this.path} (${describe(err)}) — every record is retained and the ` +
          `rewrite is retried on a later append`,
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
   * A failure that keeps failing fails on every append. Throttle the diagnostic per `kind` to one
   * line a minute — the same class throttle index.ts uses — so that a squatted temp path or a full
   * disk cannot bury the store's other diagnostics under one line per message.
   */
  private report(kind: string, message: string): void {
    const now = Date.now();
    if (now - (this.lastReportAt.get(kind) ?? 0) < 60_000) return;
    this.lastReportAt.set(kind, now);
    process.stderr.write(`parley-telegram: ${message}\n`);
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
    this.closed = true;
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
   * bridge had already served. The file's {@link epoch} and its {@link served} marks ride out the
   * same way, and for the same reason.
   *
   * Only served chats this store still holds records for are carried: a chat with nothing to lose
   * needs no protection, and that is what keeps the mark list bounded by the retained chat count
   * instead of accumulating every chat ever named across every run.
   */
  private rewrite(): void {
    const lines: string[] = [`${EPOCH_LINE}${this.epochId}`];
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
   * Adopt a loaded record's observation sequence. A line carrying none is garbled — the loader's
   * try/catch drops it. Keep it a drop rather than a fresh stamp, so that a damaged line cannot be
   * handed a sequence an agent's cursor already sits above and become permanently unreachable.
   */
  private stamp(raw: Partial<StoredRecord> & ObservedRecord): StoredRecord {
    const { seq } = raw;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
      throw new Error('record carries no observation sequence');
    }
    if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    return { ...raw, seq };
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
