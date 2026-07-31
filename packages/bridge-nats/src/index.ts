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
import { isLoopbackHost } from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';
import {
  AckPolicy,
  connect,
  ConsumerEvents,
  credsAuthenticator,
  DeliverPolicy,
  nkeyAuthenticator,
  type ConnectionOptions,
  type ConsumerConfig,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  type StoredMsg,
  type StreamConfig,
  type StreamInfo,
} from 'nats';

/** Plugin-specific backend_config. */
export interface NatsBackendConfig {
  /** Server(s). Default `127.0.0.1:4222`. */
  servers?: string | string[];
  /** Subject prefix. Default `parley.`. Each topic → subject `<prefix><token>`. */
  subject_prefix?: string;
  /** JetStream stream-name prefix. Default `PARLEY_`. One stream per topic. */
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
const FETCH_EXPIRY_CEILING_MS = 30_000;
const FETCH_IDLE_MS = 200; // close a pull this long without a message rather than wait out `expires`
const LINK_PATIENCE_FACTOR = 3;
const WIDEN_FACTOR = 4;
const DRAIN_TIMEOUT_MS = 2000;

/**
 * How long ONE pull waits, scaled by what its own setup round trips just cost. Keep the scaling: a
 * constant idle close is armed before the first message can arrive (nats.js `fetch()` resolves as
 * soon as the pull is queued locally), so on any link slower than the constant it closes the pull
 * having read nothing and catch-up returns an empty page with a cursor that never advances.
 */
const pullPatience = (setupMs: number): { expires: number; idleMs: number } => {
  const scaled = setupMs * LINK_PATIENCE_FACTOR;
  const expires = Math.min(Math.max(FETCH_EXPIRY_MS, scaled), FETCH_EXPIRY_CEILING_MS);
  return { expires, idleMs: Math.min(Math.max(FETCH_IDLE_MS, scaled), expires) };
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Anything the teardown registry can shut down: a live pull, a consume() iterator, a shim. */
interface Closeable {
  close: () => unknown;
}

/**
 * One ephemeral consumer, deleted exactly once by whichever racer reaches it first: the call that
 * created it, or a `disconnect()` that landed inside its creation round trip. Keep {@link reap}
 * waiting on the in-flight `consumers.add`, so that a teardown arriving before the server has named
 * the consumer still deletes it — a name that arrives after teardown has dropped the link has
 * nothing left to delete it, and the orphan lingers for `inactive_threshold`.
 */
class EphemeralConsumer {
  name?: string;
  private adding: Promise<unknown> = Promise.resolve();
  private reaped = false;

  constructor(
    private readonly jsm: JetStreamManager,
    private readonly stream: string,
  ) {}

  /**
   * Keep the request and the record of it in ONE synchronous step: a teardown can only interleave at
   * an await, so nothing can observe a consumer being created with no reaper watching for its name.
   */
  add(config: Partial<ConsumerConfig>): Promise<string> {
    const added = this.jsm.consumers.add(this.stream, config).then((ci) => {
      this.name = ci.name;
      return ci.name;
    });
    this.adding = added.catch(() => undefined);
    return added;
  }

  async reap(): Promise<void> {
    await Promise.race([this.adding, delay(DRAIN_TIMEOUT_MS)]);
    if (this.reaped || this.name === undefined) return;
    this.reaped = true;
    await this.jsm.consumers.delete(this.stream, this.name).catch(() => undefined);
  }
}

const NS_PER_DAY = 86_400_000_000_000;
const MAX_STREAM_NAME_BYTES = 255; // JetStream's own cap on a stream name
const ABSENT_STREAM_POLL_MS = 250; // how often a blocking read re-asks whether the stream exists yet
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');
const UNKNOWN_INCARNATION = '0';

/** Fold a stream's `created` stamp into an id-safe token identifying THAT incarnation of it. */
const incarnationToken = (created: string | undefined): string =>
  (created ?? '').replace(/[^0-9A-Za-z]/g, '') || UNKNOWN_INCARNATION;

/**
 * NATS JetStream backend (DESIGN §6/§9) — the fabric backend. One JetStream STREAM per topic, so
 * the stream sequence number is a strictly increasing per-topic order key; `cursor` and
 * `backendMsgId` both qualify that sequence with the stream's incarnation, because a re-provisioned
 * stream restarts at 1.
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
  private connecting = false;
  private stopped = false;
  private epoch = 0;
  private readonly ensured = new Map<string, Promise<void>>();
  private readonly incarnations = new Map<string, string>();
  private readonly subscriptions: Closeable[] = [];

  async connect(config: BackendConfig): Promise<void> {
    if (this.nc !== undefined || this.connecting) {
      throw new Error(
        'parley-nats: already connected (or a connect() is still in flight) — call disconnect() ' +
          'first. A second connect() would strand the previous connection, whose unbounded ' +
          'reconnect loop keeps its socket alive with no way for the caller to reclaim it',
      );
    }
    assertKnownConfigKeys(config);
    const cfg = config as NatsBackendConfig;
    const subjectPrefix = validatePrefix('subject_prefix', cfg.subject_prefix, 'parley.', /[*>\s]/);
    const streamPrefix = validatePrefix(
      'stream_prefix',
      cfg.stream_prefix,
      'PARLEY_',
      /[.*>/\\\s]/,
      MAX_STREAM_NAME_BYTES,
    );
    const retentionDays = validateRetentionDays(cfg.retention_days);
    assertNoServerCredentials(cfg);
    // Report on stderr, NEVER stdout, so that cli.ts's JSON-RPC channel stays parseable.
    for (const risk of plaintextCredentialRisks(cfg)) console.warn(`[parley-nats] SECURITY: ${risk}`);
    const epoch = this.epoch;
    this.connecting = true;
    let nc: NatsConnection;
    let jsm: JetStreamManager;
    try {
      nc = await connect(connectionOptions(cfg));
      try {
        jsm = await nc.jetstreamManager();
      } catch (err) {
        await nc.close().catch(() => undefined);
        throw err;
      }
    } finally {
      this.connecting = false;
    }
    // Keep the epoch check: `disconnect()` that landed inside this connect() found no handles to
    // tear down, so publishing these ones now hands a caller that already awaited teardown a live
    // plugin — and drops a socket whose unbounded reconnect loop nobody can reach.
    if (this.epoch !== epoch) {
      await nc.close().catch(() => undefined);
      throw new Error(
        'parley-nats: disconnect() landed inside this connect() — the new connection was closed ' +
          'instead of published. Call connect() again if the plugin is meant to be live.',
      );
    }
    this.subjectPrefix = subjectPrefix;
    this.streamPrefix = streamPrefix;
    this.retentionDays = retentionDays;
    this.stopped = false;
    this.epoch += 1;
    this.ensured.clear();
    this.incarnations.clear();
    this.nc = nc;
    this.js = nc.jetstream();
    this.jsm = jsm;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.epoch += 1;
    const closing = this.subscriptions.splice(0).map(async (sub) => {
      try {
        await sub.close();
      } catch {
        /* already closing */
      }
    });
    // Keep the bounded race: a closer that deletes a server-side consumer needs the link, which is
    // exactly what an outage teardown does not have.
    await Promise.race([Promise.all(closing), delay(DRAIN_TIMEOUT_MS)]);
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
    const stream = this.streamName(topic);
    let published: string | undefined;
    const seq = await this.withStream(topic, async () => {
      published = this.incarnations.get(stream);
      const ack = await this.requireJs().publish(this.subject(topic), enc.encode(payload));
      return ack.seq;
    });
    await this.observeIncarnation(topic);
    if (this.incarnations.get(stream) !== published) {
      await this.confirmSequence(stream, seq, payload);
    }
    return asBackendMsgId(this.msgId(topic, seq));
  }

  /**
   * A `PubAck` carries a stream and a sequence but no incarnation, so a stream re-provisioned around
   * the publish leaves half of the id unproven. Keep this confirmation, so that a message acked by
   * an incarnation that is already gone is reported as lost rather than handed back under an id the
   * surviving incarnation will mint again for a DIFFERENT message — which core's dedup then drops.
   */
  private async confirmSequence(stream: string, seq: number, payload: string): Promise<void> {
    let stored: StoredMsg;
    try {
      stored = await this.requireJsm().streams.getMessage(stream, { seq });
    } catch (err) {
      // Keep this narrow to a definite "no message there": an inconclusive read leaves the observed
      // incarnation the best available, and rejecting a post whose message DID land tells the caller
      // to send it twice.
      if (!isMessageMissing(err)) return;
      throw ackIncarnationUnknown(stream, seq);
    }
    if (dec.decode(stored.data) !== payload) throw ackIncarnationUnknown(stream, seq);
  }

  /**
   * Read the incarnation the id will carry AFTER the ack and OUTSIDE `withStream`'s retry: keep both,
   * so that a stream re-provisioned without this plugin ever seeing a 503 is caught by the sequence
   * read-back, and so that a failure here re-publishes nothing — the message has already landed, so
   * this stays best-effort rather than telling the caller to post it twice.
   */
  private async observeIncarnation(topic: Topic): Promise<void> {
    const stream = this.streamName(topic);
    try {
      this.noteIncarnation(stream, await this.requireJsm().streams.info(stream));
    } catch {
      /* the ack stands; the cached incarnation is the best available */
    }
  }

  // Keep this `async`, so that a rejected `since` REJECTS: a synchronous throw out of a
  // Promise-returning seam method escapes every caller that only wrote `.catch()`.
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const limit = normalizeLimit(args.limit, args.topic);
    const since = parseCursor(args.since);
    // Keep the deadline out here: the wait for an absent stream and the read itself are two stages
    // of ONE budget, and a deadline minted inside either hands the other a fresh one.
    const deadline = Date.now() + (args.blockMs ?? 0);
    const info = await this.streamForRead(args, deadline);
    if (info === undefined) return absentTopicPage(args);
    try {
      return await this.readRecent(args, since, deadline, info, limit);
    } catch (err) {
      // A stream that vanished mid-read is the absent topic again, and a read must not put it back:
      // re-provisioning here is what let a caller-named topic spend the cluster's stream budget.
      if (!isStreamMissing(err)) throw err;
      return absentTopicPage(args);
    }
  }

  /**
   * The topic's stream if the server already has one, else `undefined` — a read NEVER creates one.
   * Keep every read path here rather than on {@link ensureStream}, so that a topic named by an
   * untrusted inbound message cannot spend the cluster's stream and storage budget with calls that
   * write nothing. `post` and `subscribe` still provision: both are gated by the topic allowlist.
   * A blocking read polls instead of creating, so a long-poll issued before the peer's first `post`
   * still waits for the stream that post will make.
   */
  private async streamForRead(
    args: FetchRecentArgs,
    deadline: number,
  ): Promise<StreamInfo | undefined> {
    const blocking = (args.blockMs ?? 0) > 0;
    for (;;) {
      const info = await this.existingStream(args.topic);
      if (info !== undefined) return info;
      const remaining = deadline - Date.now();
      if (!blocking || remaining <= 0 || this.stopped) return undefined;
      await delay(Math.min(remaining, ABSENT_STREAM_POLL_MS));
    }
  }

  private async existingStream(topic: Topic): Promise<StreamInfo | undefined> {
    const name = this.streamName(topic);
    const subject = this.subject(topic);
    let info: StreamInfo;
    try {
      info = await this.requireJsm().streams.info(name);
    } catch (err) {
      if (!isStreamMissing(err)) throw err;
      await this.refuseRivalStream(name, subject);
      return undefined;
    }
    assertCaptures(name, subject, info.config.subjects ?? []);
    this.noteIncarnation(name, info);
    return info;
  }

  /**
   * No stream under THIS config's name — but a stream under another name may already carry the
   * topic's subject, which is a bridge pointed at the wrong stream rather than an empty topic.
   * Keep the check, so that a diverging `stream_prefix` reports the field the operator can change
   * on the read path too; `post` learns the same thing from the overlap its `streams.add` is
   * refused with, and a read must not create a stream to find out.
   */
  private async refuseRivalStream(name: string, subject: string): Promise<void> {
    const rival = await this.requireJsm()
      .streams.find(subject)
      .catch(() => undefined);
    if (rival === undefined || rival === name) return;
    throw new Error(
      `nats stream ${name} does not exist, but ${rival} already captures ${JSON.stringify(subject)} — stream_prefix differs from the instance that created it`,
    );
  }

  private async readRecent(
    args: FetchRecentArgs,
    since: ParsedCursor | undefined,
    deadline: number,
    info: StreamInfo,
    limit: number,
  ): Promise<FetchRecentResult> {
    const stream = this.streamName(args.topic);
    const lastSeq = info.state.last_seq;
    const firstSeq = info.state.first_seq;
    // A cursor minted by a DIFFERENT incarnation names a sequence of a stream that no longer
    // exists: re-provisioning restarts the sequences at 1, so that number says nothing about where
    // the new stream's history begins. Keep the fall back to the retained window, so that catch-up
    // neither goes deaf waiting on a sequence that will not come nor silently skips everything the
    // new incarnation holds below it. A legacy bare cursor names no incarnation, so it can only be
    // judged by the tail it sits above.
    const restarted =
      since !== undefined &&
      (since.incarnation === undefined
        ? since.seq > lastSeq
        : since.incarnation !== this.incarnation(stream));
    const emptyCursor =
      since === undefined || restarted ? this.cursorAt(stream, lastSeq) : (args.since as Cursor);
    const blockMs = args.blockMs ?? 0;
    const waitOrNothing = async (startSeq: number): Promise<FetchRecentResult> =>
      blockMs > 0
        ? this.blockingFetch(stream, args.topic, startSeq, limit, deadline, emptyCursor)
        : { messages: [], nextCursor: emptyCursor };
    // Keep the wait keyed on an EMPTY PAGE rather than on the pre-check that predicted one: every
    // counter the pre-check reads is stream-wide, so on a stream wider than the topic it computes a
    // window the filtered pull then answers with nothing — and a caller's `block_ms` would buy a
    // server-side consumer create-and-delete instead of the wait it asked for.
    const pageOrWait = async (messages: Message[], startSeq: number): Promise<FetchRecentResult> => {
      const nextCursor = this.shortReadCursor(stream, messages, startSeq);
      return messages.length === 0 && blockMs > 0
        ? this.blockingFetch(stream, args.topic, startSeq, limit, deadline, nextCursor)
        : { messages, nextCursor };
    };

    if (info.state.messages === 0) return waitOrNothing(Math.max(lastSeq + 1, 1));

    // Every counter in `state` is STREAM-wide, and `last_seq` is a SEQUENCE where `limit` is a
    // COUNT: it moves for a message this topic deleted and for a message on a subject this topic
    // does not own, so a window sized down from it can hold nothing at all. Anchor on the last
    // message the topic itself has — and keep the fall back to `last_seq`, so that a topic with no
    // message of its own inside a wider stream (the one shape `last_by_subj` answers with a 404) is
    // still served by the widening below.
    const tailSeq = (await this.tailSequence(stream, args.topic)) ?? lastSeq;

    if (since !== undefined && !restarted) {
      // JetStream prunes from the front (`max_age`), and a pull below `first_seq` starts at the
      // first surviving sequence rather than stalling. Keep the clamp anyway, so that an empty read
      // of a pruned window resumes ABOVE the gap: without it the cursor of that page is the `since`
      // it was handed, and catch-up re-reads a range the server will never fill again.
      const startSeq = Math.max(since.seq + 1, firstSeq, 1);
      if (startSeq > tailSeq) return waitOrNothing(startSeq);
      const read = await this.pull(stream, args.topic, startSeq, Math.min(limit, tailSeq - startSeq + 1), tailSeq);
      return pageOrWait(read, startSeq);
    }

    // The since-less page is the NEWEST `limit` messages, and the window above `tailSeq` may hold
    // none of them (deletes, or a foreign publisher on a stream wider than this topic). Keep the
    // walk BACKWARDS in growing windows, so that a deep hole costs work proportional to the hole
    // rather than to the retained history: reading the whole range in one pull instead makes core's
    // cold start stream — and materialize — every message the topic ever had to return `limit`.
    const newest: Message[] = [];
    let startSeq = tailSeq + 1;
    for (let span = limit, top = tailSeq; newest.length < limit && top >= firstSeq; span *= WIDEN_FACTOR) {
      startSeq = Math.max(firstSeq, top - span + 1, 1);
      const read = await this.pull(stream, args.topic, startSeq, top - startSeq + 1, top, limit - newest.length);
      newest.unshift(...read);
      if (startSeq <= firstSeq) break;
      top = startSeq - 1;
    }
    return pageOrWait(newest, startSeq);
  }

  /** Sequence of the topic's own last message, when the server will name it. */
  private async tailSequence(stream: string, topic: Topic): Promise<number | undefined> {
    return this.requireJsm()
      .streams.getMessage(stream, { last_by_subj: this.subject(topic) })
      .then((msg) => msg.seq as number | undefined)
      .catch(() => undefined);
  }

  /**
   * One ephemeral pull from `startSeq`, ended by `want` messages, `tailSeq`, or a quiet link.
   * Keep `keep` bounding what is RETAINED: a window is a range of sequences, so `want` messages may
   * be far more than the page needs, and holding them all makes a page's memory proportional to the
   * history rather than to `limit`.
   */
  private async pull(
    stream: string,
    topic: Topic,
    startSeq: number,
    want: number,
    tailSeq: number,
    keep = want,
  ): Promise<Message[]> {
    // Keep the handle captured at entry: `disconnect()` clears `this.jsm` as soon as its closers
    // return, and reading it later instead skips the delete and leaks the consumer.
    const jsm = this.requireJsm();
    const ephemeral = new EphemeralConsumer(jsm, stream);
    // Keep every step from `consumers.add` on inside the try, so that a throw still reaches the
    // finally's delete — an ephemeral consumer nobody deletes lingers for `inactive_threshold`.
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let wentQuiet = false;
    const closer: Closeable = {
      close: async () => {
        void batch?.close();
        await ephemeral.reap();
      },
    };
    this.subscriptions.push(closer);
    try {
      const setupStarted = Date.now();
      const name = await ephemeral.add({
        filter_subject: this.subject(topic),
        deliver_policy: DeliverPolicy.StartSequence,
        opt_start_seq: startSeq,
        ack_policy: AckPolicy.None,
        inactive_threshold: INACTIVE_NS,
      });
      const consumer = await this.requireJs().consumers.get(stream, name);
      const patience = pullPatience(Date.now() - setupStarted);
      batch = await consumer.fetch({ max_messages: want, expires: patience.expires });
      // Keep the idle close: `want` is an upper bound over a range that may be sparse — a deleted or
      // pruned message anywhere in it otherwise holds the pull for its whole `expires` on every call.
      const live = batch;
      const armIdleClose = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          wentQuiet = true;
          void live.close();
        }, patience.idleMs);
      };
      armIdleClose();
      try {
        let read = 0;
        for await (const m of batch) {
          armIdleClose();
          // Keep the tail EXCLUSIVE of what follows it: a window is one step of a walk, and a
          // message above its top belongs to the step already taken — taking it again duplicates it.
          if (m.seq > tailSeq) break;
          messages.push(this.rowToMessage(topic, m.seq, dec.decode(m.data)));
          if (messages.length > keep) messages.splice(0, messages.length - keep);
          read += 1;
          if (read >= want || m.seq >= tailSeq) break;
        }
      } catch (err) {
        if (!wentQuiet) throw err;
      }
    } finally {
      clearTimeout(idle);
      this.unregister(closer);
      void batch?.close();
      await ephemeral.reap();
    }
    return messages;
  }

  private unregister(closer: Closeable): void {
    const i = this.subscriptions.indexOf(closer);
    if (i >= 0) this.subscriptions.splice(i, 1);
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

    const jsm = this.requireJsm();
    const ephemeral = new EphemeralConsumer(jsm, stream);
    // Keep every step from `consumers.add` on inside the try, so that a throw still reaches the
    // finally's delete — an ephemeral consumer nobody deletes lingers for `inactive_threshold`.
    const messages: Message[] = [];
    let batch: ConsumerMessages | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let polling = false;
    let cleanedUp = (): void => undefined;
    const cleanup = new Promise<void>((resolve) => {
      cleanedUp = () => resolve();
    });
    // Keep the closer registered BEFORE the consumer is asked for and waiting on this read's own
    // cleanup: `disconnect()` drops its handles the moment its closers return, so one registered
    // late leaves a consumer created inside the teardown window, and one that returns on
    // `batch.close()` alone leaves the consumer this read is still about to delete.
    const closer: Closeable = {
      close: async () => {
        void batch?.close();
        if (polling) await Promise.race([cleanup, delay(DRAIN_TIMEOUT_MS)]);
        await ephemeral.reap();
      },
    };
    this.subscriptions.push(closer);
    try {
      const name = await ephemeral.add({
        filter_subject: this.subject(topic),
        deliver_policy: DeliverPolicy.StartSequence,
        opt_start_seq: startSeq,
        ack_policy: AckPolicy.None,
        inactive_threshold: INACTIVE_NS,
      });
      const consumer = await this.requireJs().consumers.get(stream, name);
      // Keep the 1000ms floor: nats.js rejects a shorter `expires`, and the timer below — not
      // `expires` — is what honours a sub-second `blockMs`.
      batch = await consumer.fetch({ max_messages: limit, expires: Math.max(remaining, 1000) });
      polling = true;

      const live = batch;
      // Keep the timer armed off the LIVE clock, so that setup round-trips cannot push the return
      // past the caller's `blockMs`.
      timer = setTimeout(() => {
        expired = true;
        void live.close();
      }, Math.max(deadline - Date.now(), 0));

      for await (const m of batch) {
        if (this.stopped) break;
        messages.push(this.rowToMessage(topic, m.seq, dec.decode(m.data)));
        // Keep the single-message return, so that a long-poll wakes its caller at once; the
        // remainder of a burst stays in the stream and core polls it.
        break;
      }
    } catch (err) {
      // Keep this narrow to the two terminations we caused ourselves, so that a long-poll fails the
      // way the same read without `block_ms` does instead of reporting every backend fault as
      // "nothing new" forever.
      if (!expired && !this.stopped) throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.unregister(closer);
      void batch?.close();
      await ephemeral.reap();
      cleanedUp();
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
   * event at all — and so does a break in the consumer's delivery sequence, which is the only
   * evidence left of an `AckPolicy.None` message the server sent into a link that was already gone.
   * The outer loop honors `disconnect()`: the registered closer plus the epoch it captured stop it
   * without a rebuild, as does a permanently closed connection. The epoch is what makes teardown
   * final — `disconnect()` retires every loop, so one still parked in its backoff cannot wake into a
   * later `connect()`'s live handles and deliver to a handler its owner already dropped.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const epoch = this.epoch;
    const running = (): boolean => this.epoch === epoch && this.live();
    const retired = (): boolean => this.epoch !== epoch || this.stopped;
    // Keep the handle captured at entry, as `pull()` does: `disconnect()` clears `this.jsm` as soon
    // as its closers return, and reading it inside the loop instead skips the delete and leaks the
    // consumer for its whole `inactive_threshold`.
    const jsm = this.requireJsm();
    const stream = this.streamName(topic);
    const filterSubject = this.subject(topic);
    const seeded = await this.streamInfo(topic);
    let lastSeq = seeded.state.last_seq;
    let created = seeded.created;
    let current: ConsumerMessages | undefined;
    let ephemeral = new EphemeralConsumer(jsm, stream);
    this.subscriptions.push({
      close: async () => {
        await current?.close();
        await ephemeral.reap();
      },
    });

    void (async () => {
      let rebuild = false;
      while (running()) {
        let iter: ConsumerMessages;
        try {
          if (rebuild) await delay(RESUBSCRIBE_BACKOFF_MS);
          if (!running()) break;
          rebuild = true;
          // A recreated stream restarts its sequences, so a position carried over from the old one
          // would skip the new stream's messages (or ask for a sequence past its tail forever).
          const info = await this.streamInfo(topic);
          this.noteIncarnation(stream, info);
          if (info.created !== created) {
            created = info.created;
            lastSeq = 0;
          }
          if (!running()) break;
          // Keep the new reaper and its `add` in ONE synchronous step: the closer above reads this
          // slot, so a teardown that interleaved between them would watch the wrong consumer.
          ephemeral = new EphemeralConsumer(jsm, stream);
          const name = await ephemeral.add({
            filter_subject: filterSubject,
            deliver_policy: DeliverPolicy.StartSequence,
            opt_start_seq: lastSeq + 1,
            ack_policy: AckPolicy.None,
            inactive_threshold: INACTIVE_NS,
          });
          const consumer = await this.requireJs().consumers.get(stream, name);
          current = await consumer.consume();
          iter = current;
        } catch {
          await ephemeral.reap();
          if (!running()) break;
          continue; // backend momentarily unreachable — retry the consumer after the backoff
        }

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
          let nextDelivery = 1;
          let stale = false;
          for await (const m of iter) {
            // Keep draining a closed iterator instead of breaking out: nats.js runs the teardown
            // that stops the status listeners as a QUEUED item, so an abandoned iterator leaves
            // `statusTask` below awaiting forever.
            if (stale) continue;
            // Keep the delivery-sequence check, counted from 1 so the FIRST delivery is checked
            // too: with `AckPolicy.None` the server counts a message as delivered the moment it
            // writes it to the link, so a gap here — or a first message that is not delivery 1 —
            // is a message no reconnect will resend; only rebuilding from `lastSeq + 1` gets it
            // back, and any primed-state exemption hides the hole that opened before it arrived.
            if (retired() || m.info.deliverySequence !== nextDelivery) {
              stale = true;
              void iter.close().catch(() => undefined);
              continue;
            }
            nextDelivery = m.info.deliverySequence + 1;
            lastSeq = m.seq;
            try {
              handler(this.rowToMessage(topic, m.seq, dec.decode(m.data)));
            } catch {
              /* handler is best-effort (DESIGN §6) */
            }
          }
        } catch {
          /* iterator closed on disconnect or consumer loss */
        }
        await statusTask;
        await ephemeral.reap();
        if (retired()) break; // only a clean disconnect ends the loop; every other exit rebuilds
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
        const subject = this.subject(topic);
        try {
          const config: Partial<StreamConfig> = { name, subjects: [subject] };
          if (this.retentionDays !== undefined) {
            config.max_age = Math.round(this.retentionDays * NS_PER_DAY);
          }
          this.noteIncarnation(name, await this.requireJsm().streams.add(config));
        } catch (err) {
          // Keep this swallow narrow to "already exists", so that a real add failure still surfaces
          // instead of being cached as a stream that was never created.
          const msg = err instanceof Error ? err.message : String(err);
          if (/overlap/i.test(msg)) {
            throw new Error(
              `nats stream ${name} cannot capture ${subject} — another stream on this cluster already does: stream_prefix differs from the instance that created it while subject_prefix matches (${msg})`,
            );
          }
          if (!/already in use|already exists|name already/i.test(msg)) throw err;
          const info = await this.requireJsm().streams.info(name);
          assertCaptures(name, subject, info.config.subjects ?? []);
          this.noteIncarnation(name, info);
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
    const name = this.streamPrefix + safeName(topic, sanitizeName);
    const bytes = Buffer.byteLength(name, 'utf8');
    if (bytes > MAX_STREAM_NAME_BYTES) {
      throw new Error(
        `nats stream name ${JSON.stringify(name)} is ${bytes} bytes, over JetStream's limit of ${MAX_STREAM_NAME_BYTES} — shorten the topic ${JSON.stringify(String(topic))} or stream_prefix ${JSON.stringify(this.streamPrefix)}`,
      );
    }
    return name;
  }

  private noteIncarnation(stream: string, info: { created?: string }): void {
    this.incarnations.set(stream, incarnationToken(info.created));
  }

  private incarnation(stream: string): string {
    return this.incarnations.get(stream) ?? UNKNOWN_INCARNATION;
  }

  /**
   * The dedup key AND the order key. A stream deleted and re-created out-of-band restarts its
   * sequences at 1, so the bare sequence would hand core an id it has already seen — dedup would
   * swallow a genuinely new message — and a persisted cursor would name a position in a stream that
   * no longer exists, which the new incarnation reaches again for entirely different messages. The
   * stream's `created` stamp distinguishes the incarnations for both.
   */
  private cursorAt(stream: string, seq: number): Cursor {
    return asCursor(`${this.incarnation(stream)}-${seq}`);
  }

  private msgId(topic: Topic, seq: number): string {
    return String(this.cursorAt(this.streamName(topic), seq));
  }

  /**
   * A short read (expiry, slow link, filter mismatch) must resume immediately BEFORE the window it
   * failed to read: keep `startSeq - 1`, so that an empty page can never park the persisted cursor
   * at the tail and silently drop everything in between.
   */
  private shortReadCursor(stream: string, messages: Message[], startSeq: number): Cursor {
    return messages.at(-1)?.cursor ?? this.cursorAt(stream, Math.max(startSeq - 1, 0));
  }

  private rowToMessage(topic: Topic, seq: number, raw: string): Message {
    return rowToMessage(topic, this.msgId(topic, seq), raw);
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
 * The page a read of a topic with no stream returns. The bare `0` names no incarnation and sits
 * below every sequence, so the catch-up that follows the peer's first `post` starts at the new
 * stream's first message instead of being judged a cursor from a dead incarnation and served the
 * newest window — which would skip everything below it.
 */
const ABSENT_TOPIC_CURSOR = asCursor('0');

const absentTopicPage = (args: FetchRecentArgs): FetchRecentResult => ({
  messages: [],
  nextCursor: args.since ?? ABSENT_TOPIC_CURSOR,
});

/** A cursor's two halves: which incarnation of the stream minted it, and where in it. */
interface ParsedCursor {
  /** Absent in the bare-sequence form: a legacy cursor, or {@link ABSENT_TOPIC_CURSOR}. */
  incarnation?: string;
  seq: number;
}

/**
 * A cursor this plugin minted is `<stream incarnation>-<sequence>`; the bare decimal sequence names
 * no incarnation and still parses. Anything else is caller input (`parley_fetch_recent` takes
 * `since` as a free string) and is rejected here rather than coerced by `Number()` into a
 * silently-empty page or an opaque driver error.
 */
function parseCursor(since: Cursor | undefined): ParsedCursor | undefined {
  if (since === undefined) return undefined;
  const parts = /^(?:([0-9A-Za-z]+)-)?(\d+)$/.exec(since);
  const seq = parts === null ? Number.NaN : Number(parts[2]);
  if (parts === null || !Number.isSafeInteger(seq)) {
    throw new Error(
      `invalid nats cursor ${JSON.stringify(String(since))} — expected a JetStream sequence number`,
    );
  }
  return parts[1] === undefined ? { seq } : { incarnation: parts[1], seq };
}

const DEFAULT_PAGE = 100;

const describeValue = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v) : String(v);

/**
 * A page size below 1 — or one that is not a number at all — makes every window this read computes
 * empty, and an empty page still mints a cursor. Reject it here, before any cursor exists: a
 * `nextCursor` core persists for a page it was never going to be given is silent, permanent loss of
 * everything under it.
 */
function normalizeLimit(limit: number | undefined, topic: Topic): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `invalid nats limit ${describeValue(limit)} for topic ${JSON.stringify(String(topic))} — ` +
        'expected an integer of at least 1',
    );
  }
  return limit;
}

const CONFIG_KEYS = [
  'servers',
  'subject_prefix',
  'stream_prefix',
  'retention_days',
  'token',
  'user',
  'pass',
  'creds_file',
  'nkey_seed',
  'tls',
] as const satisfies readonly (keyof NatsBackendConfig)[];

/**
 * A key this plugin does not read is a key it silently drops, and every field here is either a
 * credential or an addressing decision: a misspelled `token` connects anonymously, a misspelled
 * `subject_prefix` addresses a different stream than the sibling instance the operator meant to
 * share with. Refuse at connect(), naming the offender, rather than honouring the default.
 */
function assertKnownConfigKeys(config: BackendConfig): void {
  for (const key of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-nats: unknown backend_config key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
      );
    }
  }
}

