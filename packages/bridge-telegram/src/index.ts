import {
  asBackendMsgId,
  asCursor,
  asTopic,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { delay, statusOf } from '@sharptrick/parley-net-util';
import { BotApi } from './api.js';
import { defaultStorePath, requireNumericKnobs } from './config.js';
import { recordToMessage, requireLimit, requireOwnCursor } from './cursor.js';
import { describe, Diagnostics, plaintextWarning } from './diagnostics.js';
import { keyOf, type ObservedRecord, ObservedStore } from './store.js';
import {
  canonicalChatKey,
  NUMERIC_CHAT_ID,
  parseCompositeMid,
  type TgMessage,
  type TgUpdate,
} from './wire.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface TelegramBackendConfig {
  /** Bot token from @BotFather. A secret — lives in `backend_config`/`.env`, never in code. */
  token?: string;
  /**
   * Bot API base URL. Default {@link DEFAULT_API_URL} (override for tests / local servers). A
   * plaintext `http://` base pointed at a non-loopback host is warned about on `connect`: this API
   * carries the token in the URL PATH, so every request line then puts it on the wire in the clear.
   */
  api_url?: string;
  /**
   * Path of the observed-message JSONL store. Default {@link defaultStorePath} — an ABSOLUTE
   * path under the same state directory core keeps its read-state (cursors) in, so the two share
   * a lifetime. A store file that goes missing while a saved cursor survives invalidates that
   * cursor: sequences restart at 1 and the messages below the old cursor are unreachable, which
   * `fetchRecent` reports rather than serving a short page (see {@link ObservedStore.epoch}).
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
   * `chat_map` can give one chat two topic names. The newest N are kept on load AND on every
   * append, so a long-lived bridge on a busy chat can't grow the store/RAM without limit or
   * degrade `connect`. Default 10000.
   */
  observed_retention_per_chat?: number;
  /** Deprecated spelling of {@link observed_retention_per_chat}, which wins when both are set. */
  observed_retention_per_topic?: number;
  /**
   * Max UNSERVED chats retained in the local JSONL store. Anyone who can add the bot to a
   * group can drive writes into `store_path`, so that traffic is bounded; chats a configured topic
   * or a seam call resolves to are always retained, on top of this cap, and an unserved chat past
   * it displaces the least recently active unserved one. Default 1000.
   */
  observed_max_chats?: number;
}

/** A live subscription: deliver everything ingested after it was registered. */
interface Subscription {
  handler: MessageHandler;
  /** The Parley topic this subscriber named the chat by — stamped on what it receives. */
  topic: Topic;
}

