import {
  asBackendMsgId,
  asCursor,
  asTopic,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { openDriver, type SqlDriver, type SqlStatement } from './driver.js';
import { type MessageRow, SCHEMA } from './schema.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface SqliteBackendConfig {
  /**
   * Path to the SQLite file. Default `parley.db` in the cwd. `:memory:` is single-process only
   * AND a brand-new database every process: its `AUTOINCREMENT` rowids restart at 1, so a cursor
   * persisted by core from a previous run no longer lines up with this DB's ids. The same is true
   * of a recreated/wiped file. Because core's read-state outlives the DB, **clear any persisted
   * read-state whenever the DB is reset** — otherwise a stale high cursor would reference ids this
   * DB never minted. `fetchRecent` guards this case (a `since` past the DB's high-water mark falls
   * back to the recent window instead of silently skipping every post after the reset), but
   * clearing stale read-state on reset is still the correct operational step.
   */
  db_path?: string;
  /** Poll interval for the live `subscribe` loop. Latency knob only — no correctness impact (§9). */
  poll_interval_ms?: number;
  /**
   * Optional retention window in days: rows older than this are pruned on a background timer.
   * Omit for the default — keep every message forever. Safe to enable at any time: `id` is
   * `AUTOINCREMENT` and never reused, so a cursor/backendMsgId minted before a prune stays valid
   * (a stale reader just gets fewer rows back, never a wrong or duplicate one).
   */
  retention_days?: number;
}

/** How many new rows a single poll tick drains at most before yielding. */
const POLL_BATCH = 512;
/** Pruning cadence when `retention_days` is set — a cost knob only, like the poll interval. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The SQLite backend (DESIGN §9). Zero-infra, **polling-only** — no socket, no notify bus,
 * no broker. The cursor (rowid) makes polling fully correct, so the poll interval is a pure
 * latency/cost knob. WAL + busy_timeout (in {@link openDriver}) make concurrent multi-process
 * posts safe (§9/§10).
 */
export class SqlitePlugin implements BackendPlugin {
  private driver?: SqlDriver;
  private pollIntervalMs = 1000;
  private retentionDays?: number;
  private stopped = false;
  private readonly cancellers: Array<() => void> = [];
  private pruneTimer?: ReturnType<typeof setInterval>;

  // Prepared statements (built once at connect).
  private insertStmt?: SqlStatement;
  private selectAfterStmt?: SqlStatement;
  private selectRecentStmt?: SqlStatement;
  private maxIdStmt?: SqlStatement;
  private pruneStmt?: SqlStatement;
  private seqStmt?: SqlStatement;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as SqliteBackendConfig;
    const dbPath = cfg.db_path ?? 'parley.db';
    this.pollIntervalMs = cfg.poll_interval_ms ?? 1000;
    this.retentionDays = cfg.retention_days;
    this.stopped = false;

    const driver = openDriver(dbPath, {});
    driver.exec(SCHEMA);
    this.driver = driver;

    this.insertStmt = driver.prepare(
      'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectAfterStmt = driver.prepare(
      'SELECT id, topic, sender, content, ts, in_reply_to FROM messages WHERE topic = ? AND id > ? ORDER BY id ASC LIMIT ?',
    );
    this.selectRecentStmt = driver.prepare(
      'SELECT id, topic, sender, content, ts, in_reply_to FROM messages WHERE topic = ? ORDER BY id DESC LIMIT ?',
    );
    this.maxIdStmt = driver.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM messages WHERE topic = ?');
    this.pruneStmt = driver.prepare('DELETE FROM messages WHERE ts < ?');
    // High-water mark of the AUTOINCREMENT sequence — the largest rowid this DB lifetime has
    // ever minted (absent until the first insert). Lets `fetchRecent` detect a stale/foreign
    // `since` cursor minted against a previous DB (a recreated file, or `:memory:` — a fresh DB
    // every process) instead of silently skipping every post after the reset (BUG-23).
    this.seqStmt = driver.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'");

    if (this.retentionDays !== undefined) {
      this.prune();
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    for (const cancel of this.cancellers) cancel();
    this.cancellers.length = 0;
    this.driver?.close();
    this.driver = undefined;
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const stmt = this.require(this.insertStmt);
    const ts = new Date().toISOString();
    const info = stmt.run(topic, identity, content, ts, opts?.inReplyTo ?? null);
    // No Number() round-trip: String() handles number and bigint alike, so a 64-bit rowid can
    // never lose precision on the way to the dedup key (BUG-40).
    return asBackendMsgId(String(info.lastInsertRowid));
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const limit = args.limit ?? 100;
    // Validate the opaque cursor at the seam (BUG-22). A cursor this backend mints is the decimal
    // rowid (`^\d+$`); anything else — a foreign/Matrix-style cursor (e.g. `'s123_456'`), or a
    // value that slipped in via mis-namespaced read-state — would otherwise become Number(x) ===
    // NaN, bind as SQL NULL, match zero rows with NO error, and re-echo itself as `nextCursor`,
    // silently wedging this topic's catch-up forever. `\d+` also rejects '' (Number('') === 0
    // would replay the whole topic). Throw loudly so core/the agent can drop the bad cursor and
    // refetch the default window.
    if (args.since !== undefined && !/^\d+$/.test(args.since)) {
      throw new Error(
        `parley-sqlite: malformed cursor '${args.since}' for topic ${args.topic} — ` +
          `expected a numeric rowid cursor minted by this backend`,
      );
    }
    // A well-formed but STALE cursor — one minted against a previous DB lifetime, so it points
    // past this DB's AUTOINCREMENT high-water mark — is treated exactly like `since === undefined`
    // for both the query AND the returned cursor (BUG-23): fall back to the default recent window
    // so on-start catch-up self-heals after a reset, instead of binding `id > <stale>` → [] and
    // silently dropping every post made after the reset.
    const since =
      args.since !== undefined && this.isStaleCursor(args.since) ? undefined : args.since;
    let rows: MessageRow[];
    if (since === undefined) {
      // Default window: the most recent `limit` messages, returned ascending by cursor.
      rows = this.require(this.selectRecentStmt).all(args.topic, limit) as MessageRow[];
      rows.reverse();
    } else {
      // Exclusive: strictly after `since`, ascending. `since` is validated `^\d+$`, so bind it as
      // a BigInt — no Number() round-trip / >2^53 precision loss (BUG-40). The `id` column's
      // INTEGER affinity drives the `id > ?` comparison.
      rows = this.require(this.selectAfterStmt).all(
        args.topic,
        BigInt(since),
        limit,
      ) as MessageRow[];
    }
    const messages = rows.map(rowToMessage);
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (since ?? asCursor('0'));
    return { messages, nextCursor };
  }

