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
import { delay, fetchWithRetry } from '@sharptrick/parley-net-util';
import { keyOf, ObservedStore, type StoredRecord } from './store.js';

/** Plugin-specific backend_config (DESIGN §11). */
export interface TelegramBackendConfig {
  /** Bot token from @BotFather. A secret — lives in `backend_config`/`.env`, never in code. */
  token?: string;
  /** Bot API base URL. Default `https://api.telegram.org` (override for tests / local servers). */
  api_url?: string;
  /** Path of the observed-message JSONL store. Default `parley-telegram.jsonl` in the cwd. */
  store_path?: string;
  /** `getUpdates` long-poll timeout (SECONDS — Telegram's unit). Default 25. */
  poll_timeout_s?: number;
  /**
   * Parley topic → Telegram chat id. A topic missing from the map is used as the chat id
   * literal (numeric id string or `@channelusername`), so the map is optional sugar for
   * giving chats friendly topic names.
   */
  chat_map?: Record<string, string>;
  /**
   * Max observed records retained PER topic in the local JSONL store. On load the newest N are
   * kept and the file is compacted below the bound, so a long-lived bridge on a busy chat can't
   * grow the store/RAM without limit or degrade `connect` (BUG-32). Older records fall outside
   * Telegram's ~24-48h `getUpdates` replay horizon anyway (see README "History limitations").
   * Default 10000.
   */
  observed_retention_per_topic?: number;
}

/** The subset of a Telegram `Message` object this plugin reads. */
interface TgMessage {
  message_id: number;
  /** Unix seconds. Informational only — never used for ordering or dedup (DESIGN §5). */
  date: number;
  chat: { id: number | string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
}

/** The subset of a Telegram `Update` object this plugin reads. */
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

/** A live subscription: deliver anything whose `message_id` exceeds the watermark. */
interface Subscription {
  handler: MessageHandler;
  watermark: number;
}

/**
 * A `fetchRecent` long-poll parked on a topic (issue #20). Resolved by the SHARED ingest path
 * (the one getUpdates loop, or an own post) when a message strictly after `sinceMid` lands, or
 * on `blockMs` timeout, or on disconnect. No second getUpdates consumer is ever opened.
 */
interface Waiter {
  /** Wake only for a message whose `message_id` is strictly greater than this. */
  sinceMid: number;
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
 * unique PER CHAT) and `cursor = String(message_id)` (cursors are per-topic, a topic maps to
 * exactly one chat, and per-chat `message_id`s are monotonically increasing, so the bare
 * `message_id` is a valid topic cursor). Exclusive-`since` is a NUMERIC compare — never
 * lexical (`'10' < '9'` lexically).
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
  /** chat id → topic (reverse of chat_map) for routing inbound updates. */
  private topicByChat = new Map<string, Topic>();
  private store?: ObservedStore;
  private stopped = false;
  /** Live subscriptions per topic, fed by the shared getUpdates loop and by post(). */
  private readonly subs = new Map<string, Subscription[]>();
  /** Native long-poll waiters per topic (issue #20), resolved by ingest / timeout / disconnect. */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** In-flight getUpdates long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  /** Memoized getMe (the bot's own identity), for resolveIdentity. */
  private me?: Promise<{ id: number; username?: string }>;
  /** Memoized `@channelusername` → numeric-id-string resolutions (one getChat per distinct name). */
  private canonicalById = new Map<string, Promise<string>>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as TelegramBackendConfig;
    this.apiUrl = (cfg.api_url ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.token = cfg.token ?? '';
    this.pollTimeoutS = cfg.poll_timeout_s ?? 25;
    this.stopped = false;
    this.me = undefined;
    this.canonicalById = new Map();
    this.chatMap = cfg.chat_map ?? {};
    // BUG-08: chat ids in `@channelusername` form must be canonicalized to their NUMERIC id so
    // the reverse `topicByChat` lookup matches inbound `Update.chat.id` (Telegram always stamps
    // it as a number). Resolve every `@name` chat_map value via getChat (once, memoized) and key
    // the reverse map by String(numericId); numeric ids pass through with no network call.
    this.topicByChat = new Map();
    for (const [topic, chat] of Object.entries(this.chatMap)) {
      this.topicByChat.set(await this.canonicalChatId(chat), asTopic(topic));
    }
    // Load the observed-message store up front — fetchRecent is a pure in-memory query.
    this.store = new ObservedStore(
      cfg.store_path ?? 'parley-telegram.jsonl',
      cfg.observed_retention_per_topic,
    );
    // ONE shared ingestion loop per instance (one getUpdates consumer per token — see class doc).
    void this.pollLoop();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.subs.clear();
    // Unpark every native long-poll waiter (issue #20) so no blocked fetchRecent hangs past
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
    this.require(this.store);
    void identity; // sender is the bot account; see JSDoc above.
    await this.ensureTopicRouting(topic); // BUG-08: register the reverse route for `@name` topics.
    const body: Record<string, unknown> = { chat_id: this.chatIdOf(topic), text: content };
    // Reply threading: if inReplyTo parses as our composite `<chat>:<mid>`, thread to that mid.
    const replyMid = parseCompositeMid(opts?.inReplyTo);
    if (replyMid !== undefined) body.reply_to_message_id = replyMid;
    const res = await this.http('POST', '/sendMessage', { body });
    const json = (await res.json()) as { result: TgMessage };
    this.ingest(topic, json.result);
    return asBackendMsgId(keyOf({ chat_id: String(json.result.chat.id), message_id: json.result.message_id }));
  }

