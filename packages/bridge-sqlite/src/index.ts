import {
  asBackendMsgId,
  asCursor,
  asHandle,
  asTopic,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  parseMentions,
  type Topic,
} from '@parley/core';
import { openDriver, type SqlDriver, type SqlStatement } from './driver.js';
import { type MessageRow, SCHEMA } from './schema.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface SqliteBackendConfig {
  /** Path to the SQLite file. Default `parley.db` in the cwd. `:memory:` is single-process only. */
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
    return asBackendMsgId(String(Number(info.lastInsertRowid)));
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const limit = args.limit ?? 100;
    let rows: MessageRow[];
    if (args.since === undefined) {
      // Default window: the most recent `limit` messages, returned ascending by cursor.
      rows = this.require(this.selectRecentStmt).all(args.topic, limit) as MessageRow[];
      rows.reverse();
    } else {
      // Exclusive: strictly after `since`, ascending.
      rows = this.require(this.selectAfterStmt).all(
        args.topic,
        Number(args.since),
        limit,
      ) as MessageRow[];
    }
    const messages = rows.map(rowToMessage);
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor('0'));
    return { messages, nextCursor };
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
      } catch {
        // Transient lock/contention — WAL + busy_timeout handle it; retry next tick.
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

function rowToMessage(row: MessageRow): Message {
  const id = String(row.id);
  return {
    topic: asTopic(row.topic),
    senderHandle: asHandle(row.sender),
    content: row.content,
    timestamp: row.ts,
    backendMsgId: asBackendMsgId(id),
    cursor: asCursor(id),
    mentions: parseMentions(row.content),
  };
}
