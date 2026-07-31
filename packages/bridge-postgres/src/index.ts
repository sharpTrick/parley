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
import { delay } from '@sharptrick/parley-net-util';
import { Client, Pool } from 'pg';
import { parse as parseDsn } from 'pg-connection-string';
import {
  assertTableName,
  badConfig,
  buildSchema,
  channelFor,
  MAX_TABLE_NAME_BYTES,
  type MessageRow,
  quotedNames,
  type SchemaNames,
  unknownConfigKey,
} from './schema.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface PostgresBackendConfig {
  /** Connection URL. Default `postgres://parley:parley@127.0.0.1:5432/parley`. */
  url?: string;
  /**
   * Message table name; the sender registry lives beside it as `<table_name>_senders`.
   * Default `parley_messages`. Restricted to `[A-Za-z0-9_]` and {@link MAX_TABLE_NAME_BYTES}
   * bytes — it is interpolated into SQL, and longer names truncate into each other.
   */
  table_name?: string;
  /** Max pooled connections for queries/writes (the LISTEN connection is separate). Default 5. */
  pool_size?: number;
  /**
   * Optional retention window in days, between {@link MIN_RETENTION_DAYS} and
   * {@link MAX_RETENTION_DAYS}: rows older than it are pruned on a background timer.
   * Omit for the default — keep every message forever. Safe to enable at any time: `seq` is a
   * BIGSERIAL and never reused, so a cursor/backendMsgId minted before a prune stays valid (a
   * stale reader just gets fewer rows back, never a wrong or duplicate one).
   */
  retention_days?: number;
}

const DEFAULT_URL = 'postgres://parley:parley@127.0.0.1:5432/parley';
/** The repo-public credential pair the README's docker snippet provisions. */
const DEFAULT_USER = 'parley';
const DEFAULT_PASSWORD = 'parley';
/** Pooled connections `connect()` opens when `pool_size` is omitted. */
export const DEFAULT_POOL_SIZE = 5;
export const MIN_POOL_SIZE = 1;
export const MAX_POOL_SIZE = 1000;
/**
 * Widest retention window this backend accepts, in days (50 years). Keep a ceiling here, so that
 * every accepted window still has a cutoff a stored row could fall on: past it the cutoff first
 * predates any message this system wrote — pruning is then a permanent no-op the operator was
 * told was running hourly — and further still the window overflows the `interval` the server
 * subtracts, which throws inside the best-effort prune and is swallowed there.
 */
export const MAX_RETENTION_DAYS = 18_250;
/**
 * Narrowest retention window this backend accepts, in days: one minute. `connect()` prunes
 * immediately, so a window too short to hold a conversation empties the whole shared table — for
 * every topic and every bridge process sharing it — the moment it is accepted. That is the outcome
 * `0` and negatives are refused for, reached just as well by `Number.MIN_VALUE`, `1e-9`, or a unit
 * slip that meant milliseconds. Matches bridge-sqlite's floor for the identical key.
 */
export const MIN_RETENTION_DAYS = 1 / 1440;
/** How many rows one drain query pulls at most before re-querying. */
const DRAIN_BATCH = 512;
/** First gap before a failed drain is retried; doubles per consecutive failure. */
const DRAIN_RETRY_BASE_MS = 50;
/**
 * Ceiling on the re-drain gap, so a database that stays down is re-probed forever but cheaply.
 * Keep the retry unbounded in COUNT, so that push converges the way catch-up does: NOTIFY is
 * edge-triggered, and a drain that gave up holds `lastSeen` behind a durably stored row with no
 * later edge guaranteed to arrive.
 */
const DRAIN_RETRY_CEILING_MS = 30_000;
/** Backoff between listener reconnect attempts after the connection drops. */
const RECONNECT_DELAY_MS = 500;
/**
 * How long a statement waits for a server-side lock before giving up, in ms. Every lock this
 * plugin takes is held for one INSERT or one idempotent bootstrap, so reaching this means another
 * session is sitting on it. Keep a bound here, so that a wedged lock cannot pin a pooled
 * connection forever and starve every other seam call of pool capacity.
 */
export const LOCK_WAIT_MS = 5000;
/**
 * How long a seam call waits for the shared LISTEN connection — a first connect, or the backoff
 * reconnect after a drop — before giving up. Bounded for the same reason as {@link LOCK_WAIT_MS}.
 */
export const LISTENER_WAIT_MS = 5000;
/** Pruning cadence when `retention_days` is set — a cost knob only, like the pool size. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const CONFIG_KEYS = ['url', 'table_name', 'pool_size', 'retention_days'] as const;
/** Rows one prune statement may delete, so retention never issues one unbounded table-wide DELETE. */
export const PRUNE_BATCH = 5000;

