import {
  asBackendMsgId,
  asCursor,
  assertBlockMsUnsupported,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  NoSuchTopicError,
  type Topic,
} from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS, sanitizeBody } from '@sharptrick/parley-net-util';
import { newestWindow, windowSince, type PageFn } from './catchup.js';
import { reasonOf, warn } from './diagnostics.js';
import { TerminalGatewayCloseError } from './ladder.js';
import { DiscordSession } from './session.js';
import {
  botAccount,
  CONTENT_LIMIT,
  countCharacters,
  errorCode,
  hasUsableId,
  MISSING_ACCESS,
  pageRecords,
  toMessage,
  UNKNOWN_CHANNEL,
  unpushableChannelReason,
} from './wire.js';

export { DEFAULT_HANDSHAKE_TIMEOUT_MS } from './gateway.js';
export { REQUIRED_INTENTS } from './intents.js';
export { BACKOFF_BASE_MS, BACKOFF_JITTER_MS, dialBudgetFor, IDENTIFY_QUOTA_PER_DAY,
  IDENTIFY_QUOTA_WINDOW_MS, INVALID_SESSION_MIN_WAIT_MS, INVALID_SESSION_SPREAD_MS,
  RECONNECT_CAP_MS, STABLE_CONNECTION_MS } from './ladder.js';
export type { AllowedMentions, DiscordBackendConfig } from './config.js';
export type { DialBudget } from './ladder.js';

/** One exclusive-`since` catch-up: where it resumes, how much it wants, and the budget it shares. */
interface Catchup {
  topic: Topic;
  since: Cursor;
  limit: number;
  deadline: number;
  generation: number;
}

/**
 * Discord backend (DESIGN §6/§9); the README carries the seam mapping and the hosted-SaaS
 * positioning. One topic = one channel, and the message snowflake is BOTH `backendMsgId` and
 * `cursor`. Snowflakes are DECIMAL strings and NOT lexically comparable, so keep every "strictly
 * after" resolved server-side by the exclusive `?after=`, so that no local ordering can compare
 * them as text; a comparison this plugin genuinely needed would have to go through `BigInt`.
 */
export class DiscordPlugin extends DiscordSession implements BackendPlugin {
  /**
   * `POST /channels/<id>/messages`. The seam's `identity` is deliberately unused: Discord stamps
   * `author` from the configured bot token, so per-session attribution needs a per-session token.
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    this.require();
    const characters = countCharacters(content);
    if (characters > CONTENT_LIMIT) {
      throw new Error(
        `Discord caps a message at ${CONTENT_LIMIT} characters; this post is ${characters}. ` +
          'Split it across posts (chunking here would break the one-post/one-backendMsgId contract).',
      );
    }
    const body = {
      content,
      allowed_mentions: this.allowedMentions,
      message_reference: opts?.inReplyTo !== undefined ? { message_id: opts.inReplyTo } : undefined,
    };
    const path = `/channels/${encodeURIComponent(this.channelId(topic))}/messages`;
    const res = await this.rest.request('POST', path, { body });
    const json: unknown = await res.json();
    if (!hasUsableId(json)) {
      throw new Error(
        'Discord POST /channels/<id>/messages answered 200 with no usable message id; the post ' +
          'may or may not have landed, and there is no backendMsgId to dedup or reply to',
      );
    }
    return asBackendMsgId(json.id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    assertBlockMsUnsupported('parley-discord', args.blockMs);
    this.require();
    const generation = this.generation;
    // The seam declares `limit?: number` with no floor, and `fetchRecent` is public API — only the
    // MCP tool path upstream refuses a hostile one. Keep the floor HERE, so that a page walk
    // bounded by `walked.length < limit` cannot be handed a value no length satisfies: `NaN`, `0`
    // and negatives all end that loop before its first read and answer an empty page on a topic
    // that has history, which a caller cannot tell from "nothing new".
    const asked = Math.trunc(args.limit ?? 100);
    const limit = Number.isNaN(asked) ? 1 : Math.max(1, asked);
    const deadline = Date.now() + DEFAULT_DEADLINE_MS;

    if (args.since === undefined) {
      const records = await newestWindow(this.pager(args.topic, generation), limit, deadline);
      const messages = records.map((m) => toMessage(args.topic, m));
      return { messages, nextCursor: messages.at(-1)?.cursor ?? asCursor('0') };
    }

    return this.fetchSince({ topic: args.topic, since: args.since, limit, deadline, generation });
  }

  /** Empty → `nextCursor` echoes `since` (stable, replayable). */
  private async fetchSince(walk: Catchup): Promise<FetchRecentResult> {
    const { topic, since, limit, deadline, generation } = walk;
    const pages = this.pager(topic, generation);
    const records = await windowSince(pages, String(since), limit, deadline);
    const messages = records.map((m) => toMessage(topic, m));
    return { messages, nextCursor: messages.at(-1)?.cursor ?? since };
  }

