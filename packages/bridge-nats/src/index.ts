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
import {
  AckPolicy,
  connect,
  ConsumerEvents,
  DeliverPolicy,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  type StreamConfig,
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
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const INACTIVE_NS = 30_000_000_000; // 30s ephemeral-consumer cleanup
const RESUBSCRIBE_BACKOFF_MS = 1000; // wait before retrying a consumer while the backend is unreachable

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * NATS JetStream backend (DESIGN §6/§9) — the fabric backend. One JetStream STREAM per topic, so
 * the stream sequence number is a contiguous, monotonic per-topic `cursor` (= `backendMsgId`).
 * `post` = `js.publish` (→ seq); `fetchRecent` = an ephemeral consumer from `opt_start_seq`
 * (exclusive `since`); `subscribe` = a `consume()` ephemeral consumer starting at `DeliverPolicy.New`
 * that rebuilds itself on server-side loss (genuine events). Core never compares cursor values —
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
  private readonly subscriptions: ConsumerMessages[] = [];

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as NatsBackendConfig;
    this.subjectPrefix = cfg.subject_prefix ?? 'parley.';
    this.streamPrefix = cfg.stream_prefix ?? 'PARLEY_';
    this.retentionDays = cfg.retention_days;
    this.stopped = false;
    this.ensured.clear(); // a fresh connection starts from a clean stream-cache (BUG-01)
    this.nc = await connect({ servers: cfg.servers ?? '127.0.0.1:4222' });
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
    if (this.nc !== undefined) {
      await this.nc.drain().catch(() => undefined);
      this.nc = undefined;
    }
    this.js = undefined;
    this.jsm = undefined;
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    await this.ensureStream(topic);
    const payload = JSON.stringify({
      sender: identity,
      content,
      ts: new Date().toISOString(),
      in_reply_to: opts?.inReplyTo ?? '',
    });
    const ack = await this.requireJs().publish(this.subject(topic), enc.encode(payload));
    return asBackendMsgId(String(ack.seq));
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    await this.ensureStream(args.topic);
    const stream = this.streamName(args.topic);
    const limit = args.limit ?? 100;
    const info = await this.requireJsm().streams.info(stream);
    const lastSeq = info.state.last_seq;
    const firstSeq = info.state.first_seq;
    const startSeq =
      args.since !== undefined ? Number(args.since) + 1 : Math.max(firstSeq, lastSeq - limit + 1);

    // Nothing is strictly after `since` yet (empty stream, or `since` already at the tail).
    // Native long-poll (issue #20): if a positive `blockMs` is set AND we have an exclusive
    // `since`, wait on a bounded JetStream pull up to the remaining budget instead of returning
    // instantly; the pull's `expires` IS the bounded wait. `blockMs` falsy OR `since` undefined →
    // return an empty page immediately, exactly as the durable read does today. Returning
    // early/empty is always safe — core polls the remainder.
    const blockMs = args.blockMs ?? 0;
    if (info.state.messages === 0 || startSeq > lastSeq) {
      if (blockMs > 0 && args.since !== undefined) {
        return this.blockingFetch(stream, args.topic, startSeq, limit, Date.now() + blockMs, args.since);
      }
      return { messages: [], nextCursor: args.since ?? asCursor(String(lastSeq)) };
    }
    const want = Math.min(limit, lastSeq - startSeq + 1);

    const ci = await this.requireJsm().consumers.add(stream, {
      filter_subject: this.subject(args.topic),
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: startSeq,
      ack_policy: AckPolicy.None,
      inactive_threshold: INACTIVE_NS,
    });
    const consumer = await this.requireJs().consumers.get(stream, ci.name);
    const messages: Message[] = [];
    const batch = await consumer.fetch({ max_messages: want, expires: 2000 });
    for await (const m of batch) {
      messages.push(rowToMessage(args.topic, m.seq, dec.decode(m.data)));
      if (messages.length >= want) break;
    }
    await this.requireJsm().consumers.delete(stream, ci.name).catch(() => undefined);
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor(String(lastSeq)));
    return { messages, nextCursor };
  }

  /**
   * Native long-poll for `fetchRecent` (issue #20). The exclusive `since` query was empty, so wait
   * on an ephemeral JetStream PULL consumer starting at `opt_start_seq = since + 1` up to the
   * remaining budget — a pull `fetch` with `expires` IS the bounded wait, so this blocks instead of
   * returning instantly, waking the moment a message lands at `startSeq` (or at expiry). The
   * JetStream sequence number is the cursor. Semantics:
   *   - The remaining budget (`deadline - now`) bounds the wait; we never block past `blockMs`.
   *     nats.js rejects `expires < 1000ms`, so we floor the pull's `expires` at 1000 but enforce the
   *     TRUE remaining budget with our own timer that closes the pull — so a sub-second `blockMs`
   *     (e.g. 300ms) still returns on time.
   *   - Return promptly on the first message (break); any burst remainder stays in the stream and
   *     core polls it. On expiry/disconnect we return an empty page whose `nextCursor === since`.
   *   - `disconnect()` aborts cleanly: the ephemeral consumer is registered in `this.subscriptions`,
   *     so teardown `close()`s the pull immediately, `this.stopped` short-circuits the result, and
   *     the `finally` destroys the consumer (it is also GC'd server-side after `INACTIVE_NS`). No
   *     leaked consumers/subscriptions.
   */
  private async blockingFetch(
    stream: string,
    topic: Topic,
    startSeq: number,
    limit: number,
    deadline: number,
    since: Cursor,
  ): Promise<FetchRecentResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || this.stopped) return { messages: [], nextCursor: since };

    const ci = await this.requireJsm().consumers.add(stream, {
      filter_subject: this.subject(topic),
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: startSeq,
      ack_policy: AckPolicy.None,
      inactive_threshold: INACTIVE_NS,
    });
    // From here the ephemeral consumer exists server-side, so a throw in get()/fetch() must delete
    // it in the finally — otherwise it lingers until `inactive_threshold` (30s). Everything after
    // add() runs inside the try so the primary cleanup, not just the GC backstop, covers the throw.
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    let closer: ConsumerMessages | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const consumer = await this.requireJs().consumers.get(stream, ci.name);
      // Floor `expires` at nats.js's 1000ms minimum; the timer below enforces the real deadline.
      batch = await consumer.fetch({ max_messages: limit, expires: Math.max(remaining, 1000) });

      // Register the live pull so disconnect() closes it promptly (reuses the subscription
      // teardown); removed again in the finally so nothing leaks after a normal return.
      const live = batch;
      closer = { close: () => live.close() } as unknown as ConsumerMessages;
      this.subscriptions.push(closer);
      // Base the timer on the LIVE deadline so setup RTT (add/get/fetch) can't push the return past
      // blockMs — never block longer than the remaining budget at the moment we arm it.
      timer = setTimeout(() => void live.close(), Math.max(deadline - Date.now(), 0));

      for await (const m of batch) {
        if (this.stopped) break;
        messages.push(rowToMessage(topic, m.seq, dec.decode(m.data)));
        break; // long-poll: return promptly on the first message; core polls any burst remainder.
      }
    } catch {
      /* pull closed by the deadline timer or by disconnect() — return whatever we have */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (closer !== undefined) {
        const i = this.subscriptions.indexOf(closer);
        if (i >= 0) this.subscriptions.splice(i, 1);
      }
      void batch?.close();
      await this.jsm?.consumers.delete(stream, ci.name).catch(() => undefined);
    }
    const last = messages.at(-1);
    return { messages, nextCursor: last !== undefined ? last.cursor : since };
  }

  /**
   * Live path = an ephemeral `consume()` consumer starting at `DeliverPolicy.New` (DESIGN §9 —
   * genuine events; history is owned by catch-up). A plain named ephemeral consumer is GC'd by the
   * server after `INACTIVE_NS` of client absence (restart / partition), and `consume()` does not
   * self-heal — so we watch `iter.status()` and, on `ConsumerDeleted`/`ConsumerNotFound`/
   * `StreamNotFound`, rebuild the consumer at `DeliverPolicy.StartSequence` `lastSeq + 1`, which
   * both restores delivery and backfills the outage gap (BUG-02). The outer loop honors
   * `disconnect()`: `this.stopped` + the registered closer stop it without a rebuild.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    await this.ensureStream(topic);
    const stream = this.streamName(topic);
    const filterSubject = this.subject(topic);
    let lastSeq: number | undefined; // undefined → start at DeliverPolicy.New (no gap to backfill yet)
    let current: ConsumerMessages | undefined;
    // A single closer so disconnect() tears down whichever iterator is live at the time.
    this.subscriptions.push({
      close: () => current?.close() ?? Promise.resolve(),
    } as unknown as ConsumerMessages);

    void (async () => {
      while (!this.stopped) {
        let iter: ConsumerMessages;
        try {
          const ci = await this.requireJsm().consumers.add(stream, {
            filter_subject: filterSubject,
            deliver_policy: lastSeq === undefined ? DeliverPolicy.New : DeliverPolicy.StartSequence,
            ...(lastSeq === undefined ? {} : { opt_start_seq: lastSeq + 1 }),
            ack_policy: AckPolicy.None,
            inactive_threshold: INACTIVE_NS,
          });
          const consumer = await this.requireJs().consumers.get(stream, ci.name);
          iter = await consumer.consume();
        } catch {
          if (this.stopped) break;
          await delay(RESUBSCRIBE_BACKOFF_MS); // backend momentarily unreachable — retry the consumer
          continue;
        }
        current = iter;

        // The plain named consumer only notify()s on deletion/GC; surface it and force a rebuild.
        let recreate = false;
        const statusTask = (async () => {
          try {
            for await (const s of await iter.status()) {
              if (
                s.type === ConsumerEvents.ConsumerDeleted ||
                s.type === ConsumerEvents.ConsumerNotFound ||
                s.type === ConsumerEvents.StreamNotFound
              ) {
                recreate = true;
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
        if (this.stopped || !recreate) break; // clean disconnect vs. consumer-loss rebuild
      }
    })();
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
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
            config.max_age = this.retentionDays * 86_400_000_000_000; // days → ns
          }
          await this.requireJsm().streams.add(config);
        } catch (err) {
          // Another writer created it first (same config) — fine. Re-throw anything else.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already in use|already exists|name already/i.test(msg)) throw err;
        }
      })().catch((err: unknown) => {
        // Don't poison the cache on transient failure — evict so the next call retries (BUG-01).
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

function rowToMessage(topic: Topic, seq: number, raw: string): Message {
  let fields: { sender?: string; content?: string; ts?: string } = {};
  try {
    fields = JSON.parse(raw) as typeof fields;
  } catch {
    /* leave empty */
  }
  return buildMessage({
    topic,
    sender: fields.sender ?? '',
    content: fields.content ?? '',
    timestamp: fields.ts ?? '',
    id: String(seq),
  });
}

// Subject tokens may not contain `.`, `*`, `>`, or whitespace; stream names also bar `/ \`.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_');
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_');
