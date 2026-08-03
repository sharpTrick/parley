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
import { BotApi } from './api.js';
import { ChatResolver } from './chats.js';
import {
  DEFAULT_API_URL,
  defaultStorePath,
  requireNumericKnobs,
  type TelegramBackendConfig,
} from './config.js';
import { recordToMessage, requireLimit, requireOwnCursor } from './cursor.js';
import { describe, Diagnostics, plaintextWarning } from './diagnostics.js';
import { pollUpdates } from './poll.js';
import { keyOf, type ObservedRecord, ObservedStore } from './store.js';
import { Waiters } from './waiters.js';
import {
  canonicalChatKey,
  contentOf,
  parseCompositeMid,
  requireMessage,
  senderOf,
  type TgMessage,
} from './wire.js';

export type { TelegramBackendConfig } from './config.js';

/**
 * Telegram Bot API backend (DESIGN §6/§9) — spoken to via the raw HTTP API with the global
 * `fetch`, no SDK dependency. Telegram is a hosted SaaS, unlike the self-hosted core backends:
 * there is no server of ours to configure, only a bot token from @BotFather.
 *
 * **Fit-contract strain — the one structural caveat of this backend.** The Bot API exposes NO
 * history endpoint, so this plugin keeps a local persisted store ({@link ObservedStore}) of
 * messages it has OBSERVED, and `fetchRecent` can only replay those. That strains the "durable,
 * replayable history" line of the seam contract (DESIGN §6); within the observed window the
 * contract holds fully. See "History limitations" in README.md.
 *
 * IDs: `backendMsgId = '<chat_id>:<message_id>'` (composite — Telegram's `message_id` is only
 * unique PER CHAT) and `cursor = '<store identity>.<seq>'`, over the store's own OBSERVATION
 * sequence ({@link StoredRecord.seq}) and the store FILE's identity ({@link ObservedStore.epoch}).
 *
 * Everything internal — the observed store, live subscriptions, long-poll waiters — is keyed by
 * the CANONICAL NUMERIC CHAT ID a topic resolves to ({@link ChatResolver}), never by the topic
 * string; see {@link StoredRecord} for why.
 *
 * Ingestion is ONE shared background {@link pollUpdates} loop per plugin instance. Run exactly one
 * Telegram bridge per bot token — see README.md, "Multiple concurrent sessions".
 */
export class TelegramPlugin implements BackendPlugin {
  private api = new BotApi(DEFAULT_API_URL, '');
  private chats?: ChatResolver;
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
  /**
   * Live subscriptions per CHAT ID, fed by the shared getUpdates loop and by post(). Each carries
   * the Parley topic its subscriber named the chat by — stamped on what that subscriber receives.
   */
  private readonly subs = new Map<string, { handler: MessageHandler; topic: Topic }[]>();
  private readonly waiters = new Waiters();
  private readonly diagnostics = new Diagnostics((text) => this.api.redact(text));

