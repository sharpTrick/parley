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
   * DB never minted. `fetchRecent` guards this case (a `since` past the DB's high-water mark
   * replays the topic from its first row instead of silently skipping messages), but clearing
   * stale read-state on reset is still the correct operational step.
   */
  db_path?: string;
  /**
   * Poll interval for the live `subscribe` loop. Latency knob only — no correctness impact (§9).
   * Must be an integer between {@link MIN_POLL_INTERVAL_MS} and {@link MAX_POLL_INTERVAL_MS};
   * `0` is rejected rather than accepted as a hot loop that pins a CPU against the DB.
   */
  poll_interval_ms?: number;
  /**
   * Optional retention window in days: rows older than this are pruned on a background timer.
   * Omit for the default — keep every message forever. `0` and negatives are rejected: they mean
   * "delete everything up to now", an irreversible wipe of the whole shared file. Safe to enable
   * at any time: `id` is `AUTOINCREMENT` and never reused, so a cursor/backendMsgId minted before
   * a prune stays valid (a stale reader just gets fewer rows back, never a wrong or duplicate one).
   */
  retention_days?: number;
}

/** How many new rows a single poll tick drains at most before yielding. */
const POLL_BATCH = 512;
/** Pruning cadence when `retention_days` is set — a cost knob only, like the poll interval. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Floor for `poll_interval_ms`: below this the loop is a hot spin, not a poll. */
export const MIN_POLL_INTERVAL_MS = 10;
/**
 * Ceiling for `poll_interval_ms`. Keep it at setTimeout's 32-bit limit: Node silently clamps a
 * larger delay to 1 ms, so an operator asking for a very slow poll would get a hot loop instead.
 */
export const MAX_POLL_INTERVAL_MS = 2_147_483_647;
/** Consecutive non-lock poll failures before the loop escalates (backs off, or stops if fatal). */
const ESCALATE_AFTER = 10;
/** Ceiling on the degraded poll interval, so a down DB is re-probed forever but cheaply. */
const BACKOFF_CEILING_MS = 30_000;
/** Minimum gap between repeats of the same background-job diagnostic. */
const DIAG_INTERVAL_MS = 60_000;

/**
 * Live state of one topic's poll loop. `degraded` means the loop is still probing on a backed-off
 * interval and will self-heal; `stopped` means it will never deliver again without a reconnect.
 */
export type SubscriptionState = 'live' | 'degraded' | 'stopped';

export interface SubscriptionHealth {
  topic: Topic;
  state: SubscriptionState;
  consecutiveFailures: number;
  lastError?: string;
}

/**
 * How a DB error affects a background loop. `lock` is the sanctioned silent-retry case (WAL +
 * busy_timeout resolve it). `unavailable` covers everything that can heal on its own — I/O errors,
 * a read-only or full volume, a file that is briefly unopenable while a backup swaps it — so the
 * loop must keep probing. `fatal` is reserved for damage no amount of retrying repairs.
 */