function describeValue(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/**
 * Validate `backend_config` before the pool is opened or anything is deleted (§11). Every rejection
 * names the key and the plugin, and happens before `connect()` has touched the database, so a typo
 * or a mis-typed retention window can never take an irreversible action.
 */
export function validateBackendConfig(config: BackendConfig): PostgresBackendConfig {
  const cfg = config as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw unknownConfigKey(key, CONFIG_KEYS);
    }
  }

  const url = cfg['url'];
  if (url !== undefined && (typeof url !== 'string' || url === '')) {
    throw badConfig('url', `expected a non-empty string, got ${describeValue(url)}`);
  }

  const tableName = cfg['table_name'];
  if (tableName !== undefined && (typeof tableName !== 'string' || tableName === '')) {
    throw badConfig('table_name', `expected a non-empty string, got ${describeValue(tableName)}`);
  }

  const poolSize = cfg['pool_size'];
  if (
    poolSize !== undefined &&
    (typeof poolSize !== 'number' ||
      !Number.isInteger(poolSize) ||
      poolSize < MIN_POOL_SIZE ||
      poolSize > MAX_POOL_SIZE)
  ) {
    throw badConfig(
      'pool_size',
      `expected an integer between ${MIN_POOL_SIZE} and ${MAX_POOL_SIZE}, got ` +
        `${describeValue(poolSize)} — a pool that cannot hand out a connection makes connect() ` +
        `wait forever`,
    );
  }

  const retention = cfg['retention_days'];
  if (
    retention !== undefined &&
    (typeof retention !== 'number' ||
      !Number.isFinite(retention) ||
      !(retention >= MIN_RETENTION_DAYS) ||
      retention > MAX_RETENTION_DAYS)
  ) {
    throw badConfig(
      'retention_days',
      `expected a finite number of days between ${MIN_RETENTION_DAYS} (one minute) and ` +
        `${MAX_RETENTION_DAYS}, got ` +
        `${describeValue(retention)} — a window shorter than a minute empties the whole shared ` +
        'table on the prune connect() runs immediately, which is what 0 and negatives were ' +
        `already refused for, and a window past ${MAX_RETENTION_DAYS} days puts the cutoff ` +
        'before any message this backend could have written, so pruning would silently never run ' +
        'at all; omit the key to keep every message forever',
    );
  }

  return cfg as PostgresBackendConfig;
}

/**
 * True when the DSN carries the repo-public `parley:parley` pair, whatever host/port/database.
 *
 * Keep this deriving the credentials from `pg-connection-string` — the parser `new Pool({
 * connectionString })` itself uses — so that every spelling pg honours is graded. Hand-parsing with
 * `new URL` sees only the userinfo, so a DSN carrying the published pair as libpq `?user=`/
 * `?password=` query parameters connects with it and warns about nothing.
 */
export function usesDefaultCredentials(url: string): boolean {
  try {
    const parsed = parseDsn(url);
    // Keep these `||`, so that the env fallback still runs: the parser reports a credential the DSN
    // omits as '', and pg authenticates such a DSN as PGUSER/PGPASSWORD.
    const user = parsed.user || process.env['PGUSER'];
    const password = parsed.password || process.env['PGPASSWORD'];
    return user === DEFAULT_USER && password === DEFAULT_PASSWORD;
  } catch {
    return false;
  }
}

/** The largest value PostgreSQL's `bigint` holds — the ceiling on any cursor this backend mints. */
const MAX_SEQ = 9223372036854775807n;

/**
 * Reject a `since` this backend cannot have minted, before it reaches `seq > $2::bigint`.
 *
 * `since` is opaque and agent-supplied (core's `parley_fetch_recent` passes `z.string()` straight
 * through), and the cast decides what happens to anything else: `'abc'` raises SQLSTATE 22P02 and
 * renders a database error into agent context, while `' 5 '`, `'0x10'` and `'-1'` are quietly
 * accepted because bigint input is laxer than a cursor.
 */
function assertCursor(since: string): void {
  if (!/^\d{1,19}$/.test(since) || BigInt(since) > MAX_SEQ) {
    throw new Error(
      `parley-postgres: invalid cursor ${JSON.stringify(since)} — a cursor from this backend is a ` +
        `decimal sequence number between 0 and ${MAX_SEQ}. Pass one this backend returned as ` +
        '`nextCursor`, or omit `since` to get the newest page.',
    );
  }
}

/**
 * Refuse a seam argument PostgreSQL's TEXT type cannot hold, before it reaches the driver.
 *
 * Every one of these is agent- or human-supplied and untrusted (DESIGN §5): core's `parley_post`
 * takes a bare `z.string()` for `content`, and a topic reaches here from anything a `post_topics`
 * pattern admits. A NUL byte is legal in a JSON string and legal in a JS string, and PostgreSQL
 * answers it with `invalid byte sequence for encoding "UTF8": 0x00` — a bare driver string naming
 * neither this plugin, nor the field, nor the fact that nothing was written, which core then
 * renders into agent context. This is the same contract `assertCursor` states for reads.
 */
function assertStorable(field: string, value: string): void {
  const at = value.indexOf('\u0000');
  if (at < 0) return;
  throw new Error(
    `parley-postgres: invalid ${field} — a NUL byte (U+0000) at index ${at} cannot be stored in ` +
      "PostgreSQL's TEXT type. Nothing was written; strip it and retry.",
  );
}

/**
 * Wrap EVERY way `subscribe` can fail so the seam call names this plugin and the topic it was for.
 * Each statement it runs has its own raw driver string — 'Client has encountered a connection error
 * and is not queryable' from the memoized listener during a backoff reconnect, 'terminating
 * connection due to administrator command' from a pooled read — and core's push loop rethrows
 * anything that is not a `NoSuchTopicError`, so any of them stops the whole bridge coming up on a
 * message naming neither the backend nor the topic.
 */
function subscribeFailed(topic: Topic, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.startsWith('parley-postgres:')) return err as Error;
  return new Error(
    `parley-postgres: could not establish the live path for topic '${topic}' — ${detail}. Nothing ` +
      'was registered for that topic; a retry succeeds once the database is reachable again.',
  );
}

