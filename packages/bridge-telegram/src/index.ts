import { homedir } from 'node:os';
import { join } from 'node:path';
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
import {
  delay,
  fetchWithRetry,
  retryAfterFromHeader,
  statusOf,
} from '@sharptrick/parley-net-util';
import { keyOf, type ObservedRecord, ObservedStore, type StoredRecord } from './store.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface TelegramBackendConfig {
  /** Bot token from @BotFather. A secret — lives in `backend_config`/`.env`, never in code. */
  token?: string;
  /** Bot API base URL. Default `https://api.telegram.org` (override for tests / local servers). */
  api_url?: string;
  /**
   * Path of the observed-message JSONL store. Default {@link defaultStorePath} — an ABSOLUTE
   * path under the same state directory core keeps its read-state (cursors) in, so the two share
   * a lifetime. A store file that goes missing while a saved cursor survives invalidates that
   * cursor: sequences restart at 1 and the messages below the old cursor are unreachable.
   */
  store_path?: string;
  /**
   * `getUpdates` long-poll timeout (SECONDS — Telegram's unit). Default 25, accepted range
   * `[1, 50]`. `0` is Telegram's "short polling", which would turn the single ingestion loop into
   * a request flood against the bot token, so it is a load error rather than a knob.
   */
  poll_timeout_s?: number;
  /**
   * Parley topic → Telegram chat id. A topic missing from the map is used as the chat id
   * literal (numeric id string or `@channelusername`), so the map is optional sugar for
   * giving chats friendly topic names.
   */
  chat_map?: Record<string, string>;
  /**
   * Max observed records retained PER CHAT in the local JSONL store — per chat, not per topic:
   * `chat_map` can give one chat two topic names. The newest N are kept — on load AND on every
   * append — and the file is compacted, so a long-lived bridge on a busy chat can't grow the
   * store/RAM without limit or degrade `connect`. Older records fall outside Telegram's ~24-48h
   * `getUpdates` replay horizon anyway (see README "History limitations"). Default 10000.
   */
  observed_retention_per_chat?: number;
  /** Deprecated spelling of {@link observed_retention_per_chat}, which wins when both are set. */
  observed_retention_per_topic?: number;
  /**
   * Max distinct chats retained in the local JSONL store. Anyone who can add the bot to a
   * group can drive writes into `store_path`, so the chat count is bounded too; chats a
   * configured topic resolves to are always retained, and an unconfigured chat past the cap
   * displaces the least recently active unconfigured one. Default 1000.
   */
  observed_max_chats?: number;
}

