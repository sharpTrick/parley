import {
  asBackendMsgId,
  asCursor,
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
  safeName,
  type Topic,
} from '@sharptrick/parley-core';
import { readFileSync } from 'node:fs';
import {
  AckPolicy,
  connect,
  ConsumerEvents,
  credsAuthenticator,
  DeliverPolicy,
  nkeyAuthenticator,
  type ConnectionOptions,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  type StreamConfig,
  type StreamInfo,
} from 'nats';

/** Plugin-specific backend_config. */
export interface NatsBackendConfig {
  /** Server(s). Default `127.0.0.1:4222`. */
  servers?: string | string[];
  /** Subject prefix. Default `parley.`. Each topic → subject `<prefix><token>`. */
  subject_prefix?: string;
  /** JetStream stream-name prefix. Default `PARLEY_`. One stream per topic (contiguous seqs). */
  stream_prefix?: string;
  /**
   * Optional retention window in days, set as the stream's `max_age` at creation time. Omit for
   * the default — keep every message forever. Applies only when THIS plugin creates the stream
   * (`ensureStream`'s first caller); changing it later does not retroactively update an
   * already-existing stream — edit or recreate the stream out-of-band for that.
   */
  retention_days?: number;
  /** Token auth (`-auth`/`authorization.token`). Secret — `backend_config`/`.env` only. */
  token?: string;
  /** User/password auth. Secret — `backend_config`/`.env` only. */
  user?: string;
  pass?: string;
  /** Path to a NATS `.creds` file (JWT + nkey seed) — NGS and any JWT-secured cluster. */
  creds_file?: string;
  /** Raw nkey seed (`SU…`); prefer `creds_file`. Secret — `backend_config`/`.env` only. */
  nkey_seed?: string;
  /** TLS material, as file paths. */
  tls?: { ca_file?: string; cert_file?: string; key_file?: string };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const INACTIVE_NS = 30_000_000_000; // 30s ephemeral-consumer cleanup
const RESUBSCRIBE_BACKOFF_MS = 1000; // wait before retrying a consumer while the backend is unreachable
const RECONNECT_WAIT_MS = 1000;
const RECONNECT_JITTER_MS = 500;
const FETCH_EXPIRY_MS = 2000;
const DRAIN_TIMEOUT_MS = 2000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Anything the teardown registry can shut down: a live pull, a consume() iterator, a shim. */
interface Closeable {
  close: () => unknown;
}

const NS_PER_DAY = 86_400_000_000_000;

/**
 * NATS JetStream backend (DESIGN §6/§9) — the fabric backend. One JetStream STREAM per topic, so
 * the stream sequence number is a contiguous, monotonic per-topic `cursor` (= `backendMsgId`).
 * `post` = `js.publish` (→ seq); `fetchRecent` = an ephemeral consumer from `opt_start_seq`
 * (exclusive `since`); `subscribe` = a `consume()` ephemeral consumer resuming at the last delivered
 * sequence that rebuilds itself on any loss (genuine events). Core never compares cursor values —
 * NATS delivers in seq order.
 */
export class NatsPlugin implements BackendPlugin {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private subjectPrefix = 'parley.';
  private streamPrefix = 'PARLEY_';
  private retentionDays?: number;
  private stopped = false;
  private readonly ensured = new Map<string, Promise<void>>();
  private readonly subscriptions: Closeable[] = [];

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as NatsBackendConfig;
    this.subjectPrefix = cfg.subject_prefix ?? 'parley.';
    this.streamPrefix = cfg.stream_prefix ?? 'PARLEY_';
    this.retentionDays = validateRetentionDays(cfg.retention_days);
    this.stopped = false;
    this.ensured.clear();
    this.nc = await connect(connectionOptions(cfg));
    this.js = this.nc.jetstream();
    this.jsm = await this.nc.jetstreamManager();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    for (const sub of this.subscriptions.splice(0)) {
      try {
        sub.close();
      } catch {
        /* already closing */
      }
    }
    const nc = this.nc;
    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    if (nc !== undefined) {
      // Keep the bounded race: `maxReconnectAttempts: -1` means drain() never settles while the
      // link is down, so an unraced await here hangs teardown for the life of the outage.
      await Promise.race([nc.drain().catch(() => undefined), delay(DRAIN_TIMEOUT_MS)]);
      await nc.close().catch(() => undefined);
    }
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const payload = JSON.stringify({
      sender: identity,
      content,
      ts: new Date().toISOString(),
      in_reply_to: opts?.inReplyTo ?? '',
    });
    return this.withStream(topic, async () => {
      const ack = await this.requireJs().publish(this.subject(topic), enc.encode(payload));
      return asBackendMsgId(String(ack.seq));
    });
  }