export type DbErrorClass = 'lock' | 'unavailable' | 'fatal';

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
  private readonly health = new Map<Topic, SubscriptionHealth>();
  private pruneFailures = 0;
  private lastPruneDiag = 0;

  // Prepared statements (built once at connect).
  private insertStmt?: SqlStatement;
  private selectAfterStmt?: SqlStatement;
  private selectRecentStmt?: SqlStatement;
  private maxIdStmt?: SqlStatement;
  private pruneStmt?: SqlStatement;
  private seqStmt?: SqlStatement;

  async connect(config: BackendConfig): Promise<void> {
    const cfg = validateBackendConfig(config);
    const dbPath = cfg.db_path ?? 'parley.db';
    this.pollIntervalMs = cfg.poll_interval_ms ?? 1000;
    this.retentionDays = cfg.retention_days;
    this.stopped = false;
    this.health.clear();
    this.pruneFailures = 0;
    this.lastPruneDiag = 0;

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
      // BUG-27: unref the prune timer so a leaked-but-never-disconnect()ed plugin cannot by
      // itself pin the event loop — pruning is a best-effort cost knob, not a reason to keep the
      // process alive.
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
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
    // A well-formed but STALE cursor — minted against a previous DB lifetime, so it points past
    // this DB's AUTOINCREMENT high-water mark — replays the topic from its first row (BUG-23).
    // Keep it a replay: `id > <stale>` returns [] and drops every post made after the reset, and
    // the default recent window silently skips everything older than the last `limit` rows while
    // returning a cursor that claims they were read.
    const since = args.since !== undefined && this.isStaleCursor(args.since) ? '0' : args.since;
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
    const nextCursor = last !== undefined ? last.cursor : asCursor(since ?? '0');
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
    let failures = 0;
    let lastDiag = 0;
    const health: SubscriptionHealth = { topic, state: 'live', consecutiveFailures: 0 };
    this.health.set(topic, health);

    const tick = (): void => {
      if (this.stopped || this.driver === undefined) return;
      let delay = this.pollIntervalMs;
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
        failures = 0;
        health.state = 'live';
        health.consecutiveFailures = 0;
        health.lastError = undefined;
      } catch (e) {
        const cls = classifyDbError(e);
        if (cls === 'lock') {
          // WAL + busy_timeout handle contention; retry next tick, quietly, without escalating.
          failures = 0;
          health.state = 'live';
          health.consecutiveFailures = 0;
        } else {
          failures++;
          health.consecutiveFailures = failures;
          health.lastError = errMessage(e);
          const now = Date.now();
          // Rate-limited so a persistent failure doesn't flood stderr every poll_interval_ms —
          // but the very first hit is loud so the failure is never invisible.
          if (now - lastDiag > DIAG_INTERVAL_MS || failures === 1) {
            lastDiag = now;
            process.stderr.write(
              `parley-sqlite: poll error on topic "${topic}" (#${failures}): ${errMessage(e)}\n`,
            );
          }
          if (failures >= ESCALATE_AFTER) {
            if (cls === 'fatal') {
              health.state = 'stopped';
              process.stderr.write(
                `parley-sqlite: poll loop for topic "${topic}" stopped after ${failures} ` +
                  `consecutive unrecoverable failures; live push is down for this topic\n`,
              );
              return; // do NOT reschedule
            }
            // Keep probing here, however long it takes: subscribe()'s promise has already
            // resolved and core has no other signal, so stopping is silent, permanent loss of
            // live push for a topic whose DB was only temporarily unreachable.
            health.state = 'degraded';
            delay = backoffMs(this.pollIntervalMs, failures);
          }
        }
      }
      if (!this.stopped) timer = setTimeout(tick, delay);
    };

    this.cancellers.push(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    tick();
    return Promise.resolve();
  }

  /**
   * Programmatic view of every poll loop this plugin has started — the path an operator or a
   * health check reads, since stderr is routinely discarded by an MCP stdio host.
   */
  subscriptionHealth(topic?: Topic): SubscriptionHealth[] {
    const all = [...this.health.values()].map((h) => ({ ...h }));
    return topic === undefined ? all : all.filter((h) => h.topic === topic);
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    // Local backend: a handle is a name convention, not a provisioned account (DESIGN §4).
    return { handle, backendRef: handle };
  }

  private maxId(topic: Topic): number {
    const row = this.require(this.maxIdStmt).get(topic) as { maxId: number } | undefined;
    return row?.maxId ?? 0;
  }

  /**
   * Delete rows older than `retention_days`. A lock retries on the next interval, quietly; any
   * other failure is reported, so a retention policy the process cannot enforce is never silent.
   */
  private prune(): void {
    if (this.retentionDays === undefined || this.driver === undefined) return;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
      this.require(this.pruneStmt).run(cutoff);
      this.pruneFailures = 0;
    } catch (e) {
      if (classifyDbError(e) === 'lock') return;
      this.pruneFailures++;
      const now = Date.now();
      if (now - this.lastPruneDiag > DIAG_INTERVAL_MS || this.pruneFailures === 1) {
        this.lastPruneDiag = now;
        process.stderr.write(
          `parley-sqlite: retention prune failed (#${this.pruneFailures}): ${errMessage(e)}\n`,
        );
      }
    }
  }

  private require<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('SqlitePlugin not connected — call connect() first');
    return value;
  }
}

/**
 * Classify a DB error for the background loops (BUG-39). Only damage that retrying cannot repair
 * is `fatal`; an unrecognised error is `unavailable`, so a class nobody anticipated backs off and
 * self-heals rather than permanently killing live push.
 */
export function classifyDbError(e: unknown): DbErrorClass {
  const code = (e as { code?: string } | null)?.code ?? '';
  const msg = errMessage(e);
  if (/BUSY|LOCKED/.test(code) || /database is locked|database table is locked/i.test(msg)) {
    return 'lock';
  }
  if (/CORRUPT|NOTADB/.test(code) || /malformed|file is not a database|no such table/i.test(msg)) {
    return 'fatal';
  }
  return 'unavailable';
}

function backoffMs(pollIntervalMs: number, failures: number): number {
  const doublings = Math.min(failures - ESCALATE_AFTER + 1, 30);
  return Math.min(pollIntervalMs * 2 ** doublings, BACKOFF_CEILING_MS);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const CONFIG_KEYS = ['db_path', 'poll_interval_ms', 'retention_days'] as const;

function bad(key: string, reason: string): Error {
  return new Error(`parley-sqlite: invalid backend_config.${key} — ${reason}`);
}

/**
 * Validate `backend_config` before anything is opened or deleted (§11). Every rejection names the
 * key and the plugin, and happens before `connect()` has touched the database, so a typo or a
 * mis-typed retention window can never take an irreversible action.
 */
export function validateBackendConfig(config: BackendConfig): SqliteBackendConfig {
  const cfg = config as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-sqlite: unknown backend_config key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
      );
    }
  }

  const dbPath = cfg['db_path'];
  if (dbPath !== undefined && (typeof dbPath !== 'string' || dbPath === '')) {
    throw bad('db_path', `expected a non-empty string, got ${describe(dbPath)}`);
  }

  const poll = cfg['poll_interval_ms'];
  if (
    poll !== undefined &&
    (typeof poll !== 'number' ||
      !Number.isInteger(poll) ||
      poll < MIN_POLL_INTERVAL_MS ||
      poll > MAX_POLL_INTERVAL_MS)
  ) {
    throw bad(
      'poll_interval_ms',
      `expected an integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS} ms, ` +
        `got ${describe(poll)}`,
    );
  }

  const retention = cfg['retention_days'];
  if (retention !== undefined && (typeof retention !== 'number' || !(retention > 0))) {
    throw bad(
      'retention_days',
      `expected a number > 0, got ${describe(retention)} — 0 or negative would delete the whole ` +
        `history; omit the key to keep every message forever`,
    );
  }
  if (typeof retention === 'number' && !Number.isFinite(retention)) {
    throw bad('retention_days', `expected a finite number, got ${describe(retention)}`);
  }

  return cfg as SqliteBackendConfig;
}

function describe(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
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
