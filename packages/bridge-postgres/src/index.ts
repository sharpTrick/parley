import { createHash } from 'node:crypto';
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
import { delay } from '@sharptrick/parley-net-util';
import { Client, Pool } from 'pg';
import { assertTableName, buildSchema, type MessageRow } from './schema.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface PostgresBackendConfig {
  /** Connection URL. Default `postgres://parley:parley@127.0.0.1:5432/parley`. */
  url?: string;
  /**
   * Message table name; the sender registry lives beside it as `<table_name>_senders`.
   * Default `parley_messages`. Restricted to `[A-Za-z0-9_]` — it is interpolated into SQL.
   */
  table_name?: string;
  /** Max pooled connections for queries/writes (the LISTEN connection is separate). Default 5. */
  pool_size?: number;
}

const DEFAULT_URL = 'postgres://parley:parley@127.0.0.1:5432/parley';
/** How many rows one drain query pulls at most before re-querying. */
const DRAIN_BATCH = 512;
/** Backoff between listener reconnect attempts after the connection drops. */
const RECONNECT_DELAY_MS = 500;

/** Live-path bookkeeping for one subscribed topic (keyed by NOTIFY channel). */
interface TopicSubscription {
  topic: Topic;
  handler: MessageHandler;
  /** Highest seq already delivered (as text — BIGINT round-trips as a string). */
  lastSeen: string;
  /** In-flight guard: at most one drain loop per topic at a time. */
  draining: boolean;
  /** A notification arrived mid-drain — run the drain once more before going idle. */
  pending: boolean;
}

/**
 * The PostgreSQL backend (DESIGN §9) — self-hosted networked SQL. Slots between SQLite (the
 * zero-infra local floor) and Redis (the first broker): one database serves any number of
 * bridge processes over the network, and LISTEN/NOTIFY makes the live path TRUE event-driven
 * push — an AFTER INSERT trigger rings a per-topic channel, so `subscribe` waits on real
 * events, not a poll timer. The cursor (`seq`) still owns correctness: a notification is only
 * a doorbell, and subscribers always re-query strictly after their last-seen cursor, so a
 * coalesced or dropped NOTIFY costs latency, never a message (DESIGN §6).
 */
export class PostgresPlugin implements BackendPlugin {
  private pool?: Pool;
  private url = DEFAULT_URL;
  private table = 'parley_messages';
  private stopped = false;

  /** Dedicated non-pool LISTEN connection, shared by all topics; lazy on first subscribe. */
  private listener?: Client;
  private listenerPromise?: Promise<Client>;
  private reconnecting = false;
  private readonly subs = new Map<string, TopicSubscription>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as PostgresBackendConfig;
    this.url = cfg.url ?? DEFAULT_URL;
    this.table = assertTableName(cfg.table_name ?? 'parley_messages');
    this.stopped = false;

    // SEC-06: warn loudly before the schema bootstrap when the operator is connecting with the
    // repo-public default DSN (unset → fell back, or set literally to the well-known value).
    if (cfg.url === undefined || this.url === DEFAULT_URL) {
      console.warn(
        '[parley-postgres] SECURITY: connecting with the built-in default DSN ' +
          "('postgres://parley:parley@…'). Set backend_config.url to a real connection string; a " +
          'network-reachable database provisioned with these credentials is world-readable/injectable.',
      );
    }

    const pool = new Pool({ connectionString: this.url, max: cfg.pool_size ?? 5 });
    pool.on('error', () => {
      /* idle-client errors (server restart etc.) surface via command rejections; don't crash */
    });

