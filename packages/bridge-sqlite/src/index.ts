import { randomBytes } from 'node:crypto';
import {
  asBackendMsgId,
  asCursor,
  asTopic,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { classifyDbError, type DbErrorClass, errMessage } from './classify.js';
import { openDriver, type SqlDriver, type SqlStatement } from './driver.js';
import { type MessageRow, SCHEMA, SQL, STORE_ID_KEY } from './schema.js';

export { classifyDbError, type DbErrorClass };

/** Plugin-specific backend_config (DESIGN §11). */
export interface SqliteBackendConfig {
  /**
   * Path to the SQLite file. Default `parley.db` in the cwd. `:memory:` is single-process only AND
   * a brand-new database every process: its `AUTOINCREMENT` rowids restart at 1. Core's read-state
   * outlives the database, so a cursor persisted before a reset no longer lines up with this
   * store's ids — every cursor therefore carries the store's identity (`parley_meta.store_id`) and
   * a cursor from another store replays the topic from its first row rather than skipping history.
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
export const POLL_BATCH = 512;
/** Pruning cadence when `retention_days` is set — a cost knob only, like the poll interval. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Rows one prune statement deletes. Keep it bounded, so that neither the event loop nor the
 * file's single write lock is held for a duration that scales with the store — past a peer's
 * `busy_timeout` their `post()` throws SQLITE_BUSY.
 */
export const PRUNE_BATCH = 5_000;
/**
 * Largest page `fetchRecent` will serve. The driver is synchronous, and `limit` reaches it from a
 * model whose context is untrusted inbound content, so an unbounded page is a whole-bridge stall.
 * Keep a larger `limit` REJECTED rather than clamped, so that no caller which reads a short page as
 * "topic exhausted" can be handed one. Core's driver no longer makes that inference, but the seam
 * promises only that `limit` is a maximum, so a clamp stays unsafe for any caller that does.
 */
export const MAX_PAGE = 10_000;
/** Page size when a caller supplies no `limit`. */
const DEFAULT_PAGE = 100;
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
 * The SQLite backend (DESIGN §9). Zero-infra, **polling-only** — no socket, no notify bus,
 * no broker. The cursor (`<storeId>.<rowid>`) makes polling fully correct, so the poll interval
 * is a pure latency/cost knob. WAL + busy_timeout (in {@link openDriver}) make concurrent
 * multi-process posts safe (§9/§10).
 */
export class SqlitePlugin implements BackendPlugin {
  private driver?: SqlDriver;
  private pollIntervalMs = 1000;
  private retentionDays?: number;
  private stopped = false;
  private storeId?: string;
  private readonly cancellers: Array<() => void> = [];
  private pruneTimer?: ReturnType<typeof setInterval>;
  private pruneBatchTimer?: ReturnType<typeof setTimeout>;
  private readonly health: SubscriptionHealth[] = [];
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
    if (this.driver !== undefined) {
      throw new Error(
        'parley-sqlite: already connected — call disconnect() before connecting again ' +
          '(a second connect() would orphan every running poll loop against the previous store)',
      );
    }
    const cfg = validateBackendConfig(config);
    const dbPath = cfg.db_path ?? 'parley.db';

    const driver = openDriver(dbPath, {});
    let prepared: PreparedStatements;
    let storeId: string;
    try {
      driver.exec(SCHEMA);
      prepared = prepare(driver);
      storeId = readOrMintStoreId(driver, dbPath);
    } catch (e) {
      // Keep connect() all-or-nothing: close the handle and leave every field untouched, so that a
      // failed connect neither leaks a driver per attempt nor leaves an instance that answers
      // "already connected" to the next connect() and "not connected" to every operation.
      driver.close();
      throw e;
    }

    this.pollIntervalMs = cfg.poll_interval_ms ?? 1000;
    this.retentionDays = cfg.retention_days;
    this.stopped = false;
    this.health.length = 0;
    this.pruneFailures = 0;
    this.lastPruneDiag = 0;
    this.driver = driver;
    this.insertStmt = prepared.insert;
    this.selectAfterStmt = prepared.selectAfter;
    this.selectRecentStmt = prepared.selectRecent;
    this.maxIdStmt = prepared.maxId;
    this.pruneStmt = prepared.prune;
    this.seqStmt = prepared.seq;
    this.storeId = storeId;

    if (this.retentionDays !== undefined) {
      this.prune();
      // Keep the .unref(), so that a leaked-but-never-disconnect()ed plugin cannot by itself pin
      // the event loop — pruning is a best-effort cost knob, not a reason to keep the process
      // alive.
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    if (this.pruneBatchTimer !== undefined) clearTimeout(this.pruneBatchTimer);
    this.pruneBatchTimer = undefined;
    for (const cancel of this.cancellers) cancel();
    this.cancellers.length = 0;
    for (const h of this.health) {
      h.state = 'stopped';
      h.lastError = 'disconnected';
    }
    this.driver?.close();
    this.driver = undefined;
    this.storeId = undefined;
    // Keep these cleared with the driver that prepared them, so that a call after teardown reports
    // require()'s "not connected" rather than the driver's "database connection is not open",
    // which names neither this plugin nor the lifecycle mistake behind it.
    this.insertStmt = undefined;
    this.selectAfterStmt = undefined;
    this.selectRecentStmt = undefined;
    this.maxIdStmt = undefined;
    this.pruneStmt = undefined;
    this.seqStmt = undefined;
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
    return asBackendMsgId(String(info.lastInsertRowid));
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const limit = normalizeLimit(args.limit, args.topic);
    const storeId = this.require(this.storeId);
    const resumeAfter = args.since === undefined ? undefined : this.resumeAfter(args.since, args.topic);
    let rows: MessageRow[];
    if (resumeAfter === undefined) {
      rows = this.require(this.selectRecentStmt).all(args.topic, limit) as MessageRow[];
      rows.reverse();
    } else {
      rows = this.require(this.selectAfterStmt).all(
        args.topic,
        resumeAfter,
        limit,
      ) as MessageRow[];
    }
    const messages = rows.map((row) => rowToMessage(row, storeId));
    const last = messages.at(-1);
    return {
      messages,
      nextCursor: last?.cursor ?? mintCursor(storeId, resumeAfter ?? 0n),
    };
  }

  /**
   * The rowid a `since` cursor resumes strictly after. A cursor carrying a different store id —
   * a recreated file, a `:memory:` process, another backend's numeric cursor reaching this plugin
   * through mis-namespaced read-state — resumes from 0 and replays the topic, because its rowids
   * name nothing in this store and `id > <foreign>` would silently drop everything below it. So
   * does a cursor of this store that sits above the `AUTOINCREMENT` high-water mark, which is what
   * a restore from an older backup produces.
   */
  private resumeAfter(since: Cursor, topic: Topic): bigint {
    const parsed = parseCursor(since);
    if (parsed === undefined) {
      throw new Error(
        `parley-sqlite: malformed cursor '${since}' for topic ${topic} — ` +
          `expected '<storeId>.<rowid>' minted by this backend`,
      );
    }
    if (parsed.storeId !== this.require(this.storeId)) return 0n;
    return parsed.rowid > this.highWater() ? 0n : parsed.rowid;
  }

  private highWater(): bigint {
    const row = this.require(this.seqStmt).get() as { seq: number | bigint } | undefined;
    return row === undefined ? 0n : BigInt(row.seq);
  }

  /**
   * Live path = a per-topic poll loop (DESIGN §9, polling-only). Starts at the current max
   * rowid (history is owned by catch-up, not push). `SELECT WHERE id > :lastSeen ASC` per tick,
   * advancing `lastSeen`. `disconnect()` cancels the loop. The cursor guarantees nothing is
   * missed regardless of cadence.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const storeId = this.require(this.storeId);
    let lastSeen = this.maxId(topic);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let lastDiag = 0;
    const health: SubscriptionHealth = { topic, state: 'live', consecutiveFailures: 0 };
    this.health.push(health);

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
            handler(rowToMessage(row, storeId));
          } catch {
            // Handler is best-effort (DESIGN §6); never let it break the poll loop.
          }
        }
        // Keep the immediate reschedule on a full batch, so that POLL_BATCH bounds per-tick work
        // rather than capping throughput at one batch per poll interval.
        if (rows.length === POLL_BATCH) delay = 0;
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
    const all = this.health.map((h) => ({ ...h }));
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
   * Delete up to {@link PRUNE_BATCH} rows older than `retention_days`, rescheduling itself while
   * batches come back full. A lock retries on the next interval, quietly; any other failure is
   * reported, so a retention policy the process cannot enforce is never silent.
   */
  private prune(): void {
    if (this.retentionDays === undefined || this.driver === undefined || this.stopped) return;
    try {
      const cutoff = retentionCutoff(this.retentionDays);
      const info = this.require(this.pruneStmt).run(cutoff, PRUNE_BATCH);
      this.pruneFailures = 0;
      if (Number(info.changes) >= PRUNE_BATCH) {
        this.pruneBatchTimer = setTimeout(() => this.prune(), 0).unref();
      }
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
 * Degraded poll delay after `failures` consecutive non-lock failures: exponential from the
 * configured interval, capped at {@link BACKOFF_CEILING_MS}. The cap is the README's promise that
 * a topic whose store was briefly unreachable resumes live push within 30 s, not within days.
 */
export function backoffMs(pollIntervalMs: number, failures: number): number {
  const doublings = Math.min(failures - ESCALATE_AFTER + 1, 30);
  return Math.min(pollIntervalMs * 2 ** doublings, BACKOFF_CEILING_MS);
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

  if (typeof retention === 'number') retentionCutoff(retention);

  return cfg as SqliteBackendConfig;
}

/**
 * Rows with `ts` below this are outside the retention window. Throw rather than return a sentinel
 * on an unrepresentable cutoff, so that a bogus window can never become a string that sorts below
 * every ISO timestamp and prunes the entire store.
 */
export function retentionCutoff(retentionDays: number): string {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  if (Number.isNaN(cutoff.getTime())) {
    throw bad(
      'retention_days',
      `${describe(retentionDays)} puts the cutoff outside the representable date range, so every ` +
        `prune would fail and the window would never be enforced`,
    );
  }
  return cutoff.toISOString();
}

function describe(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/**
 * Shape of `parley_meta.store_id`. Keep the mint side, the parse side and the connect-time check
 * deriving from THIS one pattern, so that the plugin cannot mint a cursor its own parser rejects.
 */
const STORE_ID_PATTERN = '[0-9a-f]{16}';
const STORE_ID_RE = new RegExp(`^${STORE_ID_PATTERN}$`);

/**
 * A cursor is `<storeId>.<rowid>`. A bare `<rowid>` parses with no store id — this backend before
 * cursors carried identity, or another backend's numeric cursor — and names nothing here, so
 * `resumeAfter` replays instead of trusting it.
 */
const CURSOR_RE = new RegExp(`^(?:(${STORE_ID_PATTERN})\\.)?(\\d+)$`);

function parseCursor(raw: string): { storeId?: string; rowid: bigint } | undefined {
  const m = CURSOR_RE.exec(raw);
  if (m === null) return undefined;
  return { storeId: m[1], rowid: BigInt(m[2] ?? '0') };
}

function mintCursor(storeId: string, rowid: number | bigint): Cursor {
  return asCursor(`${storeId}.${rowid}`);
}

type PreparedStatements = { [K in keyof typeof SQL]: SqlStatement };

function prepare(driver: SqlDriver): PreparedStatements {
  return Object.fromEntries(
    Object.entries(SQL).map(([name, sql]) => [name, driver.prepare(sql)]),
  ) as PreparedStatements;
}

/**
 * This store's identity, minted once and persisted. `INSERT OR IGNORE` then read back, so that
 * two bridge processes racing a brand-new file agree on whichever id landed first. The read-back
 * is checked against the cursor grammar rather than trusted: it is written into every cursor this
 * store mints, so a value the parser cannot place would make the plugin mint cursors it rejects on
 * the next catch-up — which core propagates, so every bridge sharing the file fails to start.
 */
function readOrMintStoreId(driver: SqlDriver, dbPath: string): string {
  driver
    .prepare('INSERT OR IGNORE INTO parley_meta (key, value) VALUES (?, ?)')
    .run(STORE_ID_KEY, randomBytes(8).toString('hex'));
  const row = driver.prepare('SELECT value FROM parley_meta WHERE key = ?').get(STORE_ID_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) {
    throw new Error('parley-sqlite: could not establish a store id in parley_meta');
  }
  if (!STORE_ID_RE.test(row.value)) {
    throw new Error(
      `parley-sqlite: ${dbPath} carries an unusable parley_meta.${STORE_ID_KEY} ` +
        `${describe(row.value)} — expected ${STORE_ID_PATTERN}. Every cursor this backend mints ` +
        `carries it, so this store would hand out cursors its own parser rejects; restore the ` +
        `original value, or delete the row to mint a fresh identity (readers then replay rather ` +
        `than skip)`,
    );
  }
  return row.value;
}

function normalizeLimit(limit: number | undefined, topic: Topic): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new Error(
      `parley-sqlite: invalid limit ${describe(limit)} for topic ${topic} — expected an integer ` +
        `between 1 and ${MAX_PAGE}; lower config \`catchup.limit\` (or the parley_fetch_recent ` +
        `\`limit\` argument) to at most ${MAX_PAGE} (SQLite reads a negative LIMIT as "no limit"; ` +
        `a page above ${MAX_PAGE} would come back short, which a caller that stops on a short ` +
        `page cannot tell from an exhausted topic)`,
    );
  }
  return limit;
}

function rowToMessage(row: MessageRow, storeId: string): Message {
  return buildMessage({
    topic: asTopic(row.topic),
    sender: row.sender,
    content: row.content,
    timestamp: row.ts,
    id: String(row.id),
    cursor: mintCursor(storeId, row.id),
  });
}