/** The subset of a Telegram `Message` object this plugin reads. */
interface TgMessage {
  message_id: number;
  /** Unix seconds. Informational only — never used for ordering or dedup (DESIGN §5). */
  date: number;
  chat: { id: number | string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
  /** Media messages carry their text here instead of in `text`. */
  caption?: string;
}

/** The subset of a Telegram `Update` object this plugin reads. */
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

/** A live subscription: deliver anything whose observation sequence exceeds the watermark. */
interface Subscription {
  handler: MessageHandler;
  watermark: number;
  /** The Parley topic this subscriber named the chat by — stamped on what it receives. */
  topic: Topic;
}

/**
 * A `fetchRecent` long-poll parked on a chat. Resolved by the SHARED ingest path
 * (the one getUpdates loop, or an own post) when a message above `sinceSeq` lands, or
 * on `blockMs` timeout, or on disconnect. No second getUpdates consumer is ever opened.
 */
interface Waiter {
  /** Wake only for a message whose observation sequence is strictly greater than this. */
  sinceSeq: number;
  /** Idempotently unpark (message arrived, timeout, or disconnect) — self-cleans the waiter. */
  wake: () => void;
}

/**
 * Telegram Bot API backend (DESIGN §6/§9) — spoken to via the raw HTTP API with the global
 * `fetch`, no SDK dependency. Telegram is a hosted SaaS, unlike the self-hosted core backends:
 * there is no server of ours to configure, only a bot token from @BotFather.
 *
 * **Fit-contract strain — the one structural caveat of this backend.** The Bot API exposes NO
 * history endpoint, so this plugin keeps a small local persisted store ({@link ObservedStore},
 * append-only JSONL) of messages it has OBSERVED — its own sends (recorded from the
 * `sendMessage` response, because own posts never arrive via `getUpdates`) plus everything
 * delivered by `getUpdates`. `fetchRecent` can only replay what this bridge has seen —
 * **history from before the bot joined a chat, or from before this store file existed, cannot
 * be backfilled**. This strains the "durable, replayable history" line of the seam contract
 * (DESIGN §6); within the observed window the contract holds fully.
 *
 * IDs: `backendMsgId = '<chat_id>:<message_id>'` (composite — Telegram's `message_id` is only
 * unique PER CHAT) and `cursor = String(seq)`, the store's local OBSERVATION sequence. Telegram's
 * own `message_id` is minted when the sender's message is accepted, not when this bridge sees it,
 * so a foreign message minted before our post can be delivered after it and would sit forever
 * below a cursor already handed out; observation order is monotonic by construction and cannot.
 * Exclusive-`since` is a NUMERIC compare — never lexical (`'10' < '9'` lexically).
 *
 * Everything internal — the observed store, live subscriptions, long-poll waiters — is keyed by
 * the CANONICAL NUMERIC CHAT ID a topic resolves to, never by the topic string. `chat_map`, an
 * `@channelusername` literal and a numeric literal are three names for one chat, and inbound
 * updates carry only the numeric id; keying on it is what makes ingestion independent of which
 * seam call ran first, or of whether any topic had been named yet when the message arrived.
 *
 * Ingestion is ONE shared background `getUpdates` long-poll loop per plugin instance:
 * Telegram allows exactly ONE `getUpdates` consumer per bot token (a second gets HTTP 409),
 * so subscriptions share the loop rather than each opening their own. Run exactly one
 * Telegram bridge per bot token — see README.md, "Multiple concurrent sessions".
 */
export class TelegramPlugin implements BackendPlugin {
  private apiUrl = 'https://api.telegram.org';
  private token = '';
  private pollTimeoutS = 25;
  /** topic → chat id (unmapped topics fall through to the topic string itself). */
  private chatMap: Record<string, string> = {};
  private store?: ObservedStore;
  private storePath = '';
  private stopped = false;
  /**
   * Bumped by every `connect` and every `disconnect`. Everything a connect builds across an
   * await — the store, the poll loop, a memoized chat resolution — is published only while its
   * generation is still current, so a `disconnect` racing a `connect` cannot be overwritten by
   * the connect that was already in flight.
   */
  private generation = 0;
  /** A `connect` has claimed the instance but has not yet published (or failed). */
  private connecting = false;
  /** Live subscriptions per CHAT ID, fed by the shared getUpdates loop and by post(). */
  private readonly subs = new Map<string, Subscription[]>();
  /** Native long-poll waiters per CHAT ID, resolved by ingest / timeout / disconnect. */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** In-flight getUpdates long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  /** Memoized getMe (the bot's own identity), for resolveIdentity. */
  private me?: Promise<{ id: number; username?: string }>;
  /** Memoized `@channelusername` → numeric-id-string resolutions (one getChat per distinct name). */
  private canonicalById = new Map<string, Promise<string>>();
  /** Memoized topic → canonical numeric chat id (chat_map or literal, `@name` resolved). */
  private chatIdByTopic = new Map<string, Promise<string>>();
  /** Wall-clock of the last diagnostic PER KIND, so one failure can't silence an unrelated one. */
  private readonly lastReportAt = new Map<string, number>();

  async connect(config: BackendConfig): Promise<void> {
    if (this.store !== undefined || this.connecting) {
      throw new Error('TelegramPlugin: already connected — call disconnect() first');
    }
    // Claim the instance SYNCHRONOUSLY, before the first await: the check above is otherwise a
    // TOCTOU that lets a second connect start a second getUpdates consumer on a token that
    // allows one, and lets a connect publish its store over a disconnect that already ran.
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const cfg = config as TelegramBackendConfig;
      requireNumericKnobs(cfg);
      this.apiUrl = (cfg.api_url ?? 'https://api.telegram.org').replace(/\/+$/, '');
      this.token = cfg.token ?? '';
      this.pollTimeoutS = cfg.poll_timeout_s ?? 25;
      this.stopped = false;
      this.me = undefined;
      this.canonicalById = new Map();
      this.chatIdByTopic = new Map();
      this.chatMap = cfg.chat_map ?? {};
      if (this.token === '') {
        throw new Error(
          'TelegramPlugin: backend_config.token is required (bot token from @BotFather)',
        );
      }
      // Preflight: an unusable token or api_url must fail `connect` rather than come up as a
      // silent black hole that polls a rejecting API forever. Also warms the resolveIdentity memo.
      await this.getMe();
      this.stillCurrent(generation);
      // Resolve the configured chats BEFORE the store exists: the store needs the served set at
      // load time, or its chat cap evicts the operator's own chat in favour of a chat anyone who
      // added the bot to a group created — history the Bot API can never backfill.
      const served: string[] = [];
      for (const topic of Object.keys(this.chatMap)) {
        served.push(await this.chatIdFor(asTopic(topic)));
        this.stillCurrent(generation);
      }
      // Load the observed-message store up front — fetchRecent is a pure in-memory query.
      this.storePath = cfg.store_path ?? defaultStorePath();
      const store = new ObservedStore(
        this.storePath,
        cfg.observed_retention_per_chat ?? cfg.observed_retention_per_topic,
        cfg.observed_max_chats,
        served,
      );
      this.store = store;
      // ONE shared ingestion loop per instance (one getUpdates consumer per token — see class doc).
      void this.pollLoop(generation, store).catch((err: unknown) => {
        this.report(`getUpdates loop stopped: ${describe(err)}`);
      });
    } finally {
      if (generation === this.generation) this.connecting = false;
    }
  }