    // Idempotent bootstrap, serialized under an advisory lock: concurrent bridge processes
    // connecting to the same table would otherwise race the CREATE/DROP statements.
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
    this.pool = pool;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.subs.clear();
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
   * distinct lock keys and don't contend. The sender registry upsert rides the same
   * transaction (first sight of a handle registers it — DESIGN §4).
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const client = await this.require().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [topic]);
      const res = await client.query(
        `INSERT INTO ${this.table} (topic, sender, content, ts, in_reply_to)
         VALUES ($1, $2, $3, $4, $5) RETURNING seq::text AS seq`,
        [topic, identity, content, new Date().toISOString(), opts?.inReplyTo ?? null],
      );
      await client.query(
        `INSERT INTO ${this.table}_senders (handle, backend_ref)
         VALUES ($1, $1) ON CONFLICT (handle) DO NOTHING`,
        [identity],
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
    let rows: MessageRow[];
    // NB: ORDER BY is table-qualified everywhere — a bare `ORDER BY seq` would bind to the
    // `seq::text AS seq` OUTPUT alias and sort lexicographically ('9' > '10'), not numerically.
    if (args.since === undefined) {
      // Default window: the most recent `limit` messages, returned ascending by cursor.
      const res = await this.require().query(
        `SELECT seq::text AS seq, topic, sender, content, ts, in_reply_to
         FROM ${this.table} WHERE topic = $1 ORDER BY ${this.table}.seq DESC LIMIT $2`,
        [args.topic, limit],
      );
      rows = (res.rows as MessageRow[]).reverse();
    } else {
      // Exclusive: strictly after `since`, ascending.
      const res = await this.require().query(
        `SELECT seq::text AS seq, topic, sender, content, ts, in_reply_to
         FROM ${this.table} WHERE topic = $1 AND seq > $2::bigint ORDER BY ${this.table}.seq ASC LIMIT $3`,
        [args.topic, args.since, limit],
      );
      rows = res.rows as MessageRow[];
    }
    const messages = rows.map(rowToMessage);
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor('0'));
    return { messages, nextCursor };
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
    const listener = await this.ensureListener();
    const channel = channelFor(topic);

    // Tail first: push never replays history (catch-up owns it).
    const res = await pool.query(
      `SELECT COALESCE(MAX(seq), 0)::text AS max FROM ${this.table} WHERE topic = $1`,
      [topic],
    );
    const sub: TopicSubscription = {
      topic,
      handler,
      lastSeen: (res.rows[0] as { max: string }).max,
      draining: false,
      pending: false,
    };
    this.subs.set(channel, sub);
    await listener.query(`LISTEN "${channel}"`);
    // Cover the tail-read → LISTEN window: a row committed inside it never notified us.
    this.drain(sub);
  }

  /**
   * Sender registry lookup (DESIGN §4). Postgres is a self-hosted local-convention backend —
   * no provisioned accounts — so an unknown handle is registered on first sight with
   * `backendRef === handle`.
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    const res = await this.require().query(
      `SELECT backend_ref FROM ${this.table}_senders WHERE handle = $1`,
      [handle],
    );
    const row = res.rows[0] as { backend_ref: string } | undefined;
    if (row !== undefined) return { handle, backendRef: row.backend_ref };
    await this.require().query(
      `INSERT INTO ${this.table}_senders (handle, backend_ref)
       VALUES ($1, $1) ON CONFLICT (handle) DO NOTHING`,
      [handle],
    );
    return { handle, backendRef: handle };
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
    const client = new Client({ connectionString: this.url });
    this.wireListener(client);
    await client.connect();
    this.listener = client;
    return client;
  }

  /** Attach notification + failure handlers to a (candidate) listener connection. */
  private wireListener(client: Client): void {
    client.on('error', () => {
      /* swallow — a fatal error is followed by 'end', which drives the reconnect */
    });
    client.on('notification', (n) => {
      const sub = this.subs.get(n.channel);
      // Payload is a hint only (size limits + best-effort delivery) — always re-query.
      if (sub !== undefined) this.drain(sub);
    });
    client.on('end', () => {
      if (!this.stopped && this.listener === client) void this.reconnectListener();
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
    try {
      while (!this.stopped) {
        await delay(RECONNECT_DELAY_MS);
        if (this.stopped) return;
        const client = new Client({ connectionString: this.url });
        this.wireListener(client);
        try {
          await client.connect();
          for (const channel of this.subs.keys()) {
            await client.query(`LISTEN "${channel}"`);
          }
          this.listener = client;
          this.listenerPromise = Promise.resolve(client);
          for (const sub of this.subs.values()) this.drain(sub);
          return;
        } catch {
          await client.end().catch(() => undefined);
          // server still unreachable — back off and try again
        }
      }
    } finally {
      this.reconnecting = false;
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
    void (async () => {
      try {
        do {
          sub.pending = false;
          for (;;) {
            if (this.stopped) return;
            const res = await this.require().query(
              `SELECT seq::text AS seq, topic, sender, content, ts, in_reply_to
               FROM ${this.table} WHERE topic = $1 AND seq > $2::bigint
               ORDER BY ${this.table}.seq ASC LIMIT ${DRAIN_BATCH}`,
              [sub.topic, sub.lastSeen],
            );
            const rows = res.rows as MessageRow[];
            if (rows.length === 0) break;
            for (const row of rows) {
              sub.lastSeen = String(row.seq);
              try {
                sub.handler(rowToMessage(row));
              } catch {
                /* handler is best-effort; never break the loop (DESIGN §6) */
              }
            }
          }
        } while (sub.pending && !this.stopped);
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

/**
 * NOTIFY channel for a topic — must byte-match the trigger's `'parley_' || md5(NEW.topic)`
 * (both sides hash the UTF-8 bytes). Fixed length: safe under the 63-byte identifier limit for
 * any topic string.
 */
function channelFor(topic: Topic): string {
  return `parley_${createHash('md5').update(topic, 'utf8').digest('hex')}`;
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
