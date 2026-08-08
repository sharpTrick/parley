import {
  asBackendMsgId,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { Pool, type PoolClient } from 'pg';
import {
  DIAL_WAIT_MS,
  endWithin,
  QUERY_WAIT_MS,
  SOCKET_BOUNDS,
  TEARDOWN_WAIT_MS,
} from './connection.js';
import {
  DEFAULT_POOL_SIZE,
  DEFAULT_TABLE_NAME,
  DEFAULT_URL,
  type PostgresBackendConfig,
  usesDefaultCredentials,
  validateBackendConfig,
} from './config.js';
import {
  answerAbandoned,
  answerNeverCame,
  assertCursor,
  assertStorable,
  dialAbandoned,
  LOCK_WAIT_MS,
  lockWaitAbandoned,
  subscribeFailed,
} from './errors.js';
import { PostgresListen } from './listen.js';
import { LISTENER_WAIT_MS } from './listener.js';
import type { TopicSubscription } from './push.js';
import { newestMessages, pageResult } from './read.js';
import { assertTableName, buildSchema, channelFor, quotedNames } from './schema.js';

export { MAX_POOL_SIZE, MAX_RETENTION_DAYS, MIN_POOL_SIZE, MIN_RETENTION_DAYS } from './config.js';
export { DEFAULT_POOL_SIZE, LOCK_WAIT_MS, type PostgresBackendConfig, usesDefaultCredentials };
export { LISTENER_WAIT_MS, validateBackendConfig };

/** Pruning cadence when `retention_days` is set — a cost knob only, like the pool size. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Rows one prune statement may delete, so retention never issues one unbounded table-wide DELETE. */
export const PRUNE_BATCH = 5000;

/**
 * The PostgreSQL backend (DESIGN §9). A NOTIFY is only a doorbell: keep every subscriber and
 * blocking waiter re-querying strictly after its last-seen `seq`, so that a coalesced, dropped or
 * mis-addressed notification costs latency and never a message (DESIGN §6).
 */
export class PostgresPlugin extends PostgresListen implements BackendPlugin {
  /**
   * Armed synchronously by `connect()` before its first await, so that two concurrent `connect()`s
   * cannot both pass a `pool === undefined` guard — `this.pool` is only published after the awaited
   * bootstrap, and the loser's pool and prune timer would be stranded with no caller reference.
   */
  private connecting = false;

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
    const table = assertTableName(cfg.table_name ?? DEFAULT_TABLE_NAME);
    this.names = quotedNames(table);
    this.retentionDays = cfg.retention_days;
    this.stopped = false;

    if (usesDefaultCredentials(this.url)) {
      console.warn(
        '[parley-postgres] SECURITY: connecting with the repo-public default credentials ' +
          "('postgres://parley:parley@…'). Set backend_config.url to a real connection string; a " +
          'network-reachable database provisioned with these credentials is world-readable/injectable.',
      );
    }

    const pool = new Pool({
      connectionString: this.url,
      max: cfg.pool_size ?? DEFAULT_POOL_SIZE,
      ...SOCKET_BOUNDS,
    });
    // Keep this no-op handler, so that an idle-client error (server restart) stays a rejected
    // command instead of an unhandled 'error' event that kills the process.
    pool.on('error', () => undefined);
    // And keep this one, so that the same is true while a client is CHECKED OUT: pg-pool detaches
    // its own listener for the length of a checkout and routes nothing to the pool, so an RST
    // arriving mid-post() is an 'error' event with nothing listening — which Node turns into an
    // uncaughtException, not a rejected command.
    pool.on('connect', (client) => client.on('error', () => undefined));

    // Idempotent bootstrap, serialized under an advisory lock: concurrent bridge processes
    // connecting to the same table would otherwise race the CREATEs.
    this.starting.add(pool);
    const client = await this.bootstrapCheckout(pool);
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
      await client.query(buildSchema(table));
      await client.query('COMMIT');
    } catch (err) {
      // Keep the abandoned connection out of the pool rather than ROLLBACK-ing it back in: a
      // statement that failed because the answer never arrived leaves a ROLLBACK with nothing to
      // answer it either, and this pool is being ended anyway.
      client.release(true);
      this.starting.delete(pool);
      await endWithin(pool, TEARDOWN_WAIT_MS);
      const named = lockWaitAbandoned(`bootstrap lock on table '${table}'`, err);
      throw answerAbandoned(`the bootstrap of table '${table}'`, QUERY_WAIT_MS, named);
    }
    client.release();
    // Same hazard the listener has, one resource up: a disconnect() can complete while the
    // bootstrap is in flight, and it is the one that ends the pool it took out of `starting` —
    // publishing here after that leaves a live pool, a checked-out connection still holding the
    // bootstrap advisory lock, and below a prune timer, on a plugin the caller has already shut down.
    if (!this.starting.delete(pool)) {
      throw new Error('parley-postgres: disconnected while connect() was in flight');
    }
    this.pool = pool;

    if (this.retentionDays !== undefined) {
      const tick = (): void => void this.prune().catch(() => undefined);
      tick();
      // Keep the unref, so a leaked-but-never-disconnect()ed plugin cannot by itself pin the
      // event loop — pruning is a best-effort cost knob, not a reason to keep the process alive.
      this.pruneTimer = setInterval(tick, PRUNE_INTERVAL_MS).unref();
    }
  }

  /**
   * The bridge's very first checkout, on a pool nothing else holds a connection in — so it cannot
   * be queueing, and a wait here is a peer that is not answering. Bound it at {@link DIAL_WAIT_MS}
   * rather than leaving it to the pool's own (deliberately generous) acquire ceiling, so that an
   * unreachable database is a named failure in seconds instead of the one wait in this plugin that
   * a bridge's caller experiences as a server which never finishes starting.
   */
  private async bootstrapCheckout(pool: Pool): Promise<PoolClient> {
    const checkout = pool.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        checkout,
        new Promise<never>((_, reject) => {
          const late = (): void => reject(dialAbandoned('the first connection', DIAL_WAIT_MS));
          timer = setTimeout(late, DIAL_WAIT_MS);
        }),
      ]);
    } catch (err) {
      // Hand back a checkout that lands after the deadline, so that the `end()` below is not left
      // waiting on a connection this call has already stopped referencing.
      void checkout.then(
        (late) => late.release(true),
        () => undefined,
      );
      this.starting.delete(pool);
      await endWithin(pool, TEARDOWN_WAIT_MS);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Delete rows older than `retention_days`, {@link PRUNE_BATCH} rows per statement. Keep it
   * batched, so that the first prune on a long-lived table cannot become one transaction whose WAL
   * volume and long-held snapshot grow with the whole backlog — a snapshot that old holds vacuum
   * off every table in the database for as long as it runs. Best-effort — a transient failure
   * retries next tick. Keep the whole body inside the try, so that no arithmetic on an
   * operator-supplied window can escape this un-awaited call as an unhandled rejection.
   *
   * Keep both sides of the comparison server-side — `created_at` is stamped by the database and the
   * cutoff subtracted from the database's `now()` — so that no bridge's wall clock takes part. This
   * is the multi-machine backend: a writer running slow would otherwise have every message it
   * durably acknowledged deleted by the next correct-clock pruner.
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

  /**
   * Keep every close under ONE wall-clock deadline (DESIGN §7 — teardown is not allowed to be the
   * unbounded wait). A pg `end()` on a peer that stopped answering without closing the socket never
   * settles, and `cli.ts` wires SIGINT/SIGTERM to this: unbounded, the bridge ignores SIGTERM and
   * only SIGKILL removes it.
   */
  async disconnect(): Promise<void> {
    const deadline = Date.now() + TEARDOWN_WAIT_MS;
    const remaining = (): number => Math.max(0, deadline - Date.now());
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
    // Claim what a setup call has built but not published yet BEFORE awaiting anything, so that a
    // disconnect() landing inside connect()'s bootstrap or the listener's dial does not return
    // while a live pool still holds a connection and the bootstrap advisory lock, and so the call
    // it raced finds its slot gone and refuses to adopt a resource this teardown already ended.
    const inFlight = [...this.starting];
    this.starting.clear();
    const listener = this.listener;
    this.listener = undefined;
    this.listenerPromise = undefined;
    if (listener !== undefined) await endWithin(listener, remaining());
    const pool = this.pool;
    this.pool = undefined;
    if (pool !== undefined) await endWithin(pool, remaining());
    await Promise.all(inFlight.map((resource) => endWithin(resource, remaining())));
  }

  /**
   * Single durable write path (DESIGN §4/§7). BIGSERIAL assigns `seq` at INSERT time, not COMMIT
   * time, so under concurrent writers a larger seq can become visible BEFORE a smaller one commits
   * and a reader that advanced past the gap would skip the late-committing row forever. Keep
   * same-topic posts serialized with a transaction-scoped advisory lock, so that visibility order
   * == cursor order (DESIGN §6); distinct topics take distinct lock keys and don't contend.
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
      // behind.
      await this.registerSender(client, identity);
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [topic]);
      const res = await client.query(
        `INSERT INTO ${this.names.messages} (topic, sender, content, ts, in_reply_to)
         VALUES ($1, $2, $3, $4, $5) RETURNING seq::text AS seq`,
        [topic, identity, content, new Date().toISOString(), opts?.inReplyTo ?? null],
      );
      await client.query('COMMIT');
      const seq = asBackendMsgId(String((res.rows[0] as { seq: string }).seq));
      client.release();
      return seq;
    } catch (err) {
      if (answerNeverCame(err)) {
        // Discard rather than ROLLBACK, so that a client wedged behind a statement nothing will
        // ever answer does not go back in the pool — and because a ROLLBACK issued on it cannot
        // come back either. Only this arm: a lock timeout is documented contention on a healthy
        // connection, and destroying that one costs a handshake per refused write.
        client.release(true);
      } else {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      const named = lockWaitAbandoned(`write lock on topic '${topic}'`, err);
      throw answerAbandoned(`the write to topic '${topic}'`, QUERY_WAIT_MS, named);
    }
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    assertStorable('topic', args.topic);
    const epoch = this.epoch;
    const limit = args.limit ?? 100;
    if (args.since === undefined) {
      // Default window: the newest `limit` messages. With no cursor to advance past there is
      // nothing to block on, so `blockMs` is ignored here.
      return pageResult(await newestMessages(this.require(), this.names, args.topic, limit));
    }

    assertCursor(args.since);
    let rows = await this.readSince(args.topic, args.since, limit);
    // Native long-poll. Returning early/empty stays safe — core's generic wrapper polls the
    // remaining budget — so the native wait only ever SHORTENS latency, never extends it.
    if (rows.length === 0 && (args.blockMs ?? 0) > 0 && !this.stopped) {
      await this.waitForNotify(args.topic, args.since, limit, args.blockMs as number);
      // `epoch`, not `stopped` alone: a connect() sets `stopped` back to false, so a wait that slept
      // across a whole teardown/restart would re-resolve the pool and read the SUCCESSOR's table —
      // and hand this caller a `nextCursor` from a sequence its topic has never been read on.
      if (!this.stopped && epoch === this.epoch) {
        rows = await this.readSince(args.topic, args.since, limit);
      }
    }
    return pageResult(rows, args.since);
  }

  /**
   * Live path = LISTEN/NOTIFY (DESIGN §9 — genuine events, not a poll timer). One dedicated
   * non-pool listener connection is shared by every topic; the AFTER INSERT trigger rings channel
   * `parley_<md5(topic)>` and the notification handler drains `seq > lastSeen` off the pool.
   * Starts at the current max seq (history is owned by catch-up, not push); both the tail and the
   * LISTEN are established BEFORE this resolves, so nothing posted afterwards can fall between
   * them.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    assertStorable('topic', topic);
    const pool = this.require();
    const channel = channelFor(topic);

    // Keep both the live and the in-flight lookup ahead of the first await, so that two concurrent
    // subscribes to one topic cannot both miss it and have the second overwrite the first's
    // registration. A repeat subscribe just joins the fan-out; push never replays history.
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
    await this.registerSender(this.require(), handle);
    return { handle, backendRef: handle };
  }

  /**
   * `DO NOTHING`, so that first sight of a handle never overwrites a `backend_ref` an operator
   * registered by hand.
   */
  private registerSender(q: Pool | PoolClient, handle: Handle): Promise<unknown> {
    return q.query(
      `INSERT INTO ${this.names.senders} (handle, backend_ref)
       VALUES ($1, $1) ON CONFLICT (handle) DO NOTHING`,
      [handle],
    );
  }
}