  /** Abort a connect whose generation a `disconnect` (or a later connect) has retired. */
  private stillCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw new Error('TelegramPlugin: connect was aborted by disconnect()');
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.connecting = false;
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.subs.clear();
    this.chatIdByTopic = new Map();
    // Unpark every native long-poll waiter so no blocked fetchRecent hangs past
    // teardown. Snapshot first: wake() mutates `waiters`. Each resumes, re-queries the (now
    // closed) store, and returns an empty page — returning early/empty is always safe.
    for (const set of [...this.waiters.values()]) for (const w of [...set]) w.wake();
    this.waiters.clear();
    this.store?.close();
    this.store = undefined;
    this.me = undefined;
    this.canonicalById = new Map();
  }

  /**
   * Single durable write path: `POST /sendMessage`, then ingest the returned message object
   * ourselves — **own posts never arrive via `getUpdates`** (Telegram does not echo a bot its
   * own messages), so recording the response is what makes them visible to `fetchRecent` and
   * to live subscribers on this instance. `identity` is a logical label only: Telegram stamps
   * the sender as the bot account behind the token (as the Matrix homeserver stamps its login).
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const store = this.require(this.store);
    void identity; // sender is the bot account; see JSDoc above.
    const chatId = await this.chatIdFor(topic);
    this.stillServing(store);
    const body: Record<string, unknown> = { chat_id: chatId, text: content };
    // Reply threading: only for a composite `<chat>:<mid>` naming THIS chat — a message id from
    // another chat is meaningless here (Telegram's message_id is per-chat) and would either 400
    // or thread onto an unrelated message that happens to share the number.
    const replyMid = parseCompositeMid(opts?.inReplyTo, chatId);
    if (replyMid !== undefined) body.reply_to_message_id = replyMid;
    const json = await this.call<{ result: TgMessage }>('POST', '/sendMessage', { body });
    const sentChatId = String(json.result.chat.id);
    const sentId = keyOf({ chat_id: sentChatId, message_id: json.result.message_id });
    // Re-assert AFTER the send too: a teardown landing here leaves a message Telegram has already
    // accepted and no store to record it in, and own posts never come back via `getUpdates`, so
    // reconnecting cannot recover it. Name the id, so that the caller knows what exists upstream.
    if (this.store !== store) {
      throw new Error(
        `TelegramPlugin not connected — the connection this call started on was torn down after ` +
          `Telegram accepted ${sentId}, so the message exists in the chat and is missing from the ` +
          `observed-message store at '${this.storePath}' (own posts never arrive via getUpdates).`,
      );
    }
    this.ingest(store, sentChatId, json.result);
    return asBackendMsgId(sentId);
  }

  /**
   * Durable catch-up = a query over the observed-message store: no history endpoint is ever
   * called, because the Bot API has none (see the class doc for what that means). The one network
   * cost is resolving an `@channelusername` topic to its numeric id — one memoized `getChat`,
   * already paid during `connect` for every `chat_map` entry — so a topic named only by an
   * `@name` literal can fail its FIRST catch-up if Telegram is unreachable.
   *
   * Exclusive `since` via a NUMERIC observation-sequence compare, ascending, sliced to `limit`.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const store = this.require(this.store);
    if (args.since !== undefined && !/^\d+$/.test(args.since as string)) {
      throw new Error(
        `TelegramPlugin: malformed cursor '${args.since as string}' for topic '${args.topic as string}'`,
      );
    }
    if (args.since !== undefined && Number(args.since) > store.highWater()) {
      throw new Error(
        `TelegramPlugin: cursor '${args.since as string}' for topic '${args.topic as string}' is ` +
          `ahead of every message this store has observed (high-water ${store.highWater()}). The ` +
          `observed-message store at '${this.storePath}' is not the one that issued it, so the ` +
          `messages it names are unreachable — restore that store file, or clear the saved cursor.`,
      );
    }
    const chatId = await this.chatIdFor(args.topic);
    this.stillServing(store);
    // Normalize BEFORE slicing: a non-positive limit must mean "no messages" on both branches
    // (`slice(-0)` is `slice(0)` — the whole history — which would invert the argument).
    const limit = Math.max(0, Math.floor(args.limit ?? 100));
    const nothingNewer = (): boolean =>
      !store.entries(chatId).some((r) => r.seq > Number(args.since));
    const query = (): Message[] => {
      const all = store.entries(chatId);
      const slice =
        args.since === undefined
          ? // Default window: the most recent `limit` messages, ascending.
            all.slice(Math.max(0, all.length - limit))
          : // Exclusive: strictly after `since`, ascending. Numeric — never lexical.
            all.filter((r) => r.seq > Number(args.since)).slice(0, limit);
      return slice.map((rec) => recordToMessage(rec, args.topic));
    };
    let messages = query();
    // Native long-poll: ONLY when NOTHING in the store sits above the exclusive `since` — the
    // unsliced predicate, never the sliced page, so that a `limit` which happens to return no rows
    // cannot park a call the store could already answer. Park up to `blockMs` for the SHARED
    // ingest path (the one getUpdates loop, or an own post) to deliver a message strictly after
    // `since`, then re-run the same pure query. There is no second getUpdates consumer —
    // {@link ingest} wakes the waiter. The predicate, the initial query and the waiter
    // registration run with NO await between them, so a message ingested during the wait can never
    // slip through the gap. Empty page + STABLE cursor (=== `since`) at timeout is correct;
    // returning early/empty is always safe, and we never block longer than `blockMs`.
    if (
      args.since !== undefined &&
      args.blockMs !== undefined &&
      args.blockMs > 0 &&
      nothingNewer()
    ) {
      await this.waitForMessage(chatId, Number(args.since), args.blockMs);
      messages = query();
    }
    const last = messages.at(-1);
    // An empty page must never move the caller backwards: hold `since` when there was one, and
    // otherwise report the topic's current tail — `limit: 0` on a topic with history would
    // otherwise hand back '0' and make the next catch-up replay the whole retained window.
    const nextCursor =
      last !== undefined ? last.cursor : (args.since ?? asCursor(String(store.maxSeq(chatId))));
    return { messages, nextCursor };
  }

  /**
   * Park until the SHARED ingest path delivers a message in `chatId` whose observation sequence
   * is strictly above `sinceSeq`, or `blockMs` elapses, or {@link disconnect} fires. No second
   * getUpdates consumer: the one shared loop and own posts both flow through {@link ingest},
   * which wakes the waiter. The waiter always self-cleans (timer cleared, removed from the set),
   * so a timed-out or resolved long-poll never leaks.
   */
  private waitForMessage(chatId: string, sinceSeq: number, blockMs: number): Promise<void> {
    const key = chatId;
    let set = this.waiters.get(key);
    if (set === undefined) {
      set = new Set<Waiter>();
      this.waiters.set(key, set);
    }
    const waiters = set;
    return new Promise<void>((resolve) => {
      let done = false;
      const wake = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(wake, blockMs);
      const waiter: Waiter = { sinceSeq, wake };
      waiters.add(waiter);
    });
  }

  /** Wake any native long-poll waiter on the chat whose `since` now trails `seq`. */
  private wakeWaiters(chatId: string, seq: number): void {
    const set = this.waiters.get(chatId);
    if (set === undefined) return;
    // Snapshot: wake() removes the waiter from the set (and may drop the key).
    for (const w of [...set]) if (seq > w.sinceSeq) w.wake();
  }

  /**
   * Live path: register on the shared `getUpdates` loop. The watermark (current max observation
   * sequence for the topic) is established SYNCHRONOUSLY before this resolves, so a post racing
   * a fresh subscribe can never be missed — the ingest path delivers anything observed after,
   * in ascending order. Starts at the tail: history is owned by catch-up, not push.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const store = this.require(this.store);
    const chatId = await this.chatIdFor(topic);
    this.stillServing(store);
    const sub: Subscription = { handler, watermark: store.maxSeq(chatId), topic };
    const list = this.subs.get(chatId);
    if (list === undefined) this.subs.set(chatId, [sub]);
    else list.push(sub);
  }

  /**
   * The bot's own username resolves to its numeric Telegram id (via memoized `getMe`); any
   * other handle passes through as a name convention — the Bot API cannot look up arbitrary
   * users by username (DESIGN §4).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    const store = this.require(this.store);
    const me = await this.getMe();
    this.stillServing(store);
    if (me.username !== undefined && (handle as string) === me.username) {
      return { handle, backendRef: String(me.id) };
    }
    return { handle, backendRef: handle };
  }

  /**
   * Topic → the canonical NUMERIC chat id it names (`chat_map` value or the topic used as a
   * chat id literal), memoized per topic. Every seam method resolves through here, so which
   * one ran first cannot affect what is stored or retrievable. Registers the chat as
   * one this bridge serves, so the store's chat cap never drops it.
   */
  private chatIdFor(topic: Topic): Promise<string> {
    const t = topic as string;
    const cached = this.chatIdByTopic.get(t);
    if (cached !== undefined) return cached;
    const generation = this.generation;
    const pending = this.canonicalChatId(this.chatMap[t] ?? t)
      .then((chatId) => {
        if (generation === this.generation) this.store?.serve(chatId);
        return chatId;
      })
      .catch((err: unknown) => {
        // Don't poison the memo on transient failure — let the next call retry.
        if (generation === this.generation) this.chatIdByTopic.delete(t);
        // Report it here: core's presence loop swallows the rejection by design, so an
        // unresolvable presence topic is otherwise a bridge that beats to nobody, in silence.
        this.report(`topic '${t}' resolves to no Telegram chat: ${describe(err)}`, {
          throttleAs: `unresolved-topic:${t}`,
        });
        throw err;
      });
    this.chatIdByTopic.set(t, pending);
    return pending;
  }

  /**
   * A chat id in canonical NUMERIC-string form. `@channelusername` values are resolved to their
   * numeric id via `getChat` (once per distinct name — memoized like {@link getMe}); a numeric id
   * is normalized NUMERICALLY with no network call. Keeps every index (and
   * `StoredRecord.chat_id`) keyed by the numeric id Telegram always stamps on inbound
   * `Update.chat.id`.
   *
   * Normalize through `BigInt`, so that a spelling which is numerically but not textually
   * canonical (`-0012345`) collapses to the one key inbound updates carry rather than becoming a
   * topic whose posts land under a key nothing will ever match — and so that a chat id past
   * `Number.MAX_SAFE_INTEGER` is not rounded on the way through.
   *
   * A reference that is neither form names no chat Telegram could ever serve (it answers 400,
   * "chat not found"), so it is rejected here rather than becoming a topic that silently stays
   * empty forever.
   */
  private canonicalChatId(chat: string): Promise<string> {
    if (/^-?\d+$/.test(chat)) return Promise.resolve(BigInt(chat).toString());
    if (!/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(chat)) {
      return Promise.reject(
        new Error(
          `TelegramPlugin: '${chat}' is not a Telegram chat id — use a numeric id or ` +
            `'@channelusername', or map the topic via backend_config.chat_map`,
        ),
      );
    }
    const cached = this.canonicalById.get(chat);
    if (cached !== undefined) return cached;
    const pending = this.call<{ result: { id: number } }>(
      'GET',
      `/getChat?chat_id=${encodeURIComponent(chat)}`,
    )
      .then((json) => String(json.result.id))
      .catch((err: unknown) => {
        // Don't poison the memo on transient failure — let the next call retry.
        this.canonicalById.delete(chat);
        throw err;
      });
    this.canonicalById.set(chat, pending);
    return pending;
  }

  /**
   * The single ingestion point for an observed message (own send or getUpdates delivery):
   * dedup on the composite id, persist to the store under a fresh observation sequence, then
   * deliver to any live subscriber.
   *
   * The store is a PARAMETER, not `this.store`: both callers have already established that the
   * generation they started on is still current, and neither awaits between that check and this
   * call, so there is no "raced disconnect" case here to drop a message in.
   *
   * The store's dedup set is the once-only guarantee — a record back from `store.append`
   * already proves this message was never observed. The per-subscriber watermark is the FIXED
   * observation sequence captured AT subscribe (deliver only what was observed after the
   * subscribe point — "history is owned by catch-up, not push"); it is NEVER advanced here.
   * Because the sequence is stamped in OBSERVATION order, a foreign message accepted before our
   * own post but delivered after it still lands above the watermark and above every cursor
   * already handed out, so it reaches both the push path and catch-up.
   */
  private ingest(store: ObservedStore, chatId: string, msg: TgMessage): void {
    const content = contentOf(msg);
    if (content === undefined) return; // an update carrying nothing an agent could read.
    const observed: ObservedRecord = {
      chat_id: chatId,
      message_id: msg.message_id,
      sender: senderOf(msg),
      content,
      ts: new Date(msg.date * 1000).toISOString(),
    };
    const rec = store.append(observed);
    if (rec === undefined) {
      if (!store.has(keyOf(observed))) {
        this.report(
          store.isOpen()
            ? `dropped a message for chat ${chatId}: the observed store holds its maximum number of chats`
            : `dropped a message for chat ${chatId}: the observed store has no append descriptor — ` +
              `its last compaction could not reopen '${this.storePath}'`,
          { throttleAs: store.isOpen() ? 'store-refused' : 'store-unwritable' },
        );
      }
      return; // already observed, or past the store's bounds (DESIGN §6).
    }
    // Native long-poll: a genuinely-new message wakes any parked fetchRecent on this
    // chat. Runs for BOTH ingest callers (the shared getUpdates loop and own posts via post()).
    this.wakeWaiters(chatId, rec.seq);
    for (const sub of this.subs.get(chatId) ?? []) {
      if (rec.seq <= sub.watermark) continue; // fixed subscribe-time value; never advanced.
      try {
        sub.handler(recordToMessage(rec, sub.topic));
      } catch {
        /* handler is best-effort; never break the loop (DESIGN §6) */
      }
    }
  }

  /**
   * The ONE shared `getUpdates` long-poll loop (see class doc: one consumer per token).
   * `offset` = last confirmed `update_id + 1` — Telegram's acknowledgement protocol. Each
   * connect starts at offset 0, replaying whatever backlog Telegram retained (~24h); the
   * store's dedup makes that replay harmless and doubles as offline catch-up. Accepts BOTH
   * `update.message` (groups/DMs) and `update.channel_post` (channels).
   */
  private async pollLoop(generation: number, store: ObservedStore): Promise<void> {
    let offset = 0;
    while (this.generation === generation) {
      let updates: TgUpdate[];
      const startedAt = Date.now();
      try {
        const json = await this.call<{ result?: TgUpdate[] }>(
          'GET',
          `/getUpdates?timeout=${this.pollTimeoutS}&offset=${offset}`,
          { budgetMs: this.pollBudgetMs(), abortOnDisconnect: true },
        );
        updates = json.result ?? [];
      } catch (err) {
        if (this.generation !== generation) break;
        const status = statusOf(err);
        // A rejected token or a wrong api_url never heals by retrying — surface it and stop,
        // so that the bridge is a loud failure instead of a silent black hole hammering the API.
        if (status !== undefined && FATAL_POLL_STATUSES.includes(status)) {
          this.report(`getUpdates failed fatally, ingestion stopped: ${describe(err)}`);
          return;
        }
        // 409 Conflict = getUpdates is unavailable for this token: either another poller holds
        // it (Telegram allows exactly one) or a webhook is registered (call deleteWebhook).
        // Telegram's own description says which — it rides along in the error text.
        const conflict = status === 409;
        this.report(`getUpdates failed, retrying: ${describe(err)}`, { throttleAs: 'poll-failure' });
        await delay(conflict ? 3000 : 500);
        continue;
      }
      if (this.generation !== generation) break;
      // Keep a floor under the IDLE loop, so that an upstream ignoring `timeout` (a proxy, a local
      // Bot API server) cannot turn the single ingestion path into a request flood against the
      // operator's bot token. A poll carrying updates is never throttled.
      if (updates.length === 0) {
        const idle = Date.now() - startedAt;
        if (idle < MIN_IDLE_POLL_MS) await delay(MIN_IDLE_POLL_MS - idle);
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const msg = u.message ?? u.channel_post;
        if (msg === undefined) continue; // an update kind we don't carry (edits, reactions, …)
        try {
          this.ingest(store, String(msg.chat.id), msg);
        } catch (err) {
          // Keep the loop alive across a failing store write (ENOSPC/EIO): losing one message is
          // recoverable, losing the only getUpdates consumer takes live push down for good.
          this.report(`dropped update ${u.update_id}: ${describe(err)}`, { throttleAs: 'ingest' });
        }
      }
    }
  }

  /**
   * Wall-clock ceiling on one `getUpdates`: the long poll plus 40% slack, at least 2s. Keep a
   * ceiling on it, so that a connection accepted and never answered (idle NAT drop, hung proxy)
   * cannot park the single ingestion loop for the lifetime of the process.
   */
  private pollBudgetMs(): number {
    return this.pollTimeoutS * 1000 + Math.max(2_000, this.pollTimeoutS * 400);
  }

  /**
   * Diagnostics go to stderr — stdout is the MCP JSON-RPC channel (see cli.ts). `throttleAs`
   * names a failure CLASS and throttles it to one line a minute; classes throttle independently,
   * so a chattering poll failure cannot silence a store write that is losing messages.
   */
  private report(message: string, opts?: { throttleAs?: string }): void {
    const kind = opts?.throttleAs;
    if (kind !== undefined) {
      const now = Date.now();
      if (now - (this.lastReportAt.get(kind) ?? 0) < 60_000) return;
      this.lastReportAt.set(kind, now);
    }
    process.stderr.write(`parley-telegram: ${message}\n`);
  }

  /** Memoized `getMe` — one network call per connect, shared by concurrent resolvers. */
  private getMe(): Promise<{ id: number; username?: string }> {
    const existing = this.me;
    if (existing !== undefined) return existing;
    const pending = this.call<{ result: { id: number; username?: string } }>('GET', '/getMe')
      .then((json) => json.result)
      .catch((err: unknown) => {
        // Don't poison the memo on transient failure — let the next call retry.
        this.me = undefined;
        throw err;
      });
    this.me = pending;
    return pending;
  }

  /**
   * Single HTTP entry point (`<api_url>/bot<token><path>`) → parsed JSON body. Transparently
   * retries on 429 honoring Telegram's `parameters.retry_after` (SECONDS); retries stop the
   * moment we disconnect. Throws on any other non-2xx as an `HttpStatusError` carrying the
   * status as a field (the poll loop reads it with `statusOf`).
   *
   * `budgetMs` is the ONE wall-clock ceiling on the call, passed to net-util as its deadline
   * rather than armed locally as well: a per-call budget the plugin computes and does not forward
   * is silently overridden by the shared 30s default, which aborts every healthy long poll past
   * `poll_timeout_s: 30`. net-util buffers the body inside that budget, so a server which accepts
   * the connection and then answers slowly, half-answers or never answers surfaces as a retryable
   * error rather than parking the caller forever.
   */
  private async call<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; budgetMs?: number; abortOnDisconnect?: boolean },
  ): Promise<T> {
    const url = `${this.apiUrl}/bot${this.token}${path}`;
    const headers: Record<string, string> = {};
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';
    const label = `Telegram ${method} ${path.split('?')[0] ?? path}`;
    const abortable = opts?.abortOnDisconnect === true;
    const controller = new AbortController();
    if (abortable) this.controllers.add(controller);
    try {
      const res = await fetchWithRetry(
        url,
        {
          method,
          headers,
          body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: abortable ? controller.signal : undefined,
        },
        {
          label,
          // Stop retrying once disconnected — don't keep hammering the API post-teardown.
          isStopped: () => this.stopped,
          retryAfterOf: readRetryAfter,
          deadlineMs: opts?.budgetMs ?? REQUEST_BUDGET_MS,
        },
      );
      return (await res.json()) as T;
    } finally {
      this.controllers.delete(controller);
    }
  }

  private require<T>(value: T | undefined): T {
    if (value === undefined) {
      throw new Error('TelegramPlugin not connected — call connect() first');
    }
    return value;
  }

  /**
   * Re-assert after every await that the instance is still serving the store this call started
   * on. Keep this, so that a seam call resuming after `disconnect()` cannot answer out of a closed
   * store: `close()` clears the per-chat index, so `fetchRecent` would report a topic tail of
   * zero and send the next catch-up back to the beginning of the retained window.
   */
  private stillServing(store: ObservedStore): void {
    if (this.store !== store) {
      throw new Error(
        'TelegramPlugin not connected — the connection this call started on was torn down',
      );
    }
  }
}