  // Keep this `async`, so that a rejected `since` REJECTS: a synchronous throw out of a
  // Promise-returning seam method escapes every caller that only wrote `.catch()`.
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const since = parseCursor(args.since);
    return this.withStream(args.topic, () => this.readRecent(args, since));
  }

  private async readRecent(args: FetchRecentArgs, since?: number): Promise<FetchRecentResult> {
    const stream = this.streamName(args.topic);
    const limit = args.limit ?? 100;
    const info = await this.requireJsm().streams.info(stream);
    const lastSeq = info.state.last_seq;
    const firstSeq = info.state.first_seq;
    // A `since` past the tail names a sequence this stream never had — it was re-provisioned
    // underneath the cursor and its sequences restarted at 1. Keep the fall back to the retained
    // window, so that catch-up cannot go permanently deaf waiting on a sequence that will not come.
    const restarted = since !== undefined && since > lastSeq;
    const tailWindow = Math.max(firstSeq, lastSeq - limit + 1, 1);
    // JetStream prunes from the front (`max_age`), so a `since` older than the retained window must
    // start at `first_seq`: the gap is gone either way, and asking below it stalls the pull for its
    // whole expiry waiting on sequences the server no longer has.
    const startSeq =
      since === undefined || restarted ? tailWindow : Math.max(since + 1, firstSeq, 1);
    const emptyCursor =
      since === undefined || restarted ? asCursor(String(lastSeq)) : (args.since as Cursor);

    const blockMs = args.blockMs ?? 0;
    if (info.state.messages === 0 || startSeq > lastSeq) {
      if (blockMs > 0 && args.since !== undefined) {
        return this.blockingFetch(
          stream,
          args.topic,
          startSeq,
          limit,
          Date.now() + blockMs,
          emptyCursor,
        );
      }
      return { messages: [], nextCursor: emptyCursor };
    }
    const want = Math.min(limit, lastSeq - startSeq + 1);

    const ci = await this.requireJsm().consumers.add(stream, {
      filter_subject: this.subject(args.topic),
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: startSeq,
      ack_policy: AckPolicy.None,
      inactive_threshold: INACTIVE_NS,
    });
    // Keep every step after `consumers.add` inside the try, so that a throw still reaches the
    // finally's delete — an ephemeral consumer nobody deletes lingers for `inactive_threshold`.
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    try {
      const consumer = await this.requireJs().consumers.get(stream, ci.name);
      batch = await consumer.fetch({ max_messages: want, expires: FETCH_EXPIRY_MS });
      for await (const m of batch) {
        messages.push(rowToMessage(args.topic, m.seq, dec.decode(m.data)));
        // Keep the tail break: `want` is an upper bound over a range that may be sparse, and a pull
        // that asked for more than the stream holds waits out its whole `expires` otherwise.
        if (messages.length >= want || m.seq >= lastSeq) break;
      }
    } finally {
      void batch?.close();
      await this.jsm?.consumers.delete(stream, ci.name).catch(() => undefined);
    }
    const last = messages.at(-1);
    // A short read (expiry, slow link, filter mismatch) must resume immediately BEFORE the window
    // it failed to read: keep `startSeq - 1`, so that an empty page can never park the persisted
    // cursor at the tail and silently drop everything in between.
    const nextCursor = last !== undefined ? last.cursor : asCursor(String(startSeq - 1));
    return { messages, nextCursor };
  }

  /**
   * Run `op` against the topic's stream, re-provisioning the stream once if it vanished
   * out-of-band (`nats stream rm`, storage reset). `ensured` memoizes success, so without this a
   * removed stream stays broken for the life of the process.
   */
  private async withStream<T>(topic: Topic, op: () => Promise<T>): Promise<T> {
    await this.ensureStream(topic);
    try {
      return await op();
    } catch (err) {
      if (!isStreamMissing(err)) throw err;
      this.ensured.delete(this.streamName(topic));
      await this.ensureStream(topic);
      return await op();
    }
  }

  /**
   * Long-poll half of `fetchRecent`: the exclusive `since` query was empty, so wait on an ephemeral
   * JetStream pull from `startSeq` — the pull's `expires` IS the bounded wait — and return on the
   * first message, at the deadline, or on `disconnect()`. `fallback` is the cursor of an empty page.
   */
  private async blockingFetch(
    stream: string,
    topic: Topic,
    startSeq: number,
    limit: number,
    deadline: number,
    fallback: Cursor,
  ): Promise<FetchRecentResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || this.stopped) return { messages: [], nextCursor: fallback };

    const ci = await this.requireJsm().consumers.add(stream, {
      filter_subject: this.subject(topic),
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: startSeq,
      ack_policy: AckPolicy.None,
      inactive_threshold: INACTIVE_NS,
    });
    // Keep every step after `consumers.add` inside the try, so that a throw still reaches the
    // finally's delete — an ephemeral consumer nobody deletes lingers for `inactive_threshold`.
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const consumer = await this.requireJs().consumers.get(stream, ci.name);
      // Keep the 1000ms floor: nats.js rejects a shorter `expires`, and the timer below — not
      // `expires` — is what honours a sub-second `blockMs`.
      batch = await consumer.fetch({ max_messages: limit, expires: Math.max(remaining, 1000) });

      const live = batch;
      this.subscriptions.push(live);
      // Keep the timer armed off the LIVE clock, so that setup round-trips cannot push the return
      // past the caller's `blockMs`.
      timer = setTimeout(() => void live.close(), Math.max(deadline - Date.now(), 0));

      for await (const m of batch) {
        if (this.stopped) break;
        messages.push(rowToMessage(topic, m.seq, dec.decode(m.data)));
        // Keep the single-message return, so that a long-poll wakes its caller at once; the
        // remainder of a burst stays in the stream and core polls it.
        break;
      }
    } catch {
      /* pull closed by the deadline timer or by disconnect() — return whatever we have */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (batch !== undefined) {
        const i = this.subscriptions.indexOf(batch);
        if (i >= 0) this.subscriptions.splice(i, 1);
      }
      void batch?.close();
      await this.jsm?.consumers.delete(stream, ci.name).catch(() => undefined);
    }
    const last = messages.at(-1);
    return { messages, nextCursor: last !== undefined ? last.cursor : fallback };
  }

  /**
   * Live path = an ephemeral `consume()` consumer resuming at `DeliverPolicy.StartSequence`
   * `lastSeq + 1` (DESIGN §9 — genuine events; history is owned by catch-up). `lastSeq` is seeded
   * from the stream tail at subscribe time so the FIRST consumer, like every rebuilt one, backfills
   * whatever landed while it was absent. A plain named ephemeral consumer is GC'd by the server
   * after `INACTIVE_NS` of client absence (restart / partition) and `consume()` does not self-heal,
   * so we watch `iter.status()` for `ConsumerDeleted`/`ConsumerNotFound`/`StreamNotFound` and close
   * the iterator; ANY iterator exit rebuilds — a connection drop ends `consume()` with no status
   * event at all. The outer loop honors `disconnect()`: `this.stopped` + the registered closer stop
   * it without a rebuild, as does a permanently closed connection.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const stream = this.streamName(topic);
    const filterSubject = this.subject(topic);
    const seeded = await this.streamInfo(topic);
    let lastSeq = seeded.state.last_seq;
    let created = seeded.created;
    let current: ConsumerMessages | undefined;
    this.subscriptions.push({ close: () => current?.close() });

    void (async () => {
      let rebuild = false;
      while (this.live()) {
        let iter: ConsumerMessages;
        try {
          if (rebuild) await delay(RESUBSCRIBE_BACKOFF_MS);
          rebuild = true;
          // A recreated stream restarts its sequences, so a position carried over from the old one
          // would skip the new stream's messages (or ask for a sequence past its tail forever).
          const info = await this.streamInfo(topic);
          if (info.created !== created) {
            created = info.created;
            lastSeq = 0;
          }
          if (lastSeq > info.state.last_seq) lastSeq = info.state.last_seq;
          const ci = await this.requireJsm().consumers.add(stream, {
            filter_subject: filterSubject,
            deliver_policy: DeliverPolicy.StartSequence,
            opt_start_seq: lastSeq + 1,
            ack_policy: AckPolicy.None,
            inactive_threshold: INACTIVE_NS,
          });
          const consumer = await this.requireJs().consumers.get(stream, ci.name);
          iter = await consumer.consume();
        } catch {
          if (!this.live()) break;
          continue; // backend momentarily unreachable — retry the consumer after the backoff
        }
        current = iter;

        const statusTask = (async () => {
          try {
            for await (const s of await iter.status()) {
              if (
                s.type === ConsumerEvents.ConsumerDeleted ||
                s.type === ConsumerEvents.ConsumerNotFound ||
                s.type === ConsumerEvents.StreamNotFound
              ) {
                await iter.close(); // ends the message for-await below
                break;
              }
            }
          } catch {
            /* status iterator closed */
          }
        })();

        try {
          for await (const m of iter) {
            if (this.stopped) break;
            lastSeq = m.seq;
            try {
              handler(rowToMessage(topic, m.seq, dec.decode(m.data)));
            } catch {
              /* handler is best-effort (DESIGN §6) */
            }
          }
        } catch {
          /* iterator closed on disconnect or consumer loss */
        }
        await statusTask;
        if (this.stopped) break; // only a clean disconnect ends the loop; every other exit rebuilds
      }
    })();
  }

  /**
   * False once teardown began or the connection is closed for good — the only two reasons the live
   * loop may stop rebuilding.
   */
  private live(): boolean {
    return !this.stopped && this.nc !== undefined && !this.nc.isClosed();
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  /** Stream state, re-provisioning the stream if it vanished out-of-band. */
  private streamInfo(topic: Topic): Promise<StreamInfo> {
    return this.withStream(topic, () => this.requireJsm().streams.info(this.streamName(topic)));
  }

  /** Create the per-topic stream once (idempotent; tolerates concurrent creation). */
  private ensureStream(topic: Topic): Promise<void> {
    const name = this.streamName(topic);
    let pending = this.ensured.get(name);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const config: Partial<StreamConfig> = { name, subjects: [this.subject(topic)] };
          if (this.retentionDays !== undefined) {
            config.max_age = Math.round(this.retentionDays * NS_PER_DAY);
          }
          await this.requireJsm().streams.add(config);
        } catch (err) {
          // Keep this swallow narrow to "already exists", so that a real add failure still surfaces
          // instead of being cached as a stream that was never created.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already in use|already exists|name already/i.test(msg)) throw err;
        }
      })().catch((err: unknown) => {
        // Keep the eviction, so that a transient failure does not poison the cache with a rejected
        // promise every later call re-awaits.
        this.ensured.delete(name);
        throw err;
      });
      this.ensured.set(name, pending);
    }
    return pending;
  }

  private subject(topic: Topic): string {
    return this.subjectPrefix + safeName(topic, sanitizeToken);
  }
  private streamName(topic: Topic): string {
    return this.streamPrefix + safeName(topic, sanitizeName);
  }

  private requireJs(): JetStreamClient {
    if (this.js === undefined) throw new Error('NatsPlugin not connected — call connect() first');
    return this.js;
  }
  private requireJsm(): JetStreamManager {
    if (this.jsm === undefined) throw new Error('NatsPlugin not connected — call connect() first');
    return this.jsm;
  }
}