/** Stands in for a topic token, so a prefix is judged by the name it actually composes. */
const PROBE_TOKEN = 'topic';

/**
 * A prefix is pasted straight onto a subject or a stream name, so an operator's typo becomes a
 * NATS wildcard or an illegal name. A wildcard is the dangerous one: `pw.*.` makes the per-topic
 * stream capture `pw.<anything>.<topic>`, delivering a foreign publisher's messages as if they were
 * on an allowlisted topic. Rejected at connect(), naming the field, rather than at the first post
 * with a driver error that names neither.
 */
function validatePrefix(
  field: string,
  value: string | undefined,
  fallback: string,
  illegal: RegExp,
  maxComposedBytes?: number,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`invalid ${field} ${JSON.stringify(value)} — expected a string`);
  }
  const offender = (illegal.exec(value) ?? CONTROL_CHARS.exec(value))?.[0];
  if (offender !== undefined) {
    throw new Error(
      `invalid ${field} ${JSON.stringify(value)} — ${JSON.stringify(offender)} is not allowed in a NATS name`,
    );
  }
  const composed = value + PROBE_TOKEN;
  if (composed.split('.').some((token) => token === '')) {
    throw new Error(
      `invalid ${field} ${JSON.stringify(value)} — it composes the illegal name ${JSON.stringify(composed)}: no dot-separated token of a NATS name may be empty`,
    );
  }
  const bytes = Buffer.byteLength(composed, 'utf8');
  if (maxComposedBytes !== undefined && bytes > maxComposedBytes) {
    throw new Error(
      `invalid ${field} ${JSON.stringify(value)} — it composes ${JSON.stringify(composed)} at ${bytes} bytes, over the ${maxComposedBytes}-byte limit, so no topic could be named at all`,
    );
  }
  return value;
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
function rowToMessage(topic: Topic, id: string, raw: string): Message {
  const fields = decodeFields(raw);
  return buildMessage({
    topic,
    sender: asString(fields.sender),
    content: asString(fields.content),
    timestamp: asString(fields.ts),
    id,
    cursor: id,
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

/** NATS subject interest: `*` matches exactly one token, `>` one or more trailing tokens. */
export function captures(pattern: string, subject: string): boolean {
  const tokens = pattern.split('.');
  const target = subject.split('.');
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>') return target.length > i;
    if (i >= target.length) return false;
    if (tokens[i] !== '*' && tokens[i] !== target[i]) return false;
  }
  return tokens.length === target.length;
}

/**
 * The stream a topic maps to must carry that topic's subject. A stream that does not is a bridge
 * pointed at the wrong place, not an empty topic — refuse on EVERY path that meets one, so that a
 * read cannot answer "nothing here" forever while the messages sit under another prefix.
 */
function assertCaptures(name: string, subject: string, subjects: string[]): void {
  if (subjects.some((pattern) => captures(pattern, subject))) return;
  throw new Error(
    `nats stream ${name} already exists capturing ${JSON.stringify(subjects)}, which does not include ${JSON.stringify(subject)} — subject_prefix or stream_prefix differs from the instance that created it`,
  );
}

const ackIncarnationUnknown = (stream: string, seq: number): Error =>
  new Error(
    `nats stream ${stream} was re-provisioned around this publish — sequence ${seq} does not hold the posted message in the incarnation now on the server, so it has no unambiguous id`,
  );

/** JetStream's answer when a sequence holds nothing, as opposed to a read that could not be made. */
function isMessageMissing(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === '404') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /no message found|message not found|404/i.test(msg);
}

/** A stream that vanished out-of-band: JetStream 404s the manager and 503s the publish. */
function isStreamMissing(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === '503') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /stream not found|no responders|503/i.test(msg);
}

