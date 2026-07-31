import type { BackendConfig, Topic } from '@sharptrick/parley-core';

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
   * Omit for the default — keep every message forever. Anything below {@link MIN_RETENTION_DAYS}
   * is rejected: `0`, negatives and a window too short to hold a conversation all mean "delete
   * everything up to now", an irreversible wipe of the whole shared file. Safe to enable
   * at any time: `id` is `AUTOINCREMENT` and never reused, so a cursor/backendMsgId minted before
   * a prune stays valid (catch-up across a prune returns fewer rows, never a wrong or duplicate
   * one). Which rows go is decided by `ts` — the wall clock of whichever process posted them, not
   * the cursor — so skew between hosts sharing one file shifts which messages survive, and a row
   * can be pruned before any reader's cursor has reached it.
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
 * Floor for `retention_days`: one minute, expressed in days. `connect()` prunes immediately, so a
 * window too short to hold a conversation empties the whole shared file the moment it is accepted —
 * the outcome `0` and negatives are refused for, reached just as well by `Number.MIN_VALUE`,
 * `1e-9`, or a unit slip that meant milliseconds.
 */
export const MIN_RETENTION_DAYS = 1 / 1440;
/**
 * Ceiling for `poll_interval_ms`. Keep it at setTimeout's 32-bit limit: Node silently clamps a
 * larger delay to 1 ms, so an operator asking for a very slow poll would get a hot loop instead.
 */
export const MAX_POLL_INTERVAL_MS = 2_147_483_647;
/**
 * Most catch-up hand-off points held at once. `fetchRecent`'s topic is caller-supplied, and core
 * admits any topic a `post_topics` pattern matches, so the ledger is capped rather than left to
 * grow one entry per distinct topic ever fetched. An evicted topic's {@link SqlitePlugin.subscribe}
 * samples the current tail, exactly as a topic catch-up never read does.
 */
export const CATCHUP_LEDGER_MAX = 1024;
/** Consecutive failing poll ticks before the loop escalates (backs off, or stops if fatal). */
export const ESCALATE_AFTER = 10;
/** Minimum gap between repeats of the same background-job diagnostic. */
export const DIAG_INTERVAL_MS = 60_000;

const CONFIG_KEYS = ['db_path', 'poll_interval_ms', 'retention_days'] as const;

function bad(key: string, reason: string): Error {
  return new Error(`parley-sqlite: invalid backend_config.${key} — ${reason}`);
}

const integerBetween = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validate `backend_config` before anything is opened or deleted (§11). Every rejection names the
 * key and the plugin, and happens before `connect()` has touched the database, so a typo or a
 * mis-typed retention window can never take an irreversible action.
 */
export function validateBackendConfig(config: BackendConfig): SqliteBackendConfig {
  const cfg = config as Record<string, unknown>;
  const stray = Object.keys(cfg).find((k) => !(CONFIG_KEYS as readonly string[]).includes(k));
  if (stray !== undefined) {
    throw new Error(
      `parley-sqlite: unknown backend_config key '${stray}' — expected one of ${CONFIG_KEYS.join(', ')}`,
    );
  }

  const dbPath = cfg['db_path'];
  if (dbPath !== undefined && (typeof dbPath !== 'string' || dbPath === '')) {
    throw bad('db_path', `expected a non-empty string, got ${describe(dbPath)}`);
  }

  const poll = cfg['poll_interval_ms'];
  if (poll !== undefined && !integerBetween(poll, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS)) {
    throw bad(
      'poll_interval_ms',
      `expected an integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS} ms, ` +
        `got ${describe(poll)}`,
    );
  }

  const retention = cfg['retention_days'];
  if (
    retention !== undefined &&
    (typeof retention !== 'number' || !(retention >= MIN_RETENTION_DAYS))
  ) {
    throw bad(
      'retention_days',
      `expected a number >= ${MIN_RETENTION_DAYS} (one minute), got ${describe(retention)} — a ` +
        `window this short deletes the whole history on the connect() prune, which is what 0 and ` +
        `negatives were already refused for; omit the key to keep every message forever`,
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

export function describe(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

export function normalizeLimit(limit: number | undefined, topic: Topic): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!integerBetween(limit, 1, MAX_PAGE)) {
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