  /**
   * Durable catch-up = a pure query over the observed-message store (no network — the Bot API
   * has no history endpoint; see the class doc for what that means). Exclusive `since` via a
   * NUMERIC `message_id` compare, ascending, sliced to `limit`.
   */
  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const store = this.require(this.store);
    const limit = args.limit ?? 100;
    const query = (): Message[] => {
      const all = store.entries(args.topic);
      const slice =
        args.since === undefined
          ? // Default window: the most recent `limit` messages, ascending.
            all.slice(-limit)
          : // Exclusive: strictly after `since`, ascending. Numeric — never lexical.
            all.filter((r) => r.message_id > Number(args.since)).slice(0, limit);
      return slice.map(recordToMessage);
    };
    let messages = query();
    // Native long-poll (issue #20): ONLY when the exclusive `since` query came back empty. Park
    // up to `blockMs` for the SHARED ingest path (the one getUpdates loop, or an own post) to
    // deliver a message strictly after `since`, then re-run the same pure query. There is no
    // second getUpdates consumer — {@link ingest} wakes the waiter. The initial query and the
    // waiter registration run with NO await between them, so a message ingested during the wait
    // can never slip through the gap. Empty page + STABLE cursor (=== `since`) at timeout is
    // correct; returning early/empty is always safe, and we never block longer than `blockMs`.
    if (
      messages.length === 0 &&
      args.since !== undefined &&
      args.blockMs !== undefined &&
      args.blockMs > 0
    ) {
      await this.waitForMessage(args.topic, Number(args.since), args.blockMs);
      messages = query();
    }
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor('0'));
    return { messages, nextCursor };
  }

  /**
   * Park until the SHARED ingest path delivers a message strictly after `sinceMid` in `topic`
   * (issue #20), or `blockMs` elapses, or {@link disconnect} fires. No second getUpdates
   * consumer: the one shared loop and own posts both flow through {@link ingest}, which wakes
   * the waiter. The waiter always self-cleans (timer cleared, removed from the set), so a
   * timed-out or resolved long-poll never leaks.
   */
  private waitForMessage(topic: Topic, sinceMid: number, blockMs: number): Promise<void> {
    const key = topic as string;
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
      const waiter: Waiter = { sinceMid, wake };
      waiters.add(waiter);
    });
  }

  /** Wake any native long-poll waiter on `topic` whose `since` now trails `messageId` (issue #20). */
  private wakeWaiters(topic: Topic, messageId: number): void {
    const set = this.waiters.get(topic as string);
    if (set === undefined) return;
    // Snapshot: wake() removes the waiter from the set (and may drop the key).
    for (const w of [...set]) if (messageId > w.sinceMid) w.wake();
  }

  /**
   * Live path: register on the shared `getUpdates` loop. The watermark (current max
   * `message_id` for the topic) is established SYNCHRONOUSLY before this resolves, so a post
   * racing a fresh subscribe can never be missed — the ingest path delivers anything newer,
   * in ascending order. Starts at the tail: history is owned by catch-up, not push.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const store = this.require(this.store);
    await this.ensureTopicRouting(topic); // BUG-08: `@name` topic literals route by numeric id.
    const sub: Subscription = { handler, watermark: store.maxMessageId(topic) };
    const list = this.subs.get(topic);
    if (list === undefined) this.subs.set(topic, [sub]);
    else list.push(sub);
  }

  /**
   * The bot's own username resolves to its numeric Telegram id (via memoized `getMe`); any
   * other handle passes through as a name convention — the Bot API cannot look up arbitrary
   * users by username (DESIGN §4).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require(this.store);
    const me = await this.getMe();
    if (me.username !== undefined && (handle as string) === me.username) {
      return { handle, backendRef: String(me.id) };
    }
    return { handle, backendRef: handle };
  }

  /** Topic → chat id: mapped, or the topic string used as the chat id literal. */
  private chatIdOf(topic: Topic): string {
    return this.chatMap[topic as string] ?? (topic as string);
  }

  /** Chat id → topic: reverse-mapped, or the chat id string used as the topic literal. */
  private topicOf(chatId: string): Topic {
    return this.topicByChat.get(chatId) ?? asTopic(chatId);
  }

  /**
   * A chat id in canonical NUMERIC-string form. `@channelusername` values are resolved to their
   * numeric id via `getChat` (once per distinct name — memoized like {@link getMe}); numeric ids
   * pass straight through with NO network call. Keeps `topicByChat` (and `StoredRecord.chat_id`)
   * keyed by the numeric id Telegram always stamps on inbound `Update.chat.id` (BUG-08).
   */
  private canonicalChatId(chat: string): Promise<string> {
    if (!chat.startsWith('@')) return Promise.resolve(chat);
    const cached = this.canonicalById.get(chat);
    if (cached !== undefined) return cached;
    const pending = this.http('GET', `/getChat?chat_id=${encodeURIComponent(chat)}`)
      .then(async (res) => {
        const json = (await res.json()) as { result: { id: number } };
        return String(json.result.id);
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
   * Register the reverse route for an `@channelusername` TOPIC LITERAL (an unmapped topic whose
   * own name is `@name`) on first use — chat_map entries are canonicalized at connect instead.
   * No-op for numeric/plain topics and for mapped topics. Lets inbound `Update.chat.id` (numeric)
   * route to the `@name` topic a subscriber/poster is using (BUG-08).
   */
  private async ensureTopicRouting(topic: Topic): Promise<void> {
    const t = topic as string;
    if (!t.startsWith('@') || this.chatMap[t] !== undefined) return;
    this.topicByChat.set(await this.canonicalChatId(t), asTopic(t));
  }

  /**
   * The single ingestion point for an observed message (own send or getUpdates delivery):
   * dedup on the composite id, persist to the store, then deliver to any live subscriber.
   *
   * BUG-17: the store's dedup set is the once-only guarantee — `store.append` returning `true`
   * already proves this message was never observed, so it is delivered unconditionally. The
   * per-subscriber watermark is the FIXED value captured AT subscribe (deliver only messages
   * newer than the subscribe point — "history is owned by catch-up, not push"); it is NEVER
   * advanced here. Advancing it let an own post (higher `message_id`) move the bar past a
   * foreign message accepted just before it (lower `message_id`) that arrives moments later,
   * permanently dropping it. Losing strict ascending order in this sub-second race is strictly
   * better than permanent loss; core dedups the push on `backendMsgId`.
   */
  private ingest(topic: Topic, msg: TgMessage): void {
    const store = this.store;
    if (store === undefined) return; // raced disconnect; drop.
    const rec: StoredRecord = {
      topic: topic as string,
      chat_id: String(msg.chat.id),
      message_id: msg.message_id,
      sender: senderOf(msg),
      content: msg.text ?? '',
      ts: new Date(msg.date * 1000).toISOString(),
    };
    if (!store.append(rec)) return; // already observed — dedup holds (DESIGN §6).
    // Native long-poll (issue #20): a genuinely-new message wakes any parked fetchRecent on this
    // topic. Runs for BOTH ingest callers (the shared getUpdates loop and own posts via post()).
    this.wakeWaiters(topic, msg.message_id);
    const message = recordToMessage(rec);
    for (const sub of this.subs.get(topic as string) ?? []) {
      if (msg.message_id <= sub.watermark) continue; // fixed subscribe-time value; never advanced.
      try {
        sub.handler(message);
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
  private async pollLoop(): Promise<void> {
    let offset = 0;
    while (!this.stopped) {
      const controller = new AbortController();
      this.controllers.add(controller);
      let updates: TgUpdate[];
      try {
        const res = await this.http(
          'GET',
          `/getUpdates?timeout=${this.pollTimeoutS}&offset=${offset}`,
          { signal: controller.signal },
        );
        const json = (await res.json()) as { result?: TgUpdate[] };
        updates = json.result ?? [];
      } catch (err) {
        if (this.stopped) break;
        // 409 Conflict = another getUpdates poller holds this token (Telegram allows exactly
        // one). Keep retrying on a longer delay — the other poller may release it — but this
        // deployment should be fixed to run ONE bridge per token (README).
        const conflict = err instanceof Error && err.message.includes('→ 409');
        await delay(conflict ? 3000 : 500);
        continue;
      } finally {
        this.controllers.delete(controller);
      }
      if (this.stopped) break;
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const msg = u.message ?? u.channel_post;
        if (msg === undefined) continue; // an update kind we don't carry (edits, reactions, …)
        this.ingest(this.topicOf(String(msg.chat.id)), msg);
      }
    }
  }

  /** Memoized `getMe` — one network call per connect, shared by concurrent resolvers. */
  private getMe(): Promise<{ id: number; username?: string }> {
    const existing = this.me;
    if (existing !== undefined) return existing;
    const pending = this.http('GET', '/getMe')
      .then(async (res) => {
        const json = (await res.json()) as { result: { id: number; username?: string } };
        return json.result;
      })
      .catch((err: unknown) => {
        // Don't poison the memo on transient failure — let the next call retry.
        this.me = undefined;
        throw err;
      });
    this.me = pending;
    return pending;
  }

  /**
   * Single HTTP entry point (`<api_url>/bot<token><path>`). JSON encodes, and transparently
   * retries on 429 honoring Telegram's `parameters.retry_after` (SECONDS). Retries stop the
   * moment we disconnect. Throws on any other non-2xx with the status in the message (the
   * poll loop matches `→ 409` to detect a competing poller).
   */
  private async http(
    method: string,
    path: string,
    opts?: { body?: unknown; signal?: AbortSignal },
  ): Promise<Response> {
    const url = `${this.apiUrl}/bot${this.token}${path}`;
    const headers: Record<string, string> = {};
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts?.signal,
      },
      {
        label: `Telegram ${method} ${path}`,
        // Stop retrying once disconnected — don't keep hammering the API post-teardown.
        isStopped: () => this.stopped,
        retryAfterOf: readRetryAfter,
      },
    );
  }

  private require<T>(value: T | undefined): T {
    if (value === undefined) {
      throw new Error('TelegramPlugin not connected — call connect() first');
    }
    return value;
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

/** `<chat_id>:<message_id>` → the numeric message_id, or undefined if it doesn't parse. */
function parseCompositeMid(id: BackendMsgId | undefined): number | undefined {
  if (id === undefined) return undefined;
  const sep = (id as string).lastIndexOf(':');
  if (sep < 0) return undefined;
  const mid = Number((id as string).slice(sep + 1));
  return Number.isInteger(mid) ? mid : undefined;
}

function recordToMessage(rec: StoredRecord): Message {
  return buildMessage({
    topic: asTopic(rec.topic),
    sender: rec.sender,
    content: rec.content,
    timestamp: rec.ts,
    id: keyOf(rec),
    cursor: String(rec.message_id),
  });
}

/**
 * Telegram 429s carry `parameters.retry_after` (SECONDS) in the JSON body, and also send the
 * standard `Retry-After` header (SECONDS). Prefer the header, then the body — both `> 0`-guarded
 * so a `0`/negative value falls to the default rather than `delay(0)` — capped at 5s.
 */
async function readRetryAfter(res: Response): Promise<number> {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5000);
  try {
    const json = (await res.clone().json()) as { parameters?: { retry_after?: number } };
    const s = json.parameters?.retry_after;
    if (typeof s === 'number' && s > 0) return Math.min(s * 1000, 5000);
  } catch {
    /* fall through to default backoff */
  }
  return 500;
}
