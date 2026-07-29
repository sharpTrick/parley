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
import {
  assertTableName,
  badConfig,
  buildSchema,
  channelFor,
  MAX_TABLE_NAME_BYTES,
  type MessageRow,
  quotedNames,
  type SchemaNames,
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
   * Optional retention window in days: rows older than this are pruned on a background timer.
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
const MIN_POOL_SIZE = 1;
const MAX_POOL_SIZE = 1000;
/** How many rows one drain query pulls at most before re-querying. */
const DRAIN_BATCH = 512;
/** Backoff between listener reconnect attempts after the connection drops. */
const RECONNECT_DELAY_MS = 500;
/** Pruning cadence when `retention_days` is set — a cost knob only, like the pool size. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const CONFIG_KEYS = ['url', 'table_name', 'pool_size', 'retention_days'] as const;
/** Rows one prune statement may delete, so retention never issues one unbounded table-wide DELETE. */
const PRUNE_BATCH = 5000;

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
      throw new Error(
        `parley-postgres: unknown backend_config key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
      );
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
  if (retention !== undefined && (typeof retention !== 'number' || !(retention > 0))) {
    throw badConfig(
      'retention_days',
      `expected a number > 0, got ${describeValue(retention)} — 0 or negative would delete the ` +
        `whole history; omit the key to keep every message forever`,
    );
  }
  if (typeof retention === 'number' && !Number.isFinite(retention)) {
    throw badConfig('retention_days', `expected a finite number, got ${describeValue(retention)}`);
  }

  return cfg as PostgresBackendConfig;
}

/** True when the DSN carries the repo-public `parley:parley` pair, whatever host/port/database. */
export function usesDefaultCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      decodeURIComponent(parsed.username) === DEFAULT_USER &&
      decodeURIComponent(parsed.password) === DEFAULT_PASSWORD
    );
  } catch {
    return false;
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
}

/**
 * The PostgreSQL backend (DESIGN §9). A NOTIFY is only a doorbell: keep every subscriber and
 * blocking waiter re-querying strictly after its last-seen `seq`, so that a coalesced, dropped or
 * mis-addressed notification costs latency and never a message (DESIGN §6).
 */
export class PostgresPlugin implements BackendPlugin {
  private pool?: Pool;
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
    if (this.pool !== undefined) {
      throw new Error(
        'parley-postgres: already connected — call disconnect() first. A second connect() would ' +
          'strand the previous pool and prune timer with no way for the caller to reclaim them',
      );
    }
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

    const pool = new Pool({ connectionString: this.url, max: cfg.pool_size ?? 5 });
    // Keep this no-op handler, so that an idle-client error (server restart) stays a rejected
    // command instead of an unhandled 'error' event that kills the process.
    pool.on('error', () => undefined);

    // Idempotent bootstrap, serialized under an advisory lock: concurrent bridge processes
    // connecting to the same table would otherwise race the CREATEs.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.table]);
      await client.query(buildSchema(this.table));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end().catch(() => undefined);
      throw err;
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
   * remove; keep it batched, so that it cannot become one long DELETE holding row locks while
   * every advisory-lock-serialized `post()` queues behind it. Best-effort — a transient failure
   * retries next tick. Keep the whole body inside the try, so that no arithmetic on an
   * operator-supplied window can escape this un-awaited call as an unhandled rejection and take
   * the process down.
   */
  private async prune(): Promise<void> {
    if (this.retentionDays === undefined || this.pool === undefined) return;
    const epoch = this.epoch;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
      for (;;) {
        if (this.stopped || this.pool === undefined || epoch !== this.epoch) return;
        const res = await this.pool.query(
          `DELETE FROM ${this.names.messages} WHERE seq IN (
             SELECT seq FROM ${this.names.messages} WHERE ts < $1 ORDER BY seq LIMIT ${PRUNE_BATCH}
           )`,
          [cutoff],
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
      throw err;
    } finally {
      client.release();
    }
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
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
      listener = await this.ensureListener();
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
    // disconnect() may have completed while LISTEN was in flight.
    if (this.stopped || epoch !== this.epoch) {
      this.releaseListen(channel, listen);
      return;
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

    const started = this.startSubscription(pool, topic, channel, handler);
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

  /** Lazily create the shared LISTEN connection on first subscribe. */
  private ensureListener(): Promise<Client> {
    if (this.listenerPromise === undefined) {
      this.listenerPromise = this.createListener().catch((err: unknown) => {
        this.listenerPromise = undefined; // let a later subscribe retry
        throw err;
      });
    }
    return this.listenerPromise;
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
          for (const channel of this.listens.keys()) {
            await client.query(`LISTEN "${channel}"`);
          }
          await this.adoptListener(client, epoch);
          if (epoch === this.epoch) this.listenerPromise = Promise.resolve(client);
          for (const sub of this.subs.values()) this.drain(sub);
          return;
        } catch {
          await client.end().catch(() => undefined);
          // server still unreachable — back off and try again
        }
      }
    } finally {
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
      } catch {
        // Transient query failure — the next NOTIFY (or the reconnect re-drain) resumes from
        // `lastSeen`; the cursor guarantees nothing is skipped.
      } finally {
        sub.draining = false;
      }
    })();
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