  /**
   * True if a validated (`^\d+$`) `since` cursor points past this DB's AUTOINCREMENT high-water
   * mark — i.e. it references a rowid this database lifetime has never minted, so it was minted
   * against a previous DB (a recreated file, or `:memory:` which is a brand-new DB every process).
   * Such a cursor must NOT drive an `id > since` query or it silently skips every post after the
   * reset (BUG-23). `sqlite_sequence.seq` holds the largest rowid ever assigned (absent → 0). The
   * BigInt compare avoids the >2^53 rounding a Number() coercion would introduce (BUG-40).
   */
  private isStaleCursor(since: string): boolean {
    const row = this.require(this.seqStmt).get() as { seq: number | bigint } | undefined;
    const highWater = row === undefined ? 0n : BigInt(row.seq);
    return BigInt(since) > highWater;
  }

  /**
   * Live path = a per-topic poll loop (DESIGN §9, polling-only). Starts at the current max
   * rowid (history is owned by catch-up, not push). `SELECT WHERE id > :lastSeen ASC` per tick,
   * advancing `lastSeen`. `disconnect()` cancels the loop. The cursor guarantees nothing is
   * missed regardless of cadence.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    let lastSeen = this.maxId(topic);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // BUG-39: a permanent DB failure (file deleted/replaced/corrupted mid-run) makes the query
    // throw identically every tick. Track consecutive non-transient failures so the loop can be
    // diagnosed and escalated instead of spinning silently forever; rate-limit the diagnostic.
    let consecutiveHardFailures = 0;
    let lastDiag = 0;

    const tick = (): void => {
      if (this.stopped || this.driver === undefined) return;
      try {
        const rows = this.require(this.selectAfterStmt).all(
          topic,
          lastSeen,
          POLL_BATCH,
        ) as MessageRow[];
        for (const row of rows) {
          lastSeen = row.id;
          try {
            handler(rowToMessage(row));
          } catch {
            // Handler is best-effort (DESIGN §6); never let it break the poll loop.
          }
        }
        consecutiveHardFailures = 0; // a clean tick clears the escalation counter
      } catch (e) {
        if (isTransientLock(e)) {
          // Transient lock/contention — WAL + busy_timeout handle it; retry next tick, quietly.
          consecutiveHardFailures = 0;
        } else {
          consecutiveHardFailures++;
          const now = Date.now();
          // Rate-limited so a persistent failure doesn't flood stderr every poll_interval_ms —
          // but the very first hit is loud so the failure is never invisible.
          if (now - lastDiag > 60_000 || consecutiveHardFailures === 1) {
            lastDiag = now;
            process.stderr.write(
              `parley-sqlite: poll error on topic "${topic}" (#${consecutiveHardFailures}): ` +
                `${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
          if (consecutiveHardFailures >= 10) {
            // Permanent failure → stop the dead loop rather than spin forever with zero progress.
            process.stderr.write(
              `parley-sqlite: poll loop for topic "${topic}" stopped after ${consecutiveHardFailures} ` +
                `consecutive failures; live push is down for this topic\n`,
            );
            return; // do NOT reschedule
          }
        }
      }
      if (!this.stopped) timer = setTimeout(tick, this.pollIntervalMs);
    };

    this.cancellers.push(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    tick();
    return Promise.resolve();
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    // Local backend: a handle is a name convention, not a provisioned account (DESIGN §4).
    return { handle, backendRef: handle };
  }

  private maxId(topic: Topic): number {
    const row = this.require(this.maxIdStmt).get(topic) as { maxId: number } | undefined;
    return row?.maxId ?? 0;
  }

  /** Delete rows older than `retention_days`. Best-effort — a transient lock retries next tick. */
  private prune(): void {
    if (this.retentionDays === undefined || this.driver === undefined) return;
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    try {
      this.require(this.pruneStmt).run(cutoff);
    } catch {
      // Transient lock/contention — retry on the next interval.
    }
  }

  private require<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('SqlitePlugin not connected — call connect() first');
    return value;
  }
}

/**
 * BUG-39: classify a poll-tick error. SQLITE_BUSY/SQLITE_LOCKED are the sanctioned silent-retry
 * case (WAL + busy_timeout resolve them); everything else (`database disk image is malformed`,
 * `no such table: messages`, I/O errors after the file is removed) is a hard failure that must be
 * diagnosed and escalated rather than swallowed.
 */
function isTransientLock(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  return /BUSY|LOCKED/.test(code) || /database is locked|database table is locked/i.test(msg);
}

function rowToMessage(row: MessageRow): Message {
  return buildMessage({
    topic: asTopic(row.topic),
    sender: row.sender,
    content: row.content,
    timestamp: row.ts,
    id: String(row.id),
  });
}