/**
 * Sender handle for an observed message: `from.username ?? String(from.id)` — usernames are
 * optional on Telegram, the numeric user id is the stable fallback. Channel posts carry no
 * `from` at all; the chat id stands in as the sender.
 */
function senderOf(msg: TgMessage): string {
  if (msg.from !== undefined) return msg.from.username ?? String(msg.from.id);
  return String(msg.chat.id);
}

/**
 * `<chat_id>:<message_id>` → the numeric message_id, but ONLY when the composite names
 * `chatId`. Telegram's `message_id` is unique per chat, so a composite from another chat
 * denotes nothing here; both halves must check out or the reply is not threaded.
 */
function parseCompositeMid(id: BackendMsgId | undefined, chatId: string): number | undefined {
  if (id === undefined) return undefined;
  const sep = (id as string).lastIndexOf(':');
  if (sep < 0) return undefined;
  if ((id as string).slice(0, sep) !== chatId) return undefined;
  const mid = Number((id as string).slice(sep + 1));
  return Number.isInteger(mid) && mid > 0 ? mid : undefined;
}

/**
 * Telegram payload kinds that carry no `text`/`caption`. An agent handed an empty turn cannot
 * tell "someone sent a photo" from "someone sent nothing", so each becomes an explicit
 * placeholder (see the README seam-mapping table).
 */
