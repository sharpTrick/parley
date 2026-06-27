import {
  asBackendMsgId,
  asCursor,
  asHandle,
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
import {
  AckPolicy,
  connect,
  DeliverPolicy,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
} from 'nats';

/** Plugin-specific backend_config. */
export interface NatsBackendConfig {
  /** Server(s). Default `127.0.0.1:4222`. */
  servers?: string | string[];
  /** Subject prefix. Default `parley.`. Each topic → subject `<prefix><token>`. */
  subject_prefix?: string;
  /** JetStream stream-name prefix. Default `PARLEY_`. One stream per topic (contiguous seqs). */
  stream_prefix?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const INACTIVE_NS = 30_000_000_000; // 30s ephemeral-consumer cleanup

/**
 * NATS JetStream backend (DESIGN §6/§9) — the fabric backend. One JetStream STREAM per topic, so
 * the stream sequence number is a contiguous, monotonic per-topic `cursor` (= `backendMsgId`).
 * `post` = `js.publish` (→ seq); `fetchRecent` = an ephemeral consumer from `opt_start_seq`
 * (exclusive `since`); `subscribe` = a `consume()` ordered consumer with `DeliverPolicy.New`
 * (genuine events). Core never compares cursor values — NATS delivers in seq order.
 */
export class NatsPlugin implements BackendPlugin {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private subjectPrefix = 'parley.';
  private streamPrefix = 'PARLEY_';
  private stopped = false;
  private readonly ensured = new Map<string, Promise<void>>();
  private readonly subscriptions: ConsumerMessages[] = [];

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as NatsBackendConfig;
    this.subjectPrefix = cfg.subject_prefix ?? 'parley.';
    this.streamPrefix = cfg.stream_prefix ?? 'PARLEY_';
    this.stopped = false;
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
    if (info.state.messages === 0) {
      return { messages: [], nextCursor: args.since ?? asCursor(String(lastSeq)) };
    }
    const startSeq =
      args.since !== undefined ? Number(args.since) + 1 : Math.max(firstSeq, lastSeq - limit + 1);
    if (startSeq > lastSeq) {
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
   * Live path = an ordered `consume()` consumer with `DeliverPolicy.New` (DESIGN §9 — genuine
   * events; history is owned by catch-up). `disconnect()` closes the iterator.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    await this.ensureStream(topic);
    const stream = this.streamName(topic);
    const ci = await this.requireJsm().consumers.add(stream, {
      filter_subject: this.subject(topic),
      deliver_policy: DeliverPolicy.New,
      ack_policy: AckPolicy.None,
      inactive_threshold: INACTIVE_NS,
    });
    const consumer = await this.requireJs().consumers.get(stream, ci.name);
    const iter = await consumer.consume();
    this.subscriptions.push(iter);
    void (async () => {
      try {
        for await (const m of iter) {
          if (this.stopped) break;
          try {
            handler(rowToMessage(topic, m.seq, dec.decode(m.data)));
          } catch {
            /* handler is best-effort (DESIGN §6) */
          }
        }
      } catch {
        /* iterator closed on disconnect */
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
          await this.requireJsm().streams.add({ name, subjects: [this.subject(topic)] });
        } catch (err) {
          // Another writer created it first (same config) — fine. Re-throw anything else.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already in use|already exists|name already/i.test(msg)) throw err;
        }
      })();
      this.ensured.set(name, pending);
    }
    return pending;
  }

  private subject(topic: Topic): string {
    return this.subjectPrefix + sanitizeToken(topic);
  }
  private streamName(topic: Topic): string {
    return this.streamPrefix + sanitizeName(topic);
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
  const content = fields.content ?? '';
  const id = String(seq);
  return {
    topic,
    senderHandle: asHandle(fields.sender ?? ''),
    content,
    timestamp: fields.ts ?? '',
    backendMsgId: asBackendMsgId(id),
    cursor: asCursor(id),
    mentions: parseMentions(content),
  };
}

// Subject tokens may not contain `.`, `*`, `>`, or whitespace; stream names also bar `/ \`.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_');
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_');