/** The schemes nats.js opens unencrypted. A bare `host:port` is one of them — it reads as `nats:`. */
const PLAINTEXT_SCHEMES = ['nats:', 'ws:'];
/** Where nats.js connects when `backend_config.servers` is unset. */
const DEFAULT_SERVERS = '127.0.0.1:4222';
/** What stands in for a URL's userinfo everywhere a server address is named. */
const REDACTED_USERINFO = '<redacted>';

/** The scheme's `xxx://`, as written, or `''` — a bare `host:port` carries none. */
const schemePrefix = (server: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//i.exec(server)?.[0] ?? '';

/** Where an authority's userinfo ends: the LAST `@`, since a password may hold one. */
const userinfoEnd = (authority: string): number =>
  (/^[^/?#]*/.exec(authority)?.[0] ?? '').lastIndexOf('@');

/**
 * `server` with any URL userinfo replaced. Keep every diagnostic that names a server routed through
 * this, so that a password written into the address — `nats://user:pass@host`, the standard NATS
 * spelling — cannot reach a log line.
 */
export function redactUserinfo(server: string): string {
  const text = server.trim();
  const prefix = schemePrefix(text);
  const authority = text.slice(prefix.length);
  const at = userinfoEnd(authority);
  return at < 0 ? text : `${prefix}${REDACTED_USERINFO}@${authority.slice(at + 1)}`;
}

/**
 * The server as written — userinfo redacted — when it would carry the CONNECT frame's credential in
 * the clear, else undefined. nats.js upgrades a `nats://`/`ws://` link only when
 * `backend_config.tls` asks it to or the server refuses to go on without it, and it sends
 * `token`/`user`/`pass` in the first frame either way — so a plaintext scheme to a host we cannot
 * PROVE is loopback is a credential on the wire. Keep an unparseable server on the warned side, so
 * that an address this cannot classify is reported rather than excused.
 */
export function plaintextRemoteServer(server: string): string | undefined {
  const text = server.trim();
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && !PLAINTEXT_SCHEMES.includes(scheme)) return undefined;
  // Keep the authority split by hand rather than through `URL`, so that every scheme is classified
  // by the same rules: `URL` canonicalizes an integer-form IPv4 host for `ws:` and leaves it alone
  // for `nats:`, which would excuse under one scheme exactly what it warns about under the other.
  const authority = scheme === undefined ? text : text.slice(scheme.length + 2);
  const host = (/^([^/?#]*)/.exec(authority)?.[1] ?? '')
    .slice(userinfoEnd(authority) + 1)
    .replace(/^(\[[^\]]*]):\d+$/, '$1')
    .replace(/^([^:[]*):\d+$/, '$1')
    .toLowerCase();
  return host !== '' && isLoopbackHost(host) ? undefined : redactUserinfo(text);
}

/**
 * nats.js builds its server list from the address's HOST alone (`servers.js` `hostPort()` keeps
 * `url.host`), so a credential written into a `servers` URL never reaches the CONNECT frame and the
 * link is opened anonymously. Refuse at connect(), naming the field and never the value, rather than
 * leaving an operator believing a cluster is authenticated.
 */
function assertNoServerCredentials(cfg: NatsBackendConfig): void {
  for (const server of [cfg.servers ?? DEFAULT_SERVERS].flat()) {
    const text = String(server).trim();
    const redacted = redactUserinfo(text);
    if (redacted === text) continue;
    throw new Error(
      `parley-nats: backend_config.servers ${JSON.stringify(redacted)} carries a credential in the ` +
        'URL, which nats.js drops before it connects — the link would be opened anonymously. Put ' +
        'it in backend_config.user/pass, token, creds_file or nkey_seed instead.',
    );
  }
}

/** Which `backend_config` fields would cross the link, named — never their values. */
const credentialFields = (cfg: NatsBackendConfig): string[] =>
  (['token', 'user', 'pass', 'creds_file', 'nkey_seed'] as const).filter(
    (field) => cfg[field] !== undefined,
  );

/**
 * One warning per `servers` entry that would put a configured credential on an unencrypted remote
 * link. A warning rather than a load error: a cluster fronted by a TLS-terminating sidecar, and a
 * loopback fixture, are both legitimate — but neither is a reason for the mistake to be silent.
 */
function plaintextCredentialRisks(cfg: NatsBackendConfig): string[] {
  const fields = credentialFields(cfg);
  if (fields.length === 0 || cfg.tls !== undefined) return [];
  const servers = [cfg.servers ?? DEFAULT_SERVERS].flat();
  return servers.flatMap((server) => {
    const plaintext = plaintextRemoteServer(String(server));
    return plaintext === undefined
      ? []
      : [
          `backend_config.servers ${JSON.stringify(plaintext)} is an unencrypted NATS scheme to a ` +
            'non-loopback host and backend_config.tls is unset, so the CONNECT frame carries ' +
            `backend_config.${fields.join('/')} across the network in the clear. Use tls:// (or ` +
            'wss://), or set backend_config.tls.',
        ];
  });
}

function connectionOptions(cfg: NatsBackendConfig): ConnectionOptions {
  const opts: ConnectionOptions = {
    servers: cfg.servers ?? DEFAULT_SERVERS,
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

// Subject tokens may not contain `.`, `*`, `>`, whitespace or a control character; stream names
// also bar `/ \`. Keep the control range folded here as well as rejected in `validatePrefix`, so
// that a topic — which a caller names through `post_topics`, unlike a prefix an operator writes —
// cannot compose a name the JetStream API answers with an unparseable frame.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s\u0000-\u001f\u007f]/g, '_');
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s\u0000-\u001f\u007f]/g, '_');