  /**
   * One `GET /channels/<id>/messages` page (newest-first) for `topic`. Keep ONLY `10003 Unknown
   * Channel` mapped to the seam's absent topic, so that a 404 that is not it, and `50001 Missing
   * Access` — the channel exists and this bot is misconfigured — stay real failures instead of
   * reading to core as "topic not present yet". Keep every page behind the `generation` its seam
   * call captured, so that a walk parked between pages across a re-`connect()`
   * resolves `topic` against the map the caller asked under and never carries the successor
   * session's messages, or its cursor, back under that name.
   */
  private pager(topic: Topic, generation: number): PageFn {
    return async (query, budgetMs) => {
      if (generation !== this.generation) return [];
      const path = `/channels/${encodeURIComponent(this.channelId(topic))}/messages?${query}`;
      const res = await this.rest.request('GET', path, {
        allowStatuses: [404],
        deadlineMs: budgetMs,
      });
      if (res.status === 404) {
        const raw = await res.text().catch(() => '');
        if (errorCode(raw) === UNKNOWN_CHANNEL) throw new NoSuchTopicError(topic as string);
        throw new Error(`Discord GET ${path} → 404: ${sanitizeBody(raw)}`);
      }
      return pageRecords(path, await res.json());
    };
  }

  /**
   * Live path = the ONE shared gateway socket, opened lazily here, then a single REST check of the
   * channel. The README's `subscribe` row is the contract; the risk it exists for is that this
   * method decides the fate of the WHOLE bridge. Keep a transient dial failure and an unpushable
   * channel non-fatal, so that ONE topic's outage or misconfiguration cannot fail core's attach and
   * take catch-up and `post` for every other topic with it. A TERMINAL close and an id Discord does
   * not know still reject: the first needs a human, the second is the one topic core skips.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    this.require();
    const named = JSON.stringify(topic as string);
    const channelId = this.channelId(topic);
    this.subs.set(channelId, { topic, handler });
    try {
      await this.gateway.ensureUp();
    } catch (err) {
      if (err instanceof TerminalGatewayCloseError) {
        this.subs.delete(channelId);
        throw err;
      }
      const ladder = this.gateway.reconnectPending
        ? 'the reconnect ladder is retrying'
        : 'no reconnect is scheduled';
      warn(`live push for topic ${named} is not up yet (${reasonOf(err)}); ${ladder}`);
    }

    let unpushable: string | undefined;
    try {
      unpushable = await this.unpushableReason(topic, channelId);
    } catch (err) {
      if (err instanceof NoSuchTopicError) {
        this.subs.delete(channelId);
        throw err;
      }
      warn(
        `could not verify that topic ${named} can carry live push ` +
          `(${reasonOf(err)}); leaving the subscription wired`,
      );
      return;
    }
    if (unpushable !== undefined) {
      this.subs.delete(channelId);
      warn(
        `topic ${named} maps to channel ${channelId}, which ${unpushable}` +
          ' — this topic gets no live push; map it to a guild text channel instead',
      );
    }
  }

  /**
   * `GET /channels/<id>`, once per subscribed channel: why it can never carry a `MESSAGE_CREATE`,
   * or undefined when it can. Keep a transport or server failure THROWING rather than answering a
   * reason, so that the caller reads it as unverified and leaves the subscription wired.
   */
  private async unpushableReason(topic: Topic, channelId: string): Promise<string | undefined> {
    const path = `/channels/${encodeURIComponent(channelId)}`;
    const res = await this.rest.request('GET', path, { allowStatuses: [403, 404] });
    if (res.status === 403 || res.status === 404) {
      const raw = await res.text().catch(() => '');
      const code = errorCode(raw);
      if (code === UNKNOWN_CHANNEL) throw new NoSuchTopicError(topic as string);
      if (code === MISSING_ACCESS) {
        return 'this bot cannot access (50001 Missing Access) — invite the bot and grant View ' +
          'Channels / Read Message History';
      }
      throw new Error(`Discord GET ${path} → ${res.status}: ${sanitizeBody(raw)}`);
    }
    const body = (await res.json()) as { type?: unknown } | null;
    return unpushableChannelReason(body?.type);
  }

  /**
   * Discord has NO global name → id lookup (search is per-guild and privileged), so only our own
   * bot account resolves to a real id; every other handle passes through as a string convention
   * (DESIGN §4).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    this.require();
    this.me ??= this.rest
      .request('GET', '/users/@me')
      .then(async (res) => botAccount(await res.json()))
      .catch((err: unknown) => {
        this.me = undefined; // don't cache a transient failure
        throw err;
      });
    const me = await this.me;
    if ((handle as string) === me.username) return { handle, backendRef: me.id };
    return { handle, backendRef: handle };
  }
}