const MEDIA_KINDS = [
  'photo',
  'video',
  'animation',
  'audio',
  'voice',
  'video_note',
  'document',
  'sticker',
  'location',
  'venue',
  'contact',
  'poll',
  'dice',
  'game',
] as const;

/**
 * The message body to record: `text`, else a media `caption` (never dropped), else a
 * `[kind]` placeholder. `undefined` for an update carrying none of these (service messages
 * like joins/leaves) — those are not ingested at all rather than stored as blank lines.
 */
function contentOf(msg: TgMessage): string | undefined {
  const text = msg.text ?? msg.caption;
  if (text !== undefined) return text;
  const fields = msg as unknown as Record<string, unknown>;
  const kind = MEDIA_KINDS.find((k) => fields[k] !== undefined);
  return kind === undefined ? undefined : `[${kind}]`;
}

function recordToMessage(rec: StoredRecord, topic: Topic): Message {
  return buildMessage({
    topic,
    sender: rec.sender,
    content: rec.content,
    timestamp: rec.ts,
    id: keyOf(rec),
    cursor: String(rec.seq),
  });
}

/** Wall-clock ceiling on one non-poll call, matching net-util's own per-call deadline. */
const REQUEST_BUDGET_MS = 30_000;

/**
 * Default observed-message store: `${XDG_STATE_HOME:-~/.local/state}/parley/telegram/observed.jsonl`
 * — the directory core keeps its read-state (the saved cursors) in. Keep it ABSOLUTE, so that
 * relaunching the bridge from another working directory cannot silently start a fresh sequence
 * space underneath cursors an agent is still holding. One bridge per bot token (README), so one
 * default file; give a second deployment its own `store_path`.
 */