/**
 * A `fetchRecent` long-poll parked on a chat, resolved by the SHARED ingest path when a message
 * above `sinceSeq` lands, or on `blockMs` timeout, or on disconnect.
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
 * unique PER CHAT) and `cursor = '<store identity>.<seq>'`, where `seq` is the store's local
 * OBSERVATION sequence and the identity is the store FILE's ({@link ObservedStore.epoch}).
 * Telegram's own `message_id` is minted when the sender's message is accepted, not when this
 * bridge sees it, so a foreign message minted before our post can be delivered after it and would
 * sit forever below a cursor already handed out; observation order is monotonic by construction
 * and cannot.
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
  private api = new BotApi(DEFAULT_API_URL, '');
  private pollTimeoutS = 25;
  /** topic → chat id (unmapped topics fall through to the topic string itself). */
  private chatMap: Record<string, string> = {};
  private store?: ObservedStore;
  private storePath = '';
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
  /** Memoized `@channelusername` → numeric-id-string resolutions (one getChat per distinct name). */
  private canonicalById = new Map<string, Promise<string>>();
  /** Memoized topic → canonical numeric chat id (chat_map or literal, `@name` resolved). */
  private chatIdByTopic = new Map<string, Promise<string>>();
  private readonly diagnostics = new Diagnostics((text) => this.api.redact(text));

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
      const apiUrl = (cfg.api_url ?? DEFAULT_API_URL).replace(/\/+$/, '');
      const token = cfg.token ?? '';
      const api = new BotApi(apiUrl, token);
      this.api = api;
      const warning = plaintextWarning(apiUrl);
      if (warning !== undefined) this.diagnostics.report(warning);
      this.pollTimeoutS = cfg.poll_timeout_s ?? 25;
      this.canonicalById = new Map();
      this.chatIdByTopic = new Map();
      this.chatMap = cfg.chat_map ?? {};
      if (token === '') {
        throw new Error(
          'TelegramPlugin: backend_config.token is required (bot token from @BotFather)',
        );
      }
      // Preflight: an unusable token or api_url must fail `connect` rather than come up as a
      // silent black hole that polls a rejecting API forever. Also warms the resolveIdentity memo.
      await api.getMe();
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
      void this.pollLoop(generation, store, api).catch((err: unknown) => {
        this.diagnostics.report(`getUpdates loop stopped: ${describe(err)}`);
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
    this.api.stop();
    this.subs.clear();
    this.chatIdByTopic = new Map();
    // Unpark every native long-poll waiter so no blocked fetchRecent hangs past
    // teardown. Snapshot first: wake() mutates `waiters`. Each resumes, re-queries the (now
    // closed) store, and returns an empty page — returning early/empty is always safe.
    for (const set of [...this.waiters.values()]) for (const w of [...set]) w.wake();
    this.waiters.clear();
    this.store?.close();
    this.store = undefined;
    this.canonicalById = new Map();
  }

  /**
   * Single durable write path: `POST /sendMessage`, then ingest the returned message object
   * ourselves — **own posts never arrive via `getUpdates`**, so recording the response is what
   * makes them visible to `fetchRecent` and to live subscribers. `identity` is a logical label
   * only: Telegram stamps the sender as the bot account behind the token.
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
    const sent = requireMessage(
      'Telegram POST /sendMessage → result',
      await this.api.call('POST', '/sendMessage', { body }),
    );
    // Index under the chat the TOPIC resolved to, and only once the response agrees it is the chat
    // Telegram put the message in. Everything internal is keyed by that id, so a response naming a
    // different one (a redirect, a migration, an id rounded through JSON's double) would file the
    // record where the topic never looks — reachable by nothing, reported as success.
    const echoed = canonicalChatKey('Telegram POST /sendMessage → result', sent.chat.id);
    if (echoed !== chatId) {
      throw new Error(
        `TelegramPlugin: topic '${topic as string}' resolves to chat ${chatId} and Telegram put the ` +
          `message in chat ${echoed} (message_id ${sent.message_id}), so it exists there and is not ` +
          `reachable through this topic — it was not recorded in the observed-message store at ` +
          `'${this.storePath}'.`,
      );
    }
    const sentId = keyOf({ chat_id: chatId, message_id: sent.message_id });
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
    let refusal: unknown;
    try {
      this.ingest(store, chatId, sent);
    } catch (err) {
      refusal = err;
    }
    // The same outcome the teardown branch above refuses, from the other cause: Telegram has the
    // message and the store did not take it. Resolving anyway hands back a `backendMsgId` no
    // `fetchRecent` will ever return, which nothing downstream can detect.
    if (!store.has(sentId)) {
      throw new Error(
        `TelegramPlugin: Telegram accepted ${sentId} and the observed-message store at ` +
          `'${this.storePath}' did not record it, so the message exists in the chat and is ` +
          `unreachable here (own posts never arrive via getUpdates)` +
          `${refusal === undefined ? '' : `: ${describe(refusal)}`}`,
      );
    }
    return asBackendMsgId(sentId);
  }

  /**
   * Durable catch-up = a query over the observed-message store: no history endpoint is ever
   * called, because the Bot API has none. The one network cost is resolving an `@channelusername`
   * topic to its numeric id — one memoized `getChat`, already paid during `connect` for every
   * `chat_map` entry — so a topic named only by an `@name` literal can fail its FIRST catch-up if
   * Telegram is unreachable. Exclusive `since` is a NUMERIC compare, ascending, sliced to `limit`.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const store = this.require(this.store);
    const sinceSeq =
      args.since === undefined
        ? undefined
        : requireOwnCursor(store, this.storePath, args.since, args.topic);
    const limit = requireLimit(args.limit);
    const chatId = await this.chatIdFor(args.topic);
    this.stillServing(store);
    const query = (): Message[] => {
      const all = store.entries(chatId);
      const slice =
        sinceSeq === undefined
          ? // Default window: the most recent `limit` messages, ascending.
            all.slice(Math.max(0, all.length - limit))
          : // Exclusive: strictly after `since`, ascending. Numeric — never lexical.
            all.filter((r) => r.seq > sinceSeq).slice(0, limit);
      return slice.map((rec) => recordToMessage(rec, args.topic, store.epoch()));
    };
    let messages = query();
    // Native long-poll: park ONLY when NOTHING in the store sits above the exclusive `since` — the
    // unsliced predicate, never the sliced page, so that a `limit` which happens to return no rows
    // cannot park a call the store could already answer. The predicate, the initial query and the
    // waiter registration run with NO await between them, so a message {@link ingest} takes during
    // the wait can never slip through the gap.
    if (
      sinceSeq !== undefined &&
      args.blockMs !== undefined &&
      args.blockMs > 0 &&
      !store.entries(chatId).some((r) => r.seq > sinceSeq)
    ) {
      await this.waitForMessage(chatId, sinceSeq, args.blockMs);
      messages = query();
    }
    const last = messages.at(-1);
    // An empty page must never move the caller backwards: hold `since` when there was one, and
    // otherwise report the topic's current tail — `limit: 0` on a topic with history would
    // otherwise hand back the zero cursor and make the next catch-up replay the whole retained
    // window.
    const nextCursor =
      last !== undefined
        ? last.cursor
        : (args.since ?? asCursor(`${store.epoch()}.${store.maxSeq(chatId)}`));
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
    let set = this.waiters.get(chatId);
    if (set === undefined) {
      set = new Set<Waiter>();
      this.waiters.set(chatId, set);
    }
    const waiters = set;
    return new Promise<void>((resolve) => {
      let done = false;
      const wake = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.waiters.delete(chatId);
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
   * Live path: register on the shared `getUpdates` loop. Registration is synchronous once the chat
   * resolves, and {@link ingest} runs only for a record `store.append` has just stamped, so a post
   * racing a fresh subscribe can never be missed and nothing already in the store can replay here:
   * history is owned by catch-up, not push.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const store = this.require(this.store);
    const chatId = await this.chatIdFor(topic);
    this.stillServing(store);
    const sub: Subscription = { handler, topic };
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
    const me = await this.api.getMe();
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
        this.diagnostics.report(`topic '${t}' resolves to no Telegram chat: ${describe(err)}`, `unresolved-topic:${t}`);
        throw err;
      });
    this.chatIdByTopic.set(t, pending);
    return pending;
  }

  /**
   * A chat id in canonical NUMERIC-string form. `@channelusername` values are resolved to their
   * numeric id via `getChat` (once per distinct name — memoized like `getMe`); a numeric id is
   * normalized NUMERICALLY with no network call. Keeps every index (and `StoredRecord.chat_id`)
   * keyed by the numeric id Telegram always stamps on inbound `Update.chat.id`.
   *
   * Normalize through `BigInt`, so that a spelling which is numerically but not textually
   * canonical (`-0012345`) collapses to the one key inbound updates carry rather than becoming a
   * topic whose posts land under a key nothing will ever match — and so that a chat id past
   * `Number.MAX_SAFE_INTEGER` is not rounded on the way through. A reference that is neither form
   * names no chat Telegram could ever serve, so it is rejected here rather than becoming a topic
   * that silently stays empty forever.
   */
  private canonicalChatId(chat: string): Promise<string> {
    if (NUMERIC_CHAT_ID.test(chat)) return Promise.resolve(BigInt(chat).toString());
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
    const pending = this.api
      .call('GET', `/getChat?chat_id=${encodeURIComponent(chat)}`)
      .then((result) => {
        const id = (result as { id?: unknown }).id;
        if (typeof id !== 'number' && typeof id !== 'string') {
          throw new Error('Telegram GET /getChat → result: chat carries no id');
        }
        return canonicalChatKey('Telegram GET /getChat → result', id);
      })
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
   * The store's dedup set is the once-only guarantee — a record back from `store.append` already
   * proves this message was never observed, and carries a sequence above every one stamped before
   * it. That is also what keeps history off the push path: this runs for freshly appended records
   * only, never for anything a subscriber could have caught up to.
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
        this.diagnostics.report(
          store.isOpen()
            ? `dropped a message for chat ${chatId}: the observed store holds its maximum number of chats`
            : `dropped a message for chat ${chatId}: the observed store has no append descriptor — ` +
              `its last compaction could not reopen '${this.storePath}'`,
          store.isOpen() ? 'store-refused' : 'store-unwritable',
        );
      }
      return; // already observed, or past the store's bounds (DESIGN §6).
    }
    // Native long-poll: a genuinely-new message wakes any parked fetchRecent on this
    // chat. Runs for BOTH ingest callers (the shared getUpdates loop and own posts via post()).
    this.wakeWaiters(chatId, rec.seq);
    for (const sub of this.subs.get(chatId) ?? []) {
      try {
        sub.handler(recordToMessage(rec, sub.topic, store.epoch()));
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
  private async pollLoop(generation: number, store: ObservedStore, api: BotApi): Promise<void> {
    let offset = 0;
    while (this.generation === generation) {
      let updates: TgUpdate[];
      const startedAt = Date.now();
      try {
        // Budget = the long poll plus 40% slack, at least 2s. Keep a ceiling on it, so that a
        // connection accepted and never answered (idle NAT drop, hung proxy) cannot park the
        // single ingestion loop for the lifetime of the process.
        const budgetMs = this.pollTimeoutS * 1000 + Math.max(2_000, this.pollTimeoutS * 400);
        const result = await api.call(
          'GET',
          `/getUpdates?timeout=${this.pollTimeoutS}&offset=${offset}`,
          { budgetMs, abortOnDisconnect: true },
        );
        if (!Array.isArray(result)) {
          throw new Error('Telegram GET /getUpdates → result: not an array of updates');
        }
        updates = result as TgUpdate[];
      } catch (err) {
        if (this.generation !== generation) break;
        const status = statusOf(err);
        // A rejected token or a wrong api_url never heals by retrying — surface it and stop,
        // so that the bridge is a loud failure instead of a silent black hole hammering the API.
        if (status !== undefined && FATAL_POLL_STATUSES.includes(status)) {
          this.diagnostics.report(`getUpdates failed fatally, ingestion stopped: ${describe(err)}`);
          return;
        }
        // 409 Conflict = getUpdates is unavailable for this token: either another poller holds
        // it (Telegram allows exactly one) or a webhook is registered (call deleteWebhook).
        // Telegram's own description says which — it rides along in the error text.
        const conflict = status === 409;
        this.diagnostics.report(`getUpdates failed, retrying: ${describe(err)}`, 'poll-failure');
        await delay(conflict ? 3000 : 500);
        continue;
      }
      if (this.generation !== generation) break;
      const ackedBefore = offset;
      for (const u of updates) {
        // Acknowledge only an update stating an id in the domain this arithmetic is defined on.
        // `Math.max(offset, NaN)` is NaN, which is below nothing, so one id-less update from a
        // non-conforming upstream would poison the offset for the life of the loop and re-serve
        // the whole backlog forever; an id outside the safe-integer range poisons it the other
        // way, acknowledging updates that never arrived and going deaf to every later one.
        if (typeof u?.update_id === 'number' && Number.isSafeInteger(u.update_id)) {
          offset = Math.max(offset, u.update_id + 1);
        }
        const msg = u?.message ?? u?.channel_post;
        if (msg === undefined) continue; // an update kind we don't carry (edits, reactions, …)
        const label = `Telegram GET /getUpdates → update ${String(u.update_id)}`;
        try {
          const message = requireMessage(label, msg);
          this.ingest(store, canonicalChatKey(label, message.chat.id), message);
        } catch (err) {
          // Keep the loop alive across a failing store write (ENOSPC/EIO): losing one message is
          // recoverable, losing the only getUpdates consumer takes live push down for good.
          this.diagnostics.report(`dropped update ${u.update_id}: ${describe(err)}`, 'ingest');
        }
      }
      // Keep a floor under an iteration that made NO PROGRESS, so that an upstream ignoring
      // `timeout` OR ignoring `offset` (a proxy, a local Bot API server) cannot turn the single
      // ingestion path into a request flood against the operator's bot token. Keying this on the
      // acknowledgement rather than on the answer being empty, so that a batch re-served forever is
      // throttled too — every record in it dedups, so nothing else would ever make it visible.
      if (offset === ackedBefore) {
        const idle = Date.now() - startedAt;
        if (idle < MIN_IDLE_POLL_MS) await delay(MIN_IDLE_POLL_MS - idle);
      }
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

/** The optional fields {@link contentOf} takes the record's body from, in its own precedence order. */
const BODY_FIELDS = ['text', 'caption'] as const;

/**
 * Telegram payload kinds that carry no `text`/`caption`. An agent handed an empty turn cannot
 * tell "someone sent a photo" from "someone sent nothing", so each becomes an explicit
 * placeholder (see the README seam-mapping table).
 */
const MEDIA_KINDS = [
  'photo', 'video', 'animation', 'audio', 'voice', 'video_note', 'document',
  'sticker', 'location', 'venue', 'contact', 'poll', 'dice', 'game',
] as const;

/**
 * Every field {@link contentOf} and {@link senderOf} read for a VALUE, checked for its DOMAIN as
 * well as its type where the object arrives rather than where each one is dereferenced.
 *
 * Keep every one of those checks here, so that a non-conforming upstream cannot drive a record the
 * store PERSISTS and reloads: a field that survives to `store.append` is written to the JSONL file,
 * and a `content` that is not a string then throws inside `buildMessage` on every later
 * `fetchRecent` for that chat, across restarts, with no Bot API call that could ever refill the
 * topic.
 */
function requireMessage(label: string, value: unknown): TgMessage {
  const msg = value as TgMessage | null;
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new Error(`${label}: not a message object`);
  }
  if (typeof msg.message_id !== 'number' || !Number.isFinite(msg.message_id)) {
    throw new Error(`${label}: message carries no numeric message_id`);
  }
  const id = (msg.chat as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error(`${label}: message carries no chat id`);
  }
  if (typeof msg.date !== 'number' || !Number.isFinite(msg.date)) {
    throw new Error(`${label}: message carries no numeric date`);
  }
  if (Number.isNaN(new Date(msg.date * 1000).getTime())) {
    throw new Error(`${label}: message carries an out-of-range date (${String(msg.date)})`);
  }
  const fields = msg as unknown as Record<string, unknown>;
  for (const field of BODY_FIELDS) {
    if (fields[field] !== undefined && typeof fields[field] !== 'string') {
      throw new Error(`${label}: message carries a non-string ${field}`);
    }
  }
  const from = fields.from;
  if (from !== undefined) {
    if (from === null || typeof from !== 'object' || Array.isArray(from)) {
      throw new Error(`${label}: message carries a from that is not a user object`);
    }
    const user = from as Record<string, unknown>;
    if (typeof user.id !== 'number' || !Number.isFinite(user.id)) {
      throw new Error(`${label}: message carries no numeric from.id`);
    }
    if (user.username !== undefined && typeof user.username !== 'string') {
      throw new Error(`${label}: message carries a non-string from.username`);
    }
  }
  return msg;
}

/**
 * The message body to record: `text`, else a media `caption` (never dropped), else a
 * `[kind]` placeholder. `undefined` for an update carrying none of these (service messages
 * like joins/leaves) — those are not ingested at all rather than stored as blank lines.
 */
function contentOf(msg: TgMessage): string | undefined {
  const fields = msg as unknown as Record<string, unknown>;
  for (const field of BODY_FIELDS) {
    const body = fields[field];
    if (typeof body === 'string') return body;
  }
  const kind = MEDIA_KINDS.find((k) => fields[k] !== undefined);
  return kind === undefined ? undefined : `[${kind}]`;
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

/** Bot API base URL when `backend_config.api_url` is unset. Keep it https — see {@link plaintextWarning}. */
const DEFAULT_API_URL = 'https://api.telegram.org';

/** Statuses that mean the token/URL itself is wrong — retrying can only make it worse. */
const FATAL_POLL_STATUSES = [401, 403, 404];

/** Floor on how fast {@link TelegramPlugin.pollLoop} may re-poll after an answer that acked nothing. */
const MIN_IDLE_POLL_MS = 250;
