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

const NS_PER_DAY = 86_400_000_000_000;
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
  private stopped = false;
  private epoch = 0;
  private readonly ensured = new Map<string, Promise<void>>();
  private readonly incarnations = new Map<string, string>();
  private readonly subscriptions: Closeable[] = [];

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as NatsBackendConfig;
    this.subjectPrefix = validatePrefix('subject_prefix', cfg.subject_prefix, 'parley.', /[*>\s]/);
    this.streamPrefix = validatePrefix('stream_prefix', cfg.stream_prefix, 'PARLEY_', /[.*>/\\\s]/);
    this.retentionDays = validateRetentionDays(cfg.retention_days);
    this.stopped = false;
    this.epoch += 1;
    this.ensured.clear();
    this.incarnations.clear();
    this.nc = await connect(connectionOptions(cfg));
    this.js = this.nc.jetstream();
    this.jsm = await this.nc.jetstreamManager();
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
    const since = parseCursor(args.since);
    // Keep the deadline out here: `withStream` runs its operation a second time when the stream
    // vanished mid-read, and a deadline minted inside that closure hands the retry a fresh budget —
    // twice the `block_ms` the caller was promised.
    const deadline = Date.now() + (args.blockMs ?? 0);
    return this.withStream(args.topic, () => this.readRecent(args, since, deadline));
  }

  private async readRecent(
    args: FetchRecentArgs,
    since: ParsedCursor | undefined,
    deadline: number,
  ): Promise<FetchRecentResult> {
    const stream = this.streamName(args.topic);
    const limit = args.limit ?? 100;
    const info = await this.requireJsm().streams.info(stream);
    this.noteIncarnation(stream, info);
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
      blockMs > 0 && args.since !== undefined
        ? this.blockingFetch(stream, args.topic, startSeq, limit, deadline, emptyCursor)
        : { messages: [], nextCursor: emptyCursor };

    if (info.state.messages === 0) return waitOrNothing(Math.max(lastSeq + 1, 1));

    // Every counter in `state` is STREAM-wide, and `last_seq` is a SEQUENCE where `limit` is a
    // COUNT: it moves for a message this topic deleted and for a message on a subject this topic
    // does not own, so a window sized down from it can hold nothing at all. Anchor on the last
    // message the topic itself has — and keep the fall back to `last_seq`, so that a server which
    // will not name that message (2.10 answers `last_by_subj` with 404 once the subject's newest
    // has been deleted) is still served by the widening below.
    const tailSeq = (await this.tailSequence(stream, args.topic)) ?? lastSeq;

    if (since !== undefined && !restarted) {
      // JetStream prunes from the front (`max_age`), so a `since` older than the retained window
      // must start at `first_seq`: the gap is gone either way, and asking below it stalls the pull
      // for its whole expiry waiting on sequences the server no longer has.
      const startSeq = Math.max(since.seq + 1, firstSeq, 1);
      if (startSeq > tailSeq) return waitOrNothing(startSeq);
      const read = await this.pull(stream, args.topic, startSeq, Math.min(limit, tailSeq - startSeq + 1), tailSeq);
      return { messages: read, nextCursor: this.shortReadCursor(stream, read, startSeq) };
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
    return { messages: newest, nextCursor: this.shortReadCursor(stream, newest, startSeq) };
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
    const jsm = this.requireJsm();
    const setupStarted = Date.now();
    const ci = await jsm.consumers.add(stream, {
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
    let idle: ReturnType<typeof setTimeout> | undefined;
    let wentQuiet = false;
    try {
      const consumer = await this.requireJs().consumers.get(stream, ci.name);
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
      void batch?.close();
      // Keep the handle captured at entry: `disconnect()` clears `this.jsm` as soon as its closers
      // return, and reading it here instead skips the delete and leaks the consumer.
      await jsm.consumers.delete(stream, ci.name).catch(() => undefined);
    }
    return messages;
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
    const ci = await jsm.consumers.add(stream, {
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
    let expired = false;
    let cleanedUp = (): void => undefined;
    const cleanup = new Promise<void>((resolve) => {
      cleanedUp = () => resolve();
    });
    let closer: Closeable | undefined;
    try {
      const consumer = await this.requireJs().consumers.get(stream, ci.name);
      // Keep the 1000ms floor: nats.js rejects a shorter `expires`, and the timer below — not
      // `expires` — is what honours a sub-second `blockMs`.
      batch = await consumer.fetch({ max_messages: limit, expires: Math.max(remaining, 1000) });

      const live = batch;
      // Keep the closer waiting on this read's own cleanup: `disconnect()` drops its handles the
      // moment its closers return, so a closer that returns on `live.close()` alone leaves the
      // ephemeral consumer undeleted on the server.
      closer = {
        close: async () => {
          void live.close();
          await Promise.race([cleanup, delay(DRAIN_TIMEOUT_MS)]);
        },
      };
      this.subscriptions.push(closer);
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
      if (closer !== undefined) {
        const i = this.subscriptions.indexOf(closer);
        if (i >= 0) this.subscriptions.splice(i, 1);
      }
      void batch?.close();
      await jsm.consumers.delete(stream, ci.name).catch(() => undefined);
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
    const stream = this.streamName(topic);
    const filterSubject = this.subject(topic);
    const seeded = await this.streamInfo(topic);
    let lastSeq = seeded.state.last_seq;
    let created = seeded.created;
    let current: ConsumerMessages | undefined;
    let currentName: string | undefined;
    this.subscriptions.push({
      close: async () => {
        await current?.close();
        await this.deleteConsumer(stream, currentName);
        currentName = undefined;
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
          const ci = await this.requireJsm().consumers.add(stream, {
            filter_subject: filterSubject,
            deliver_policy: DeliverPolicy.StartSequence,
            opt_start_seq: lastSeq + 1,
            ack_policy: AckPolicy.None,
            inactive_threshold: INACTIVE_NS,
          });
          currentName = ci.name;
          const consumer = await this.requireJs().consumers.get(stream, ci.name);
          iter = await consumer.consume();
        } catch {
          await this.deleteConsumer(stream, currentName);
          currentName = undefined;
          if (!running()) break;
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
        await this.deleteConsumer(stream, currentName);
        currentName = undefined;
        if (retired()) break; // only a clean disconnect ends the loop; every other exit rebuilds
      }
    })();
  }

  private async deleteConsumer(stream: string, name: string | undefined): Promise<void> {
    if (name === undefined) return;
    await this.jsm?.consumers.delete(stream, name).catch(() => undefined);
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
          const subjects = info.config.subjects ?? [];
          if (!subjects.some((pattern) => captures(pattern, subject))) {
            throw new Error(
              `nats stream ${name} already exists capturing ${JSON.stringify(subjects)}, which does not include ${JSON.stringify(subject)} — subject_prefix or stream_prefix differs from the instance that created it`,
            );
          }
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
    return this.streamPrefix + safeName(topic, sanitizeName);
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

/** A cursor's two halves: which incarnation of the stream minted it, and where in it. */
interface ParsedCursor {
  /** Absent in the legacy bare-sequence form, which names no incarnation at all. */
  incarnation?: string;
  seq: number;
}

/**
 * A cursor this plugin minted is `<stream incarnation>-<sequence>`; the bare decimal sequence is
 * the legacy form and still parses. Anything else is caller input (`parley_fetch_recent` takes
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