/**
 * A cursor this plugin minted is a decimal JetStream sequence number. Anything else is caller
 * input (`parley_fetch_recent` takes `since` as a free string) and is rejected here rather than
 * coerced by `Number()` into a silently-empty page or an opaque driver error.
 */
function parseCursor(since: Cursor | undefined): number | undefined {
  if (since === undefined) return undefined;
  const n = Number(since);
  if (!/^\d+$/.test(since) || !Number.isSafeInteger(n)) {
    throw new Error(
      `invalid nats cursor ${JSON.stringify(String(since))} — expected a JetStream sequence number`,
    );
  }
  return n;
}

/**
 * JetStream reads `max_age: 0` as UNLIMITED, so `retention_days: 0` would mean the exact opposite
 * of what an operator wrote, and a negative value fails later with an unrelated driver error.
 * Reject both at connect, before a stream is created with a window that is then locked in.
 */
function validateRetentionDays(days: number | undefined): number | undefined {
  if (days === undefined) return undefined;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      `invalid retention_days ${JSON.stringify(days)} — expected a positive number of days, or omit it for unlimited retention`,
    );
  }
  return days;
}

/**
 * Anything with publish rights on the subject can put arbitrary bytes in the stream, and a record
 * that throws here is unreadable FOREVER — it sits in the stream and kills every catch-up page
 * that covers it. So this is total: undecodable or wrongly-typed frames degrade to empty strings
 * rather than raising (CLAUDE.md "inbound is untrusted" — the wire format, not just the content).
 */
