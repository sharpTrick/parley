import type { Topic } from '@sharptrick/parley-core';
import type { BotApi } from './api.js';
import { describe, type Diagnostics } from './diagnostics.js';
import { canonicalChatKey, NUMERIC_CHAT_ID } from './wire.js';

/**
 * Topic → the canonical NUMERIC chat id it names, memoized per topic and, for an
 * `@channelusername`, per distinct name. Every seam method resolves through here, so which one ran
 * first cannot affect what is stored or retrievable.
 *
 * A resolver belongs to ONE connection: `connect` builds it and `disconnect` drops it, so a
 * resolution still in flight across a teardown settles into a map nobody reads rather than seeding
 * the next connection's memo. Neither memo keeps a rejection — a transient failure must retry.
 */
export class ChatResolver {
  private readonly byTopic = new Map<string, Promise<string>>();
  private readonly byName = new Map<string, Promise<string>>();

  constructor(
    private readonly api: BotApi,
    private readonly chatMap: Record<string, string>,
    private readonly diagnostics: Diagnostics,
    /** Register the chat as one this bridge serves, so the store's chat cap never drops it. */
    private readonly serve: (chatId: string) => void,
  ) {}

  chatIdFor(topic: Topic): Promise<string> {
    const t = topic as string;
    const cached = this.byTopic.get(t);
    if (cached !== undefined) return cached;
    const pending = this.canonicalChatId(this.chatMap[t] ?? t)
      .then((chatId) => {
        this.serve(chatId);
        return chatId;
      })
      .catch((err: unknown) => {
        this.byTopic.delete(t);
        // Report it here: core's presence loop swallows the rejection by design, so an
        // unresolvable presence topic is otherwise a bridge that beats to nobody, in silence.
        this.diagnostics.report(
          `topic '${t}' resolves to no Telegram chat: ${describe(err)}`,
          `unresolved-topic:${t}`,
        );
        throw err;
      });
    this.byTopic.set(t, pending);
    return pending;
  }

  /**
   * A chat id in canonical NUMERIC-string form: `@channelusername` costs a `getChat`, a numeric id
   * costs nothing. Normalize through `BigInt`, so that a spelling which is numerically but not textually
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
    const cached = this.byName.get(chat);
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
        this.byName.delete(chat);
        throw err;
      });
    this.byName.set(chat, pending);
    return pending;
  }
}