function defaultStorePath(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'parley', 'telegram', 'observed.jsonl');
}

/** Statuses that mean the token/URL itself is wrong — retrying can only make it worse. */
const FATAL_POLL_STATUSES = [401, 403, 404];

/** Floor on how fast {@link TelegramPlugin.pollLoop} may re-poll after an EMPTY answer. */
const MIN_IDLE_POLL_MS = 250;

/**
 * Accepted range of every numeric knob. Telegram accepts a `getUpdates` timeout up to 50s, and
 * both retention bounds size in-memory state, so each has a ceiling as well as a floor.
 */
const NUMERIC_KNOBS: Record<NumericKnob, readonly [number, number]> = {
  poll_timeout_s: [1, 50],
  observed_retention_per_chat: [1, 10_000_000],
  observed_retention_per_topic: [1, 10_000_000],
  observed_max_chats: [1, 1_000_000],
};

/** The `backend_config` keys {@link NUMERIC_KNOBS} bounds — renaming one has to break the build. */
type NumericKnob = keyof Pick<
  TelegramBackendConfig,
  'poll_timeout_s' | 'observed_retention_per_chat' | 'observed_retention_per_topic' | 'observed_max_chats'
>;

/**
 * Fail `connect` on an out-of-domain knob, naming the key. Keep this ahead of every other effect,
 * so that a value which would flood the vendor (`poll_timeout_s: 0`), kill the only ingestion path
 * (a negative one) or silently widen a retention bound the operator narrowed is a load error
 * rather than a running bridge doing the opposite of what the config asked.
 */
function requireNumericKnobs(cfg: TelegramBackendConfig): void {
  for (const key of Object.keys(NUMERIC_KNOBS) as NumericKnob[]) {
    const value = cfg[key];
    if (value === undefined) continue;
    const [min, max] = NUMERIC_KNOBS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `TelegramPlugin: backend_config.${key} must be an integer in [${min}, ${max}] — ` +
          `got ${String(value)}`,
      );
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Telegram 429s carry `parameters.retry_after` (SECONDS) in the JSON body, and also send the
 * standard `Retry-After` header. Prefer the header, then the body; `undefined` when neither
 * carries a usable hint, which lets net-util supply the default backoff.
 *
 * Return it UNCLAMPED, so that a stated flood wait is honoured in full: Telegram's flood waits are
 * routinely 30s+ and retrying sooner than the vendor asked is what escalates a rate limit into a
 * token ban. A wait that cannot fit the call's deadline ends the call there — net-util's job, not
 * this parser's.
 */
async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { parameters?: { retry_after?: number } };
    const seconds = json.parameters?.retry_after;
    if (typeof seconds === 'number' && seconds > 0) return seconds * 1000;
  } catch {
    /* no usable body hint */
  }
  return undefined;
}