/** PostgreSQL's SQLSTATE for a statement that gave up waiting on a lock (`lock_timeout`). */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Name a lock wait this plugin abandoned. `SET LOCAL lock_timeout` turns an indefinite wait into
 * this error; without the rename it reaches the agent as PostgreSQL's bare 'canceling statement
 * due to lock timeout', naming neither the plugin, the topic, nor the fact that nothing was written.
 */
function lockWaitAbandoned(what: string, err: unknown): Error {
  if ((err as { code?: string } | undefined)?.code !== LOCK_NOT_AVAILABLE) return err as Error;
  return new Error(
    `parley-postgres: gave up after ${LOCK_WAIT_MS}ms waiting for the ${what} — another session is ` +
      'holding it. Nothing was written; retry once that session commits or is terminated.',
  );
}

/** Reject with `onTimeout()` if `p` has not settled within `budgetMs`; never leaves a timer behind. */
async function withDeadline<T>(
  p: Promise<T>,
  budgetMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Per-channel LISTEN state shared by subscriptions and blocking waiters. */
interface ListenState {
  /** Resolves only once the LISTEN is ESTABLISHED — never merely intended. */
  ready: Promise<void>;
  /** Participants (subscriptions + in-flight waiters) that still need this channel LISTENed. */
  refs: number;
}

/** Live-path bookkeeping for one subscribed topic (keyed by NOTIFY channel). */
interface TopicSubscription {
  topic: Topic;
  /**
   * Every handler subscribed to this NOTIFY channel; a repeat `subscribe(topic, …)` appends
   * (matching bridge-xmpp) so a second subscribe doesn't silently replace the first. The channel
   * is drained once per notification and fanned out to all handlers, so the `lastSeen`/coalescing
   * bookkeeping stays shared per channel.
   */
  handlers: MessageHandler[];
  /** Highest seq already delivered (as text — BIGINT round-trips as a string). */
  lastSeen: string;
  /** In-flight guard: at most one drain loop per topic at a time. */
  draining: boolean;
  /** A notification arrived mid-drain — run the drain once more before going idle. */
  pending: boolean;
  /** Armed backoff re-drain after a failed drain read; cleared once one succeeds. */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Gap the next re-drain will use — doubles per consecutive failure, reset by a success. */
  retryDelayMs?: number;
}

/**
 * The PostgreSQL backend (DESIGN §9). A NOTIFY is only a doorbell: keep every subscriber and
 * blocking waiter re-querying strictly after its last-seen `seq`, so that a coalesced, dropped or
 * mis-addressed notification costs latency and never a message (DESIGN §6).
 */
export class PostgresPlugin implements BackendPlugin {
  private pool?: Pool;
  /**
   * Armed synchronously by `connect()` before its first await. `this.pool` is only published after
   * the awaited bootstrap, so two concurrent `connect()`s would both pass a `pool === undefined`
   * guard, both bootstrap, and both assign — stranding the loser's pool and prune timer with no
   * caller reference left to reclaim them.
   */
  private connecting = false;
  private url = DEFAULT_URL;
  private table = 'parley_messages';
  /** Relation names already double-quoted — the only spelling that may reach SQL text. */
  private names: SchemaNames = quotedNames('parley_messages');
  private retentionDays?: number;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  /**
   * Bumped by every `disconnect()`. Compare it, not `stopped`, after any await in a chore that
   * mutates shared state — `connect()` sets `stopped` back to false, so a chore that slept across
   * a whole teardown/restart sees `stopped === false` and would publish into the NEW lifecycle.
   */
  private epoch = 0;

  /** Dedicated non-pool LISTEN connection, shared by all topics; lazy on first subscribe. */
  private listener?: Client;
  private listenerPromise?: Promise<Client>;
  private reconnecting = false;
  private readonly subs = new Map<string, TopicSubscription>();
  /**
   * Channels whose first `subscribe` is still mid-flight, so a concurrent `subscribe` to the same
   * topic joins that one instead of building a second {@link TopicSubscription} that overwrites it.
   */
  private readonly subscribing = new Map<string, Promise<TopicSubscription>>();

  /**
   * Blocking `fetchRecent` waiters keyed by NOTIFY channel. A waiter parks on the
   * SAME doorbell `subscribe` waits on — the AFTER INSERT trigger's `pg_notify` — so a blocked
   * fetch wakes the instant a matching row lands. The channel is LISTENed for the wait's duration
   * (piggybacking a live subscription's LISTEN when one exists) and UNLISTENed once the last
   * waiter for it leaves; the notification handler fans a NOTIFY out to every registered wake.
   */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Established (or in-flight) LISTENs by channel — see {@link acquireListen}. */
  private readonly listens = new Map<string, ListenState>();
  /**
   * Every in-flight blocking-fetch wait's release callback, fired on `disconnect()` so a blocked
   * `fetchRecent` returns immediately with no leaked timer — the same teardown discipline the
   * listener connection gets.
   */
  private readonly pendingAborts = new Set<() => void>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = validateBackendConfig(config);
    if (this.pool !== undefined || this.connecting) {
      throw new Error(
        'parley-postgres: already connected (or a connect() is still in flight) — call ' +
          'disconnect() first. A second connect() would strand the previous pool and prune timer ' +
          'with no way for the caller to reclaim them',
      );
    }
    this.connecting = true;
    try {
      await this.open(cfg);
    } finally {
      this.connecting = false;
    }
  }

  private async open(cfg: PostgresBackendConfig): Promise<void> {
    this.url = cfg.url ?? DEFAULT_URL;
    this.table = assertTableName(cfg.table_name ?? 'parley_messages');
    this.names = quotedNames(this.table);
    this.retentionDays = cfg.retention_days;
    this.stopped = false;
    const epoch = this.epoch;

    if (usesDefaultCredentials(this.url)) {
      console.warn(
        '[parley-postgres] SECURITY: connecting with the repo-public default credentials ' +
          "('postgres://parley:parley@…'). Set backend_config.url to a real connection string; a " +
          'network-reachable database provisioned with these credentials is world-readable/injectable.',
      );
    }

    const pool = new Pool({ connectionString: this.url, max: cfg.pool_size ?? DEFAULT_POOL_SIZE });
    // Keep this no-op handler, so that an idle-client error (server restart) stays a rejected
    // command instead of an unhandled 'error' event that kills the process.
    pool.on('error', () => undefined);

    // Idempotent bootstrap, serialized under an advisory lock: concurrent bridge processes
    // connecting to the same table would otherwise race the CREATEs.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.table]);
      await client.query(buildSchema(this.table));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end().catch(() => undefined);
      throw lockWaitAbandoned(`bootstrap lock on table '${this.table}'`, err);
    }
    client.release();
    // Same hazard the listener has, one resource up: a disconnect() can complete while the
    // bootstrap is in flight. Publishing the pool after that leaves a live pool — and, below, a
    // prune timer — attached to a plugin the caller has already shut down.
    if (this.stopped || epoch !== this.epoch) {
      await pool.end().catch(() => undefined);
      throw new Error('parley-postgres: disconnected while connect() was in flight');
    }
    this.pool = pool;

    if (this.retentionDays !== undefined) {
      const tick = (): void => {
        void this.prune().catch(() => undefined);
      };
      tick();
      // Keep the unref, so a leaked-but-never-disconnect()ed plugin cannot by itself pin the
      // event loop — pruning is a best-effort cost knob, not a reason to keep the process alive.
      this.pruneTimer = setInterval(tick, PRUNE_INTERVAL_MS).unref();
    }
  }

  /**
   * Delete rows older than `retention_days`, {@link PRUNE_BATCH} rows per statement. The first
   * prune after an operator enables retention on a long-lived table can have millions of rows to
   * remove; keep it batched, so that it cannot become one transaction whose WAL volume and
   * long-held snapshot grow with the whole backlog — a snapshot that old holds vacuum off every
   * table in the database for as long as it runs. Best-effort — a transient failure retries next
   * tick. Keep the whole body inside the try, so that no arithmetic on an operator-supplied window
   * can escape this un-awaited call as an unhandled rejection and take the process down.
   *
   * Keep both sides of the comparison server-side — `created_at` is stamped by the database and the
   * cutoff is subtracted from the database's `now()` — so that no bridge's wall clock takes part.
   * `ts` is written by whichever process called `post()`, and this is the multi-machine backend: a
   * writer running ten days slow would otherwise have every message it durably acknowledged deleted
   * by the next correct-clock pruner, and one running fast would write rows retention can never
   * remove.
   */
  private async prune(): Promise<void> {
    if (this.retentionDays === undefined || this.pool === undefined) return;
    const epoch = this.epoch;
    const windowSecs = this.retentionDays * 86_400;
    try {
      for (;;) {
        if (this.stopped || this.pool === undefined || epoch !== this.epoch) return;
        const res = await this.pool.query(
          `DELETE FROM ${this.names.messages} WHERE seq IN (
             SELECT seq FROM ${this.names.messages}
             WHERE created_at < now() - make_interval(secs := $1::double precision)
             ORDER BY seq LIMIT ${PRUNE_BATCH}
           )`,
          [windowSecs],
        );
        if ((res.rowCount ?? 0) < PRUNE_BATCH) return;
      }
    } catch {}
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.epoch++;
    this.reconnecting = false;
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    // Release any blocked fetchRecent waits first — clears their timers deterministically. Each
    // callback removes itself from `pendingAborts`/`waiters`; iterate a copy so that's safe.
    for (const abort of [...this.pendingAborts]) abort();
    this.pendingAborts.clear();
    this.waiters.clear();
    this.listens.clear();
    for (const sub of this.subs.values()) this.clearRedrain(sub);
    this.subs.clear();
    this.subscribing.clear();
    const listener = this.listener;
    this.listener = undefined;
    this.listenerPromise = undefined;
    if (listener !== undefined) await listener.end().catch(() => undefined);
    const pool = this.pool;
    this.pool = undefined;
    if (pool !== undefined) await pool.end().catch(() => undefined);
  }

  /**
   * Single durable write path (DESIGN §4/§7). BIGSERIAL assigns `seq` at INSERT time, not
   * COMMIT time, so under concurrent writers a larger seq can become visible BEFORE a smaller
   * one commits — a reader that advanced its cursor past the gap would then skip the
   * late-committing row forever. Cursor delivery must be monotonic and lossless (DESIGN §6),
   * so same-topic posts are serialized with a transaction-scoped advisory lock: writes to a
   * topic commit in seq order, making visibility order == cursor order. Distinct topics take
   * distinct lock keys and don't contend. First sight of a handle registers it in the sender
   * registry (DESIGN §4), before the lock is taken.
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    assertStorable('topic', topic);
    assertStorable('handle', identity);
    assertStorable('content', content);
    if (opts?.inReplyTo !== undefined) assertStorable('inReplyTo', opts.inReplyTo);
    const client = await this.require().connect();
    try {
      // Keep the registry upsert OUTSIDE the transaction below, so that it cannot lengthen the
      // advisory-locked critical section every same-topic post from every bridge process queues
      // behind. `DO NOTHING` is what makes it safe to run unconditionally and out of band: it never
      // overwrites a `backend_ref` an operator registered by hand.
      await client.query(
        `INSERT INTO ${this.names.senders} (handle, backend_ref)
         VALUES ($1, $1) ON CONFLICT (handle) DO NOTHING`,
        [identity],
      );
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [topic]);
      const res = await client.query(
        `INSERT INTO ${this.names.messages} (topic, sender, content, ts, in_reply_to)
         VALUES ($1, $2, $3, $4, $5) RETURNING seq::text AS seq`,
        [topic, identity, content, new Date().toISOString(), opts?.inReplyTo ?? null],
      );
      await client.query('COMMIT');
      return asBackendMsgId(String((res.rows[0] as { seq: string }).seq));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw lockWaitAbandoned(`write lock on topic '${topic}'`, err);
    } finally {
      client.release();
    }
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    assertStorable('topic', args.topic);
    const limit = args.limit ?? 100;
    // NB: ORDER BY is table-qualified everywhere — a bare `ORDER BY seq` would bind to the
    // `seq::text AS seq` OUTPUT alias and sort lexicographically ('9' > '10'), not numerically.
    if (args.since === undefined) {
      // Default window: the most recent `limit` messages, returned ascending by cursor. With no
      // cursor to advance past there is nothing to block on, so `blockMs` is ignored here.
      const res = await this.require().query(
        `SELECT seq::text AS seq, topic, sender, content, ts, in_reply_to
         FROM ${this.names.messages} WHERE topic = $1 ORDER BY ${this.names.messages}.seq DESC LIMIT $2`,
        [args.topic, limit],
      );
      return this.pageResult((res.rows as MessageRow[]).reverse(), args);
    }

    assertCursor(args.since);
    // Exclusive: strictly after `since`, ascending.
    let rows = await this.exclusiveSince(args.topic, args.since, limit);
    // Native long-poll: only when the exclusive `since` query came back EMPTY and the
    // caller asked to block. Wait on the topic's NOTIFY channel up to the remaining budget, then
    // re-run the SAME exclusive query. Returning early/empty stays safe — core's generic wrapper
    // polls the remaining budget — so the native wait only ever SHORTENS latency, never extends it.
    if (rows.length === 0 && (args.blockMs ?? 0) > 0 && !this.stopped) {
      await this.waitForNotify(args.topic, args.since, limit, args.blockMs as number);
      if (!this.stopped) rows = await this.exclusiveSince(args.topic, args.since, limit);
    }
    return this.pageResult(rows, args);
  }

  /** The canonical exclusive `since` read: strictly after `since`, ascending by cursor. */
  private async exclusiveSince(topic: Topic, since: Cursor, limit: number): Promise<MessageRow[]> {
    const res = await this.require().query(
      `SELECT seq::text AS seq, topic, sender, content, ts, in_reply_to
       FROM ${this.names.messages} WHERE topic = $1 AND seq > $2::bigint ORDER BY ${this.names.messages}.seq ASC LIMIT $3`,
      [topic, since, limit],
    );
    return res.rows as MessageRow[];
  }

  /** Shape rows into a page; an empty page holds `nextCursor` at `since` (stable at timeout). */
  private pageResult(rows: MessageRow[], args: FetchRecentArgs): FetchRecentResult {
    const messages = rows.map(rowToMessage);
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor('0'));
    return { messages, nextCursor };
  }

  /**
   * Park up to `blockMs` waiting for a NOTIFY on `topic`'s channel, then return so the
   * caller can re-run the exclusive `since` query. Reuses the live primitive — the AFTER INSERT
   * trigger's `pg_notify`, the same doorbell `subscribe` waits on:
   *   - If a `subscribe` (or an earlier waiter) already holds the channel, PIGGYBACK on its LISTEN
   *     — but only once that LISTEN is ESTABLISHED ({@link acquireListen}), never merely intended.
   *   - Otherwise LISTEN for the wait's duration and UNLISTEN once the last participant leaves.
   * Any wake (a matching NOTIFY), the `blockMs` timer, or `disconnect()` releases the wait; the
   * timer is always cleared, so nothing leaks. Once the waiter is registered we re-check
   * `exclusiveSince` ONCE: a row that landed between the caller's initial empty query
   * and this LISTEN never notified us, so without this the wait would stall to the timeout — the
   * re-check makes the waiter live across the LISTEN snapshot window and wakes it promptly.
   */
  private async waitForNotify(
    topic: Topic,
    since: Cursor,
    limit: number,
    blockMs: number,
  ): Promise<void> {
    const epoch = this.epoch;
    let listener: Client;
    try {
      listener = await this.ensureListener(Math.min(blockMs, LISTENER_WAIT_MS));
    } catch {
      return; // listener unavailable → skip the native wait; core polls the remaining budget
    }
    if (this.stopped || epoch !== this.epoch) return;
    const channel = channelFor(topic);

    let listen: ListenState;
    try {
      listen = await this.acquireListen(listener, channel);
    } catch {
      return; // LISTEN failed → skip the native wait; core polls the remaining budget
    }
    let waiters = this.waiters.get(channel);
    if (waiters === undefined) {
      waiters = new Set();
      this.waiters.set(channel, waiters);
    }
    const set = waiters;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pendingAborts.delete(finish);
        set.delete(finish);
        if (set.size === 0) this.waiters.delete(channel);
        this.releaseListen(channel, listen);
        resolve();
      };
      const timer = setTimeout(finish, blockMs);
      this.pendingAborts.add(finish);
      set.add(finish);
      if (this.stopped || epoch !== this.epoch) {
        finish(); // disconnect may have raced registration
        return;
      }
      // Snapshot-window re-check: catch a row that landed between the caller's empty read and the
      // LISTEN above, which sent no NOTIFY we'd hear. If it's there, wake now (caller re-queries);
      // otherwise stay parked. A failed re-check is harmless — the NOTIFY/timer still resolve us.
      void this.exclusiveSince(topic, since, limit)
        .then((recheck) => {
          if (recheck.length > 0) finish();
        })
        .catch(() => undefined);
    });
  }

  /**
   * Live path = LISTEN/NOTIFY (DESIGN §9 — genuine events, not a poll timer). One dedicated
   * non-pool listener connection is shared by every topic; the AFTER INSERT trigger rings
   * channel `parley_<md5(topic)>` and the notification handler drains `seq > lastSeen` off the
   * pool. Starts at the current max seq (history is owned by catch-up, not push); both the
   * tail and the LISTEN are established BEFORE this resolves, so nothing posted afterwards can
   * fall between them. If the listener connection drops, a backoff loop reconnects, re-LISTENs
   * every channel, and re-drains each topic from its cursor — closing the notification gap
   * (best-effort push over a durable cursor, DESIGN §6). `disconnect()` ends the listener,
   * cancelling all subscriptions.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    assertStorable('topic', topic);
    const pool = this.require();
    const channel = channelFor(topic);

    // Repeat subscribe on the same topic: append to the channel's handler list (matching
    // bridge-xmpp) — the channel is already LISTENed and drained, so the new handler just joins
    // the fan-out from here on (push never replays history). Keep both the live and the in-flight
    // lookup ahead of the first await, so that two concurrent subscribes to one topic cannot both
    // miss it and have the second overwrite the first's registration.
    const live = this.subs.get(channel);
    if (live !== undefined) {
      live.handlers.push(handler);
      return;
    }
    const inFlight = this.subscribing.get(channel);
    if (inFlight !== undefined) {
      (await inFlight).handlers.push(handler);
      return;
    }

    const started = this.startSubscription(pool, topic, channel, handler).catch((err: unknown) => {
      throw subscribeFailed(topic, err);
    });
    this.subscribing.set(channel, started);
    try {
      await started;
    } finally {
      // Delete only OUR entry, so that a subscribe spanning a disconnect()/connect() cannot evict
      // the registration a successor lifecycle put here under the same channel name.
      if (this.subscribing.get(channel) === started) this.subscribing.delete(channel);
    }
  }

  /** Tail read → LISTEN → register, for a channel nothing is subscribed to yet. */
  private async startSubscription(
    pool: Pool,
    topic: Topic,
    channel: string,
    handler: MessageHandler,
  ): Promise<TopicSubscription> {
    const epoch = this.epoch;
    const listener = await this.ensureListener();
    // Tail first: push never replays history (catch-up owns it).
    const res = await pool.query(
      `SELECT COALESCE(MAX(seq), 0)::text AS max FROM ${this.names.messages} WHERE topic = $1`,
      [topic],
    );
    const sub: TopicSubscription = {
      topic,
      handlers: [handler],
      lastSeen: (res.rows[0] as { max: string }).max,
      draining: false,
      pending: false,
    };
    // Keep the LISTEN ahead of the registration, so that a rejected LISTEN leaves no entry in
    // `this.subs` — otherwise the next reconnect re-LISTENs and re-drains a channel the caller was
    // told FAILED to subscribe. It also covers the tail-read → LISTEN window: a row committed in
    // it has seq > lastSeen, so the drain below still catches it.
    const listen = await this.acquireListen(listener, channel);
    // Registering here after a teardown is worse than failing: the entry survives into the next
    // connect(), where subscribe()'s fast path hands it back and no LISTEN is ever issued, so push
    // is silently dead for that topic.
    if (this.stopped || epoch !== this.epoch) {
      this.releaseListen(channel, listen);
      throw new Error('parley-postgres: disconnected while subscribe() was in flight');
    }
    this.subs.set(channel, sub);
    this.drain(sub);
    return sub;
  }

  /**
   * Sender registry lookup (DESIGN §4). Postgres is a self-hosted local-convention backend —
   * no provisioned accounts — so an unknown handle is registered on first sight with
   * `backendRef === handle`.
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    assertStorable('handle', handle);
    const res = await this.require().query(
      `SELECT backend_ref FROM ${this.names.senders} WHERE handle = $1`,
      [handle],
    );
    const row = res.rows[0] as { backend_ref: string } | undefined;
    if (row !== undefined) return { handle, backendRef: row.backend_ref };
    await this.require().query(
      `INSERT INTO ${this.names.senders} (handle, backend_ref)
       VALUES ($1, $1) ON CONFLICT (handle) DO NOTHING`,
      [handle],
    );
    return { handle, backendRef: handle };
  }

  /**
   * Take a reference on the channel's LISTEN, resolving only once that LISTEN is ESTABLISHED.
   * Later participants await the SAME promise the first one created rather than assuming a
   * LISTEN exists: publishing "someone intends to LISTEN" as if it were "the channel is
   * LISTENed" strands every piggybacking waiter on a doorbell that may never be installed.
   * Rejects (having taken no reference) if the LISTEN failed, so the caller can fall back.
   */
  private async acquireListen(listener: Client, channel: string): Promise<ListenState> {
    const existing = this.listens.get(channel);
    if (existing !== undefined) {
      existing.refs++;
      try {
        await existing.ready;
      } catch (err) {
        this.releaseListen(channel, existing);
        throw err;
      }
      return existing;
    }
    const entry: ListenState = {
      ready: listener.query(`LISTEN "${channel}"`).then(() => undefined),
      refs: 1,
    };
    this.listens.set(channel, entry);
    try {
      await entry.ready;
    } catch (err) {
      if (this.listens.get(channel) === entry) this.listens.delete(channel);
      throw err;
    }
    return entry;
  }

  /** Drop one reference; UNLISTEN once no subscription or waiter needs the channel. */
  private releaseListen(channel: string, entry: ListenState): void {
    if (this.listens.get(channel) !== entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.listens.delete(channel);
    if (!this.stopped && this.listener !== undefined) {
      void this.listener.query(`UNLISTEN "${channel}"`).catch(() => undefined);
    }
  }

  /**
   * The shared LISTEN connection: created lazily on first subscribe, and REPLACED by the backoff
   * reconnect after a drop. Keep the memo pointing at the reconnect that is in flight rather than
   * at the client whose socket just closed, so that a `subscribe` issued during the blackout waits
   * for the replacement and then succeeds — handed the dead client it is guaranteed to fail, and
   * core's push loop rethrows that, so the whole bridge fails to come up. The wait is bounded, so
   * an outage that outlasts `budgetMs` is a named error rather than a call that never settles.
   */
  private ensureListener(budgetMs = LISTENER_WAIT_MS): Promise<Client> {
    if (this.listenerPromise === undefined) {
      const attempt: Promise<Client> = this.createListener().catch((err: unknown) => {
        if (this.listenerPromise === attempt) this.listenerPromise = undefined;
        throw err;
      });
      this.listenerPromise = attempt;
    }
    return withDeadline(
      this.listenerPromise,
      budgetMs,
      () => new Error(`the listener connection did not come up within ${budgetMs}ms`),
    );
  }

  private async createListener(): Promise<Client> {
    const epoch = this.epoch;
    const client = new Client({ connectionString: this.url });
    this.wireListener(client);
    await client.connect();
    return this.adoptListener(client, epoch);
  }

  /**
   * The one place a freshly connected candidate becomes `this.listener`. Keep EVERY path that
   * opens a listener socket going through here, so that a `disconnect()` which completed while
   * the connect was in flight cannot leave a live pg connection attached to a stopped plugin —
   * an orphan keeps the Node event loop referenced and holds a server backend slot for as long
   * as the process runs.
   */
  private async adoptListener(client: Client, epoch: number): Promise<Client> {
    if (this.stopped || epoch !== this.epoch) {
      await client.end().catch(() => undefined);
      throw new Error('parley-postgres: disconnected while the listener connection was in flight');
    }
    this.listener = client;
    return client;
  }

  /** Attach notification + failure handlers to a (candidate) listener connection. */
  private wireListener(client: Client): void {
    client.on('error', () => {
      /* Keep this swallow, so that a socket error cannot kill the process; 'end' follows it and
         drives the reconnect. */
    });
    client.on('notification', (n) => {
      const sub = this.subs.get(n.channel);
      // Payload is a hint only (size limits + best-effort delivery) — always re-query.
      if (sub !== undefined) this.drain(sub);
      // Wake any blocking fetchRecent parked on this channel; each re-runs its own
      // exclusive `since` query. A spurious wake only ends a wait early — safe, core re-polls.
      const set = this.waiters.get(n.channel);
      if (set !== undefined) for (const wake of [...set]) wake();
    });
    client.on('end', () => {
      if (!this.stopped && this.listener === client) {
        void this.reconnectListener().catch(() => undefined);
      }
    });
  }

  /**
   * Backoff loop: new connection, re-LISTEN every channel, then re-drain every topic from its
   * `lastSeen` — anything posted while we were dark is picked up by the drain, so a lost
   * notification window costs latency, never a message.
   */
  private async reconnectListener(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const epoch = this.epoch;
    let landed!: (client: Client) => void;
    let abandoned!: (err: unknown) => void;
    const replacement = new Promise<Client>((resolve, reject) => {
      landed = resolve;
      abandoned = reject;
    });
    // Keep this handler, so that a reconnect abandoned with no seam call waiting on it is not an
    // unhandled rejection that takes the process down.
    replacement.catch(() => undefined);
    this.listenerPromise = replacement;
    let adopted = false;
    try {
      while (!this.stopped && epoch === this.epoch) {
        await delay(RECONNECT_DELAY_MS);
        if (this.stopped || epoch !== this.epoch) return;
        const client = new Client({ connectionString: this.url });
        this.wireListener(client);
        try {
          await client.connect();
          if (this.stopped || epoch !== this.epoch) {
            await client.end().catch(() => undefined);
            return;
          }
          // Re-LISTEN every channel a subscription OR an in-flight blocking waiter needs, so a
          // reconnect mid-wait still delivers the doorbell.
          const listened: string[] = [];
          for (const channel of this.listens.keys()) {
            await client.query(`LISTEN "${channel}"`);
            listened.push(channel);
          }
          await this.adoptListener(client, epoch);
          // The loop above awaits, and a waiter's blockMs can expire inside it: that release has
          // already dropped the channel with no live connection to send its UNLISTEN to. Keep this
          // reconciliation, so that the replacement is not left registered for a channel no
          // participant needs — every future post to that topic would wake the process forever.
          for (const channel of listened) {
            if (!this.listens.has(channel)) {
              void client.query(`UNLISTEN "${channel}"`).catch(() => undefined);
            }
          }
          landed(client);
          adopted = true;
          for (const sub of this.subs.values()) this.drain(sub);
          return;
        } catch {
          await client.end().catch(() => undefined);
          // server still unreachable — back off and try again
        }
      }
    } finally {
      // A loop that gave up must settle the memo every waiting seam call is parked on, and clear
      // it, so that a later subscribe starts a fresh listener instead of awaiting a dead promise.
      if (!adopted) {
        abandoned(new Error('the listener reconnect was abandoned by disconnect()'));
        if (this.listenerPromise === replacement) this.listenerPromise = undefined;
      }
      // Keep the flag owned by the lifecycle that set it, so that this loop exiting after a
      // disconnect() cannot clear a successor lifecycle's reconnect and let two run at once.
      if (epoch === this.epoch) this.reconnecting = false;
    }
  }

  /**
   * Drain everything after `lastSeen` for one topic, in ascending seq order. At most one drain
   * runs per topic (`draining` flag); a notification landing mid-drain sets `pending` so the
   * loop runs once more instead of racing a second drain past the first.
   */
  private drain(sub: TopicSubscription): void {
    if (sub.draining) {
      sub.pending = true;
      return;
    }
    sub.draining = true;
    this.clearRedrain(sub);
    const epoch = this.epoch;
    void (async () => {
      try {
        do {
          sub.pending = false;
          for (;;) {
            if (this.stopped || epoch !== this.epoch) return;
            const res = await this.require().query(
              `SELECT seq::text AS seq, topic, sender, content, ts, in_reply_to
               FROM ${this.names.messages} WHERE topic = $1 AND seq > $2::bigint
               ORDER BY ${this.names.messages}.seq ASC LIMIT ${DRAIN_BATCH}`,
              [sub.topic, sub.lastSeen],
            );
            // `pool.end()` waits for this read, so a teardown that began while it was in flight is
            // only observable HERE. Keep the re-check, so that a subscription `disconnect()` has
            // already dropped cannot deliver one last batch into a handler on its way out.
            if (this.stopped || epoch !== this.epoch) return;
            const rows = res.rows as MessageRow[];
            if (rows.length === 0) break;
            for (const row of rows) {
              sub.lastSeen = String(row.seq);
              const msg = rowToMessage(row);
              // Keep each handler in its own try/catch, so that one throwing handler cannot starve
              // the others on this channel (DESIGN §6).
              for (const handler of sub.handlers) {
                try {
                  handler(msg);
                } catch {}
              }
            }
          }
        } while (sub.pending && !this.stopped && epoch === this.epoch);
        sub.retryDelayMs = undefined;
      } catch {
        this.scheduleRedrain(sub, epoch);
      } finally {
        sub.draining = false;
      }
    })();
  }

  /**
   * Re-arm a failed drain on a doubling backoff. A NOTIFY is an EDGE: the drain that swallowed the
   * failure leaves `lastSeen` behind a row that is already durably stored, and nothing guarantees a
   * later post to the same topic — or a listener drop — ever rings the doorbell again, so without
   * this the batch is dropped from the live path for good. Keep the arming epoch-guarded, so that a
   * drain read rejecting after `disconnect()` cannot install a timer that outlives the lifecycle and
   * fans a batch out to a torn-down session's handlers.
   */
  private scheduleRedrain(sub: TopicSubscription, epoch: number): void {
    if (this.stopped || epoch !== this.epoch || sub.retryTimer !== undefined) return;
    const delayMs = sub.retryDelayMs ?? DRAIN_RETRY_BASE_MS;
    sub.retryDelayMs = Math.min(delayMs * 2, DRAIN_RETRY_CEILING_MS);
    // Keep the unref, so a database that stays down cannot by itself pin the event loop — push is
    // best-effort over a durable cursor, not a reason to keep the process alive.
    sub.retryTimer = setTimeout(() => {
      sub.retryTimer = undefined;
      this.drain(sub);
    }, delayMs).unref();
  }

  private clearRedrain(sub: TopicSubscription): void {
    if (sub.retryTimer !== undefined) clearTimeout(sub.retryTimer);
    sub.retryTimer = undefined;
  }

  private require(): Pool {
    if (this.pool === undefined) {
      throw new Error('PostgresPlugin not connected — call connect() first');
    }
    return this.pool;
  }
}

function rowToMessage(row: MessageRow): Message {
  return buildMessage({
    topic: asTopic(row.topic),
    sender: row.sender,
    content: row.content,
    timestamp: row.ts,
    id: String(row.seq),
  });
}