  /**
   * The redaction boundary for everything this plugin rejects with. `BotApi.call` redacts what its
   * own HTTP call threw, which leaves every diagnostic composed AFTER that call — out of a field the
   * upstream chose, on an envelope that was well-formed — carrying the credential this API puts in
   * the URL path. Keep the boundary at the SEAM rather than at the call, so that a new diagnostic
   * anywhere behind one of these methods cannot put the bot token into model context or the
   * operator's logs. Rewrite the message in place rather than rethrowing, so that `HttpStatusError`
   * and the `status` the poll loop branches on survive.
   */
  private async redacting<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof Error) err.message = this.api.redact(err.message);
      throw err;
    }
  }

  async connect(config: BackendConfig): Promise<void> {
    return this.redacting(async () => this.openConnection(config));
  }

  private async openConnection(config: BackendConfig): Promise<void> {
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
      const apiUrl = (cfg.api_url ?? DEFAULT_API_URL).replace(/\/+$/, '');
      const token = cfg.token ?? '';
      const api = new BotApi(apiUrl, token);
      // Publish the client before anything can throw, so that everything this method rejects with
      // is redacted against THIS connection's token rather than the previous connection's.
      this.api = api;
      requireNumericKnobs(cfg);
      const warning = plaintextWarning(apiUrl);
      if (warning !== undefined) this.diagnostics.report(warning);
      const timeoutS = cfg.poll_timeout_s ?? 25;
      const chats = new ChatResolver(api, cfg.chat_map ?? {}, this.diagnostics, (chatId) => {
        if (generation === this.generation) this.store?.serve(chatId);
      });
      this.chats = chats;
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
      for (const topic of Object.keys(cfg.chat_map ?? {})) {
        served.push(await chats.chatIdFor(asTopic(topic)));
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
      void pollUpdates({
        api,
        timeoutS,
        diagnostics: this.diagnostics,
        isCurrent: () => this.generation === generation,
        deliver: (chatId, msg) => this.ingest(store, chatId, msg),
      }).catch((err: unknown) => {
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
    return this.redacting(async () => this.closeConnection());
  }

  private closeConnection(): void {
    this.generation++;
    this.connecting = false;
    this.api.stop();
    this.subs.clear();
    this.chats = undefined;
    this.waiters.wakeAll();
    this.store?.close();
    this.store = undefined;
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
    return this.redacting(async () => this.send(topic, content, opts?.inReplyTo));
  }

  private async send(
    topic: Topic,
    content: string,
    inReplyTo: BackendMsgId | undefined,
  ): Promise<BackendMsgId> {
    const store = this.require(this.store);
    const chatId = await this.require(this.chats).chatIdFor(topic);
    this.stillServing(store);
    const body: Record<string, unknown> = { chat_id: chatId, text: content };
    // Reply threading: only for a composite `<chat>:<mid>` naming THIS chat — a message id from
    // another chat is meaningless here (Telegram's message_id is per-chat) and would either 400
    // or thread onto an unrelated message that happens to share the number.
    const replyMid = parseCompositeMid(inReplyTo, chatId);
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
   * called, because the Bot API has none. Exclusive `since` is a NUMERIC compare, ascending,
   * sliced to `limit`.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    return this.redacting(async () => this.query(args));
  }

  private async query(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const store = this.require(this.store);
    const sinceSeq =
      args.since === undefined
        ? undefined
        : requireOwnCursor(store, this.storePath, args.since, args.topic);
    const limit = requireLimit(args.limit);
    const chatId = await this.require(this.chats).chatIdFor(args.topic);
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
      await this.waiters.park(chatId, sinceSeq, args.blockMs);
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
   * Live path: register on the shared `getUpdates` loop. Registration is synchronous once the chat
   * resolves, and {@link ingest} runs only for a freshly stamped record, so a post racing a fresh
   * subscribe can never be missed and nothing already in the store can replay here.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    return this.redacting(async () => this.register(topic, handler));
  }

  private async register(topic: Topic, handler: MessageHandler): Promise<void> {
    const store = this.require(this.store);
    const chatId = await this.require(this.chats).chatIdFor(topic);
    this.stillServing(store);
    const sub = { handler, topic };
    const list = this.subs.get(chatId);
    if (list === undefined) this.subs.set(chatId, [sub]);
    else list.push(sub);
  }

  /** Any handle but the bot's own passes through: the Bot API cannot look up users (DESIGN §4). */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return this.redacting(async () => this.identify(handle));
  }

  private async identify(handle: Handle): Promise<BackendIdentity> {
    const store = this.require(this.store);
    const me = await this.api.getMe();
    this.stillServing(store);
    if (me.username !== undefined && (handle as string) === me.username) {
      return { handle, backendRef: String(me.id) };
    }
    return { handle, backendRef: handle };
  }

  /**
   * The single ingestion point for an observed message — own send or getUpdates delivery.
   *
   * The store is a PARAMETER, not `this.store`: both callers have already established that the
   * generation they started on is still current, and neither awaits between that check and this
   * call, so there is no "raced disconnect" case here to drop a message in.
   *
   * The store's dedup set is the once-only guarantee — a record back from `store.append` already
   * proves this message was never observed, and carries a sequence above every one stamped before
   * it. That is also what keeps history off the push path: this runs for freshly appended records
   * only, never for anything a subscriber could have caught up to.
   *
   * Returns whether the message was taken durably or refused for a reason that can never clear.
   * False means only that the store has no descriptor to write through, which its next compaction
   * may restore — the caller that can have the message served again must not acknowledge it.
   */
  private ingest(store: ObservedStore, chatId: string, msg: TgMessage): boolean {
    const content = contentOf(msg);
    if (content === undefined) return true; // an update carrying nothing an agent could read.
    const observed: ObservedRecord = {
      chat_id: chatId,
      message_id: msg.message_id,
      sender: senderOf(msg),
      content,
      ts: new Date(msg.date * 1000).toISOString(),
    };
    const rec = store.append(observed);
    if (rec === undefined) {
      if (store.has(keyOf(observed))) return true; // already observed (DESIGN §6) — durable.
      this.diagnostics.report(
        store.isOpen()
          ? `dropped a message for chat ${chatId}: the observed store holds its maximum number of chats`
          : `dropped a message for chat ${chatId}: the observed store has no append descriptor — ` +
            `its last compaction could not reopen '${this.storePath}'`,
        store.isOpen() ? 'store-refused' : 'store-unwritable',
      );
      // The chat cap will not clear on its own; a lost append descriptor a later compaction may.
      return store.isOpen();
    }
    // Native long-poll: a genuinely-new message wakes any parked fetchRecent on this
    // chat. Runs for BOTH ingest callers (the shared getUpdates loop and own posts via post()).
    this.waiters.wake(chatId, rec.seq);
    for (const sub of this.subs.get(chatId) ?? []) {
      try {
        sub.handler(recordToMessage(rec, sub.topic, store.epoch()));
      } catch {
        /* handler is best-effort; never break the loop (DESIGN §6) */
      }
    }
    return true;
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