function rowToMessage(topic: Topic, seq: number, raw: string): Message {
  const fields = decodeFields(raw);
  return buildMessage({
    topic,
    sender: asString(fields.sender),
    content: asString(fields.content),
    timestamp: asString(fields.ts),
    id: String(seq),
  });
}

function decodeFields(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A stream that vanished out-of-band: JetStream 404s the manager and 503s the publish. */
function isStreamMissing(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === '503') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /stream not found|no responders|503/i.test(msg);
}

function connectionOptions(cfg: NatsBackendConfig): ConnectionOptions {
  const opts: ConnectionOptions = {
    servers: cfg.servers ?? '127.0.0.1:4222',
    // Keep the unbounded reconnect: nats.js defaults to 10 attempts, after which the connection
    // CLOSES for good — every later post/fetch throws CONNECTION_CLOSED and live delivery stops.
    maxReconnectAttempts: -1,
    reconnectTimeWait: RECONNECT_WAIT_MS,
    reconnectJitter: RECONNECT_JITTER_MS,
  };
  if (cfg.token !== undefined) opts.token = cfg.token;
  if (cfg.user !== undefined) opts.user = cfg.user;
  if (cfg.pass !== undefined) opts.pass = cfg.pass;
  if (cfg.creds_file !== undefined) {
    opts.authenticator = credsAuthenticator(readFileSync(cfg.creds_file));
  } else if (cfg.nkey_seed !== undefined) {
    opts.authenticator = nkeyAuthenticator(enc.encode(cfg.nkey_seed));
  }
  if (cfg.tls !== undefined) {
    opts.tls = {
      caFile: cfg.tls.ca_file,
      certFile: cfg.tls.cert_file,
      keyFile: cfg.tls.key_file,
    };
  }
  return opts;
}

// Subject tokens may not contain `.`, `*`, `>`, or whitespace; stream names also bar `/ \`.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_');
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_');
